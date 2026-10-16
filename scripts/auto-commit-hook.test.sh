#!/usr/bin/env bash
# Tests for the commit-subject derivation used by the PostToolUse auto-commit
# hooks in .claude/hooks/ and .codex/hooks/.
#
# Entry titles are written by `matter.stringify`, which folds anything long into
# a YAML block scalar — `title: >-` with the text on the following lines. The
# hooks used to read the `title:` line directly, so every folded title became
# the literal `>-`; 1197 commits in the store carry the subject
# "Log memory: >-". These cases pin down the two things that regression needs:
# the extractor handles every scalar style, and it stays silent (rather than
# failing) on anything it cannot parse, so a capture is never blocked.
#
# Nothing here touches the real store: fixtures and git repos are built in a
# temp dir that is removed on exit.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
extractor="$repo_root/scripts/entry-title.cjs"
claude_hook="$repo_root/.claude/hooks/auto-commit-memory.sh"
codex_hook="$repo_root/.codex/hooks/auto-commit-memory.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
checks=0

# expect_title <label> <want> <file>
expect_title() {
  local label="$1" want="$2" file="$3" got
  checks=$((checks + 1))
  got="$(node "$extractor" "$file" 2>/dev/null)"
  if [ "$got" != "$want" ]; then
    printf '  ✗ %s\n      want [%s]\n      got  [%s]\n' "$label" "$want" "$got"
    failures=$((failures + 1))
  else
    printf '  ✓ %s\n' "$label"
  fi
}

# fixture <name> <contents>
fixture() {
  printf '%s' "$2" > "$tmp/$1.md"
  printf '%s' "$tmp/$1.md"
}

echo "entry-title extraction:"

# The regression case: a folded block scalar. Pre-fix this yielded ">-".
f="$(fixture folded '---
id: x
title: >-
  A folded entry title long enough that the serializer wrapped it — onto a
  second line
type: note
---

body
')"
expect_title "folded scalar (>-) is unfolded, not reported as >-" \
  "A folded entry title long enough that the serializer wrapped it — onto …" "$f"

# Literal block scalars fold the same way and broke identically.
f="$(fixture literal '---
id: w
title: |-
  Literal block title
  second line
type: note
---

body
')"
expect_title "literal scalar (|-) collapses to one line" \
  "Literal block title second line" "$f"

# Styles the old sed already handled — guard against a regression in the fix.
f="$(fixture plain '---
id: y
title: A short plain title
type: note
---

body
')"
expect_title "plain scalar is unchanged" "A short plain title" "$f"

f="$(fixture quoted "---
id: z
title: 'Quoted: with a colon'
type: note
---

body
")"
expect_title "quoted scalar keeps the colon, drops the quotes" \
  "Quoted: with a colon" "$f"

# A subject longer than 72 chars is truncated with an ellipsis.
f="$(fixture long "---
id: long
title: $(printf 'A%.0s' {1..200})
type: note
---

body
")"
expect_title "over-long title truncates to 72 chars with an ellipsis" \
  "$(printf 'A%.0s' {1..71})…" "$f"

# Degenerate inputs must produce empty output, never an error or junk subject.
f="$(fixture nofm 'not frontmatter at all
')"
expect_title "file without frontmatter yields nothing" "" "$f"

f="$(fixture notitle '---
id: n
type: note
---

body
')"
expect_title "frontmatter without a title yields nothing" "" "$f"

f="$(fixture malformed '---
id: [unclosed
title: >-
  never reached
---

body
')"
expect_title "malformed YAML yields nothing" "" "$f"

expect_title "missing file yields nothing" "" "$tmp/does-not-exist.md"

checks=$((checks + 1))
if node "$extractor" "$tmp/does-not-exist.md" >/dev/null 2>&1; then
  printf '  ✓ extractor exits 0 even when it cannot read the file\n'
else
  printf '  ✗ extractor must exit 0 so the hook never fails a capture\n'
  failures=$((failures + 1))
fi

# End-to-end: drive each hook against a throwaway store and read back the
# subject it actually committed. This is what the 1197 bad commits came from.
echo
echo "hook end-to-end:"

# run_hook <hook> <project-dir>
run_hook() {
  printf '{"tool_name":"Bash","tool_input":{"command":"npx tsx src/cli.ts add --title x"}}' \
    | CLAUDE_PROJECT_DIR="$2" bash "$1" >/dev/null 2>&1
}

# hook_case <label> <hook>
hook_case() {
  local label="$1" hook="$2" dir subject
  checks=$((checks + 1))
  dir="$tmp/store-$checks"
  mkdir -p "$dir/memory/entries/2026/10"
  git -C "$dir/memory" init -q 2>/dev/null
  git -C "$dir/memory" config user.email t@example.com
  git -C "$dir/memory" config user.name Test
  cat > "$dir/memory/entries/2026/10/entry.md" <<'ENTRY'
---
id: e
title: >-
  A folded title long enough that matter.stringify wrapped it across two lines
type: note
---

body
ENTRY
  ( cd "$dir" && run_hook "$hook" "$dir" )
  subject="$(git -C "$dir/memory" log --format=%s -1 2>/dev/null)"
  if [ "$subject" = "Log memory: A folded title long enough that matter.stringify wrapped it across two …" ]; then
    printf '  ✓ %s\n' "$label"
  else
    printf '  ✗ %s\n      got subject [%s]\n' "$label" "$subject"
    failures=$((failures + 1))
  fi
}

hook_case "claude hook commits the unfolded title" "$claude_hook"
hook_case "codex hook commits the unfolded title" "$codex_hook"

echo
if [ "$failures" -ne 0 ]; then
  printf 'auto-commit-hook: %d/%d checks FAILED\n' "$failures" "$checks"
  exit 1
fi
printf 'auto-commit-hook: all %d checks passed\n' "$checks"
