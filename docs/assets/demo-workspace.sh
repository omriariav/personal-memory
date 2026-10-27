#!/usr/bin/env bash
# Build a throwaway AGENT workspace for recording the README casts.
#
#   ./docs/assets/demo-workspace.sh /tmp/pm-claude-demo
#
# demo-seed.sh alone gives you a store. An agent needs the repo's instruction
# surface too -- CLAUDE.md, AGENTS.md, the skills and the guardrail hooks -- or
# it will not know to route through the CLI at all. This symlinks that surface
# next to a freshly seeded synthetic store, so a real `claude` (or `codex`)
# session behaves exactly as it does in the real repo while touching nothing
# but invented memories.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:?usage: demo-workspace.sh <target-dir>}"

mkdir -p "$TARGET"

for link in src node_modules package.json package-lock.json tsconfig.json \
            skills connectors sources AGENTS.md CLAUDE.md MEMORY-GUARDRAILS.md; do
  [ -e "$REPO/$link" ] && ln -sfn "$REPO/$link" "$TARGET/$link"
done

# .claude is copied rather than linked: the recording gets its own permission
# allowlist so a cast never stalls on an approval prompt, and that allowlist
# must not leak back into the real repo.
rm -rf "$TARGET/.claude"
cp -R "$REPO/.claude" "$TARGET/.claude"
rm -f "$TARGET/.claude/launch.json"

cat > "$TARGET/.claude/settings.local.json" <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(npx tsx src/cli.ts:*)",
      "Bash(npx:*)"
    ]
  }
}
EOF

"$REPO/docs/assets/demo-seed.sh" "$TARGET" >/dev/null 2>&1

echo "✓ agent workspace ready at $TARGET"
echo "  cd $TARGET && claude"
