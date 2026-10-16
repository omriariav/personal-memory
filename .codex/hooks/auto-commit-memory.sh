#!/usr/bin/env bash
# Codex PostToolUse hook: auto-commit nested memory repo after memory CLI add.
#
# Mirrors the existing Claude Code behavior without changing any existing files.

set -euo pipefail

# Resolved before the cd below, while the invocation cwd still applies.
title_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/entry-title.cjs"

input="$(cat)"

command="$(node -e '
const data = JSON.parse(process.argv[1] || "{}");
const candidates = [
  data.tool_input && data.tool_input.command,
  data.tool_input && data.tool_input.cmd,
  data.command,
  data.cmd,
];
for (const value of candidates) {
  if (typeof value === "string") {
    process.stdout.write(value);
    process.exit(0);
  }
}
' "$input")"

case "$command" in
  *cli.ts\ add*) ;;
  *) exit 0 ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 0

# Every store is checked (not parsed from --graph: a source-id match or a
# distribution rule can direct the write anywhere); each commits into its own
# repo. The unmatched-glob literal is absorbed by the .git guard below.
for store in memory memory-public memory-graphs/*/; do
  store="${store%/}"
  [ -d "$store/.git" ] || continue

  git -C "$store" add -A . 2>/dev/null || continue

  if git -C "$store" diff --cached --quiet 2>/dev/null; then
    continue
  fi

  # Parsed with gray-matter rather than read off the `title:` line: long titles
  # are folded YAML block scalars whose key line is just `>-`.
  # See scripts/entry-title.cjs.
  newest="$(git -C "$store" diff --cached --name-only 2>/dev/null | grep -E '^entries/.*\.md$' | head -n1 || true)"
  title=""
  if [ -n "$newest" ] && [ -f "$store/$newest" ]; then
    title="$(node "$title_script" "$store/$newest" 2>/dev/null || true)"
  fi

  git -C "$store" commit -q \
    -m "Log memory: ${title:-entry update}" \
    -m "Auto-committed by Codex PostToolUse hook after \`cli.ts add\`." \
    >/dev/null 2>&1 || true
done
