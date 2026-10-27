---
description: Work through pending shared-graph candidates in chat (per-entry confirmation)
argument-hint: [graph] [or "all"]
---

Use the `review-queue` skill (`skills/review-queue/SKILL.md`) to work through
the review queue. `memory queue list` shows every lane; `--graph <name>`
narrows to one (`memory graphs list` is the registry).

Present each candidate one at a time with the proposer's own reason, whether
it is blocked or stale, and — when the row carries proposed wording — the
entry's own words beside the proposed ones. Get my explicit per-entry
confirmation before any `memory queue approve`; `--summary` publishes the
proposed wording and without it the entry's own. Record declines with
`memory queue dismiss`. Report approved / declined / skipped with ids, and
what is still waiting.

Nothing reaches a shared graph without my yes on that specific entry.

Scope:

$ARGUMENTS
