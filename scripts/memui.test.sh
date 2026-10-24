#!/usr/bin/env bash
# Tests for scripts/memui.sh that don't start a real server: CLI dispatch,
# store resolution through a symlink, and the guard that refuses to stop a
# non-memory process holding the port.

set -uo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
memui="$repo_root/scripts/memui.sh"
tmp="$(mktemp -d)"
trap '[ -n "${foreign_pid:-}" ] && { kill "$foreign_pid"; wait "$foreign_pid"; } 2>/dev/null; rm -rf "$tmp"' EXIT

failures=0
checks=0

# expect_out <label> <pattern> <cmd...> — asserts combined output matches pattern
expect_out() {
  local label="$1" pattern="$2"; shift 2
  local out
  checks=$((checks + 1))
  out="$("$@" 2>&1 </dev/null)"
  if ! printf '%s' "$out" | grep -qE "$pattern"; then
    failures=$((failures + 1))
    echo "FAIL: $label"
    echo "  want /$pattern/, got: $out"
  fi
}

# expect_status <label> <code> <cmd...>
expect_status() {
  local label="$1" want="$2"; shift 2
  checks=$((checks + 1))
  "$@" >/dev/null 2>&1 </dev/null
  local got=$?
  if [ "$got" -ne "$want" ]; then
    failures=$((failures + 1))
    echo "FAIL: $label (exit $got, want $want)"
  fi
}

free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

port="$(free_port)"
export MEMUI_PORT="$port" XDG_CACHE_HOME="$tmp/cache"

expect_status "unknown command exits 1" 1 bash "$memui" bogus
expect_out "help prints usage" "usage: memui" bash "$memui" --help
expect_out "no-tty without args prints usage" "usage: memui" bash "$memui"
expect_out "status on a free port is stopped" "stopped" bash "$memui" status
expect_out "stop on a free port is a no-op" "Not running" bash "$memui" stop
expect_out "logs before any start" "No log yet" bash "$memui" logs

# A store without src/cli.ts must be rejected, not started.
mkdir -p "$tmp/empty-store"
expect_out "start rejects a missing store" "No memory store" env MEMORY_HOME="$tmp/empty-store" bash "$memui" start

# Symlinked onto PATH (relative link, two hops), the store still resolves to the repo.
mkdir -p "$tmp/bin"
ln -s "$memui" "$tmp/memui-abs"
(cd "$tmp/bin" && ln -s ../memui-abs memui)
expect_out "symlinked script resolves the repo" "^$repo_root\$" env -u MEMORY_HOME bash "$tmp/bin/memui" home
expect_out "MEMORY_HOME overrides the store" "^$tmp/empty-store\$" env MEMORY_HOME="$tmp/empty-store" bash "$memui" home

# A foreign listener on the port must be reported and never killed.
node -e 'require("net").createServer().listen(+process.argv[1],"127.0.0.1")' "$port" &
foreign_pid=$!
for _ in $(seq 1 20); do lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.1; done
expect_out "status flags a foreign listener" "used by another process" bash "$memui" status
expect_status "stop refuses a foreign listener" 1 bash "$memui" stop
expect_status "start refuses a taken port" 1 bash "$memui" start
checks=$((checks + 1))
if ! kill -0 "$foreign_pid" 2>/dev/null; then
  failures=$((failures + 1))
  echo "FAIL: foreign listener was killed"
fi

echo "memui: $((checks - failures))/$checks passed"
[ "$failures" -eq 0 ]
