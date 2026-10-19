#!/usr/bin/env bash
# memui — tiny TUI to control the memory web UI server from any terminal.
#
#   memui                                   interactive menu
#   memui start|stop|restart|status|open|logs|home
#
# Install globally by symlinking it onto your PATH:
#   ln -s "$PWD/scripts/memui.sh" ~/.local/bin/memui
#
# The store is resolved from MEMORY_HOME, else from this script's (symlink-
# resolved) location. MEMUI_PORT overrides the port (default 4664).

set -uo pipefail

# Resolve the real script path through symlinks (no `readlink -f` on old macOS).
resolve_self() {
  local src="${BASH_SOURCE[0]}" dir
  while [ -L "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")/.." && pwd
}

MEM_DIR="${MEMORY_HOME:-$(resolve_self)}"
PORT="${MEMUI_PORT:-4664}"
URL="http://127.0.0.1:$PORT"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/memui"
LOG_FILE="$STATE_DIR/server-$PORT.log"

if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; D=$'\e[2m'; N=$'\e[0m'
else
  B=''; G=''; R=''; Y=''; D=''; N=''
fi

# PID listening on the port, empty if none.
port_pid() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

# True when the listener on the port is a memory UI server (not some other app).
is_memory_server() {
  local pid="$1"
  ps -o command= -p "$pid" 2>/dev/null | grep -q "cli.ts ui"
}

status() {
  local pid; pid="$(port_pid)"
  if [ -z "$pid" ]; then
    echo "${R}○ stopped${N}"
  elif is_memory_server "$pid"; then
    echo "${G}● running${N}  pid $pid  $URL"
  else
    echo "${Y}! port $PORT is used by another process (pid $pid)${N}"
  fi
}

start() {
  local pid; pid="$(port_pid)"
  if [ -n "$pid" ]; then
    if is_memory_server "$pid"; then echo "${Y}Already running.${N}"; return 0; fi
    echo "${R}Port $PORT is taken by pid $pid — set MEMUI_PORT.${N}"; return 1
  fi
  if [ ! -f "$MEM_DIR/src/cli.ts" ]; then
    echo "${R}No memory store at $MEM_DIR — set MEMORY_HOME.${N}"; return 1
  fi
  mkdir -p "$STATE_DIR"
  (
    cd "$MEM_DIR" || exit 1
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
      # shellcheck disable=SC1091
      source "$HOME/.nvm/nvm.sh" && nvm use 20 >/dev/null
    fi
    nohup npx tsx src/cli.ts ui --port "$PORT" --no-open >"$LOG_FILE" 2>&1 &
  )
  printf "Starting"
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "$URL"; then echo; echo "${G}Started${N} → $URL"; return 0; fi
    printf "."; sleep 0.5
  done
  echo; echo "${R}Didn't come up in 20s — see $LOG_FILE${N}"; return 1
}

stop() {
  local pid; pid="$(port_pid)"
  if [ -z "$pid" ]; then echo "${Y}Not running.${N}"; return 0; fi
  if ! is_memory_server "$pid"; then
    echo "${R}Port $PORT is held by a non-memory process (pid $pid); not killing it.${N}"; return 1
  fi
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 10); do [ -z "$(port_pid)" ] && break; sleep 0.3; done
  pid="$(port_pid)"
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  echo "${G}Stopped.${N}"
}

open_ui() {
  start || return 1
  if command -v open >/dev/null; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1; fi
}

logs() {
  [ -f "$LOG_FILE" ] || { echo "${Y}No log yet ($LOG_FILE).${N}"; return 0; }
  echo "${D}$LOG_FILE (Ctrl+C to exit)${N}"
  tail -n 40 -f "$LOG_FILE"
}

menu() {
  local key
  while true; do
    clear
    echo "${B}Personal Memory server${N}  ${D}$MEM_DIR${N}"
    echo
    echo "   $(status)"
    echo
    echo "  ${B}s${N}) start     ${B}x${N}) stop     ${B}r${N}) restart"
    echo "  ${B}o${N}) open      ${B}l${N}) logs     ${B}q${N}) quit"
    echo
    read -rsn1 -p "  > " key || exit 0; echo
    case "$key" in
      s) start ;;
      x) stop ;;
      r) stop && start ;;
      o) open_ui ;;
      # Catch Ctrl+C in the menu so it only ends `tail`, not memui itself.
      l) trap 'true' INT; logs; trap - INT ;;
      q|$'\e') clear; exit 0 ;;
      *) continue ;;
    esac
    read -rsn1 -p "${D}  press any key…${N}" _ || exit 0
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status ;;
  open) open_ui ;;
  logs) logs ;;
  home) echo "$MEM_DIR" ;;
  "") [ -t 0 ] && menu || { echo "usage: memui [start|stop|restart|status|open|logs|home]"; exit 1; } ;;
  -h|--help) echo "usage: memui [start|stop|restart|status|open|logs|home]" ;;
  *) echo "usage: memui [start|stop|restart|status|open|logs|home]" >&2; exit 1 ;;
esac
