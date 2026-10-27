---
description: Judge new memories against each shared graph's criteria and queue the ones that fit (proposes only)
argument-hint: [graph] [or a window, e.g. "since July"]
---

Use the `sweep-graphs` skill (`skills/sweep-graphs/SKILL.md`) to fill the
review queues. For each graph: read its eligibility criteria from
`memory-graphs/<graph>/GRAPH.md`, resume from its `sweptThrough` watermark,
gather the unreviewed pool with `memory promote candidates --to <graph>`, and
judge each entry against those criteria.

Queue only entries that clearly qualify, with `memory queue add <id> --to
<graph> --reason "…"`. Where the substance belongs but the wording does not,
draft shareable wording and offer it with `--summary-file`, saying in the
reason why a redaction is proposed. Doubt disqualifies. Then record the
watermark with `memory queue sweep --graph <graph> --through <date>`.

Propose only — never copy, move, or `--force` past a decline. Report what was
queued and point me at `/promote` or the Manage Graphs screen.

Scope:

$ARGUMENTS
