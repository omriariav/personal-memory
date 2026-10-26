#!/usr/bin/env bash
# Seed a throwaway demo store used to record the README assets.
#
#   ./docs/assets/demo-seed.sh /tmp/pm-demo
#
# Everything here is invented. The store it builds is disposable: it exists so
# the screenshots, terminal casts and command output in the README come from a
# real run of the real CLI instead of being typed out by hand.
#
# Two things the demo has to show, so they are built in deliberately:
#   - timeline chains: a pending-decision that a later decision settles
#   - the privacy boundary: 1:1, hiring and feedback entries that are
#     shareable-graph ineligible and stay in the default graph forever
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:?usage: demo-seed.sh <target-dir>}"

mkdir -p "$TARGET/memory/entries"
cd "$TARGET"

mem() { npx --prefix "$REPO" tsx "$REPO/src/cli.ts" "$@"; }

add() { mem add "$@" >/dev/null; }

# A `memory` on PATH, so the recorded casts show the command a user would type
# rather than the tsx invocation. Transformers.js prints a dtype notice on
# every load that is noise in a cast; drop that one line and nothing else.
mkdir -p "$TARGET/bin"
cat > "$TARGET/bin/memory" <<EOF
#!/usr/bin/env bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use 20 >/dev/null 2>&1
npx tsx "$REPO/src/cli.ts" "\$@" 2>&1 | grep -v 'dtype not specified'
exit \${PIPESTATUS[0]}
EOF
chmod +x "$TARGET/bin/memory"

add --title "Payments replatform kickoff" --type meeting --date 2026-02-10 \
  --people jane-doe,marco-silva --teams platform-team --tags payments,planning \
  --body "Walked the room through the two-quarter plan to move payments off the monolith. Jane owns the rollout plan, Marco owns the pipeline. Agreed the first milestone is dual-writing to the new store with zero customer-visible change."

add --title "Queue technology for the payments pipeline: Kafka vs RabbitMQ" --type pending-decision --date 2026-03-04 \
  --people marco-silva --teams platform-team --tags payments,architecture \
  --body "Open question blocking the pipeline design. Kafka gives us replay and a retention window we can reason about; RabbitMQ is already running in production and the team knows its failure modes. Deferred until we have numbers from the load test."

add --title "Checkout latency spike after the Tuesday deploy" --type incident --date 2026-03-18 \
  --people priya-raman --teams platform-team --tags payments,reliability \
  --body "p99 checkout latency went from 380ms to 2.1s for roughly forty minutes. Cause was an unbounded retry loop in the dual-write path. Rolled back, added a retry budget, and the load test now covers the degraded-dependency case."

add --title "Payments pipeline will run on Kafka" --type decision --date 2026-04-02 \
  --people marco-silva,jane-doe --teams platform-team --tags payments,architecture \
  --follows 2026-03-04-queue-technology-for-the-payments-pipeline-kafka-vs-rabbitmq \
  --body "Load test settled it: replay is the feature we actually need, and the retention window makes the incident class we hit in March recoverable instead of lost. RabbitMQ stays for the refunds path until that is migrated separately."

add --title "1:1 with Jane: scope, and what promotion readiness still needs" --type 1on1 --date 2026-04-15 \
  --people jane-doe --tags career,promotion \
  --body "Jane is operating above her level on delivery but the committee will ask about influence outside the team. Agreed two concrete things for the next cycle: own the replatform rollout end to end, and write up the dual-write pattern so other teams can use it. Revisit in June."

add --title "Debrief: senior platform engineer candidate" --type hiring --date 2026-05-06 \
  --people tom-becker --tags hiring \
  --body "Strong systems depth, walked through a queue migration he ran at his last company without hand-waving the failure modes. Weaker on the collaboration signal; two interviewers flagged that he talked over them. Leaning hire, with onboarding on a team that will push back."

add --title "Feedback for Marco on incident command" --type feedback --date 2026-05-20 \
  --people marco-silva --tags feedback,reliability \
  --body "Marco ran the March incident calmly and kept a clean timeline, which made the postmortem easy. The gap is delegation: he held both comms and debugging for the first twenty minutes. Suggested he name a comms owner in the first five minutes next time."

add --title "Payments replatform at 100% traffic" --type achievement --date 2026-06-03 \
  --people jane-doe,marco-silva --teams platform-team --tags payments \
  --body "Final ramp completed with no customer-visible incident. Two quarters end to end, one rollback along the way. The dual-write path is now off and the monolith no longer writes payments."

add --title "Why the legacy writer path is still around" --type note --date 2026-06-17 \
  --teams platform-team --tags payments,architecture \
  --body "Keeping the legacy writer behind a disabled flag for one more quarter. It is the only tested rollback we have if a reconciliation gap shows up in the quarterly close. Delete it after the Q3 close, not before."

add --title "Deprecating the v1 payments API in Q4" --type decision --date 2026-07-08 \
  --people priya-raman --teams platform-team --tags payments,api \
  --body "Three external integrations still call v1. Announced a Q4 end-of-life with a migration guide and a hard cutoff. Priya owns partner comms; we hold the cutoff even if one integration slips, because carrying both shapes is what made the March incident hard to debug."

add --title "Q3 roadmap review with growth" --type meeting --date 2026-08-12 \
  --people priya-raman --teams growth-team --tags roadmap \
  --body "Growth wants checkout experiments that need per-request pricing context. That is a pipeline change, not a UI change, so it lands in Q4 at the earliest. Agreed to scope it properly rather than bolt it onto the replatform while it is still settling."

add --title "Do we keep the RabbitMQ consumer for the refunds path?" --type pending-decision --date 2026-09-02 \
  --people marco-silva --teams platform-team --tags payments,architecture \
  --body "Refunds are the last thing on RabbitMQ. Keeping it means running two brokers and two sets of runbooks; moving it means another migration in a quarter that is already full. Revisit after the sale weekend, when we will know how the refunds path behaves under load."

add --title "Refund webhook backlog during the sale weekend" --type incident --date 2026-09-30 \
  --people priya-raman,marco-silva --teams platform-team --tags reliability,payments \
  --body "Refund webhooks backed up to roughly six hours during peak. The RabbitMQ consumer could not be scaled past its prefetch ceiling without reordering, and we had no replay to fall back on. Drained manually over Sunday night. No money moved incorrectly, but we could not prove that quickly, which is its own problem."

add --title "Refunds move to Kafka; RabbitMQ is retired" --type decision --date 2026-10-07 \
  --people marco-silva --teams platform-team --tags payments,architecture \
  --follows 2026-09-02-do-we-keep-the-rabbitmq-consumer-for-the-refunds-path \
  --body "The sale weekend answered it. Not being able to replay the backlog is what turned a slow queue into an all-night manual drain. Refunds move in Q4 and RabbitMQ comes out of the payments stack entirely. One broker, one set of runbooks."

mem index >/dev/null
echo "✓ demo store seeded at $TARGET"
