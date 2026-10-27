#!/usr/bin/env bash
# PreToolUse guard for Write/Edit/NotebookEdit/Bash in the personal-memory repo.
#
# Memory entries MUST be created/updated through `npx tsx src/cli.ts add` —
# never hand-written. A manual file under memory/entries/ skips index sync,
# source-id dedup, the near-dup guard, and the auto-commit hook, leaving an
# entry invisible to recall and unversioned. Same for .index/ (rebuildable
# derivative, never hand-edited). Full contract: MEMORY-GUARDRAILS.md.
#
# Allowed and untouched by this guard: every store's summaries/ (Synthesis
# prose after `digest`), memory/connectors/ + memory/routing/ + memory/graphs/
# (private config overrides) — EXCEPT memory/graphs/queue.json, the review
# queue, whose rows carry content hashes that must match the store. Every store's entries/ is protected: memory/
# (private graph) and memory-graphs/<name>/ (each named shared graph), as is
# memory/eval/ (the golden set — written only by `cli.ts eval …`, which
# validates ids and checkpoints the nested repo).

input="$(cat)"

# Do not depend on `jq`: in a sandboxed/mounted environment (cowork VM, container)
# the image may not ship it, and a non-zero exit here is a NON-BLOCKING error —
# the guard would silently allow every write. Fall back to awk, then to raw input.
field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$1 // \"\"" 2>/dev/null
    return
  fi
  key="$(printf '%s' "$1" | sed 's/.*\.//; s/[^A-Za-z_].*//')"
  printf '%s' "$input" | awk -v key="$key" '
    { s = $0
      k = "\"" key "\":"
      i = index(s, k); if (i == 0) exit
      s = substr(s, i + length(k))
      sub(/^[ \t]*/, "", s)
      if (substr(s, 1, 1) != "\"") exit
      s = substr(s, 2)
      out = ""; esc = 0
      for (j = 1; j <= length(s); j++) {
        c = substr(s, j, 1)
        if (esc) { out = out c; esc = 0; continue }
        if (c == "\\") { out = out c; esc = 1; continue }
        if (c == "\"") break
        out = out c
      }
      print out; exit
    }' 2>/dev/null
}

tool="$(field .tool_name)"

deny() {
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Never write memory entries or .index/ by hand — a manual file skips index sync, dedup, the near-dup guard, and auto-commit (see MEMORY-GUARDRAILS.md). This covers memory/ and EVERY memory-graphs/<name>/ store. Capture/update via the CLI instead:\n  npx tsx src/cli.ts add --title … --type … [--people …] [--source-ids …] --body \"…\"\n  (same --source-ids updates in place; manual notes: add --update <id>; membership: copy|move <id> --to <graph>)\nEach store's summaries/ Synthesis, plus memory/connectors/, memory/routing/, and memory/graphs/ stay editable."}}
JSON
  exit 0
}

deny_queue() {
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Never hand-edit the review queue — its rows carry content hashes that must match the store, and a hand-written row is either ignored or acted on against the wrong text. Use the CLI:\n  npx tsx src/cli.ts queue add <id> --to <graph> --reason \"…\" [--summary-file <path>]\n  npx tsx src/cli.ts queue approve|dismiss <id> --graph <graph>\n  npx tsx src/cli.ts queue list [--graph <graph>] [--json]"}}
JSON
  exit 0
}

case "$tool" in
  Write|Edit|NotebookEdit)
    file_path="$(field .tool_input.file_path)"
    [ -n "$file_path" ] || file_path="$(field .tool_input.notebook_path)"
    # Extraction failed outright → match the raw payload rather than allowing.
    [ -n "$file_path" ] || file_path="$input"
    case "$file_path" in
      *memory/entries/*|*memory-public/entries/*|*memory-graphs/*/entries/*|*.index/*|*memory/eval/*) deny ;;
      *memory/graphs/queue.json*) deny_queue ;;
    esac
    ;;
  Bash)
    cmd="$(field .tool_input.command)"
    [ -n "$cmd" ] || cmd="$input"
    # Only deny commands that reference the protected paths AND look like a
    # write (redirect/copy/move/delete/in-place edit). Plain reads pass, and
    # `cli.ts add` never mentions memory/entries at all.
    case "$cmd" in
      *memory/entries*|*memory-public/entries*|*memory-graphs/*/entries*|*.index/*|*memory/eval/*)
        case "$cmd" in
          *'>'*|*'tee '*|*'cp '*|*'mv '*|*'rm '*|*'sed -i'*|*'touch '*|*'truncate '*|*'dd '*) deny ;;
        esac
        ;;
    esac
    case "$cmd" in
      *memory/graphs/queue.json*)
        case "$cmd" in
          *'>'*|*'tee '*|*'cp '*|*'mv '*|*'rm '*|*'sed -i'*|*'touch '*|*'truncate '*|*'dd '*) deny_queue ;;
        esac
        ;;
    esac
    ;;
esac

# Anything else passes: emit nothing, exit 0.
exit 0
