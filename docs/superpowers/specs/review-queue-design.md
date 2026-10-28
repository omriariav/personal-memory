# Shared-graph review queues

**Date:** 2026-10-27

## Intent

Make the shared graphs fill on purpose rather than by default.

Before this, a memory reached a shared graph three ways, and two of them were
silent. A standing distribution rule copied at capture time — by the time you
saw the entry, it was already published. `add --graph <name>` wrote straight
into that graph. Only the promotion review asked first, and it recomputed its
candidate list from scratch every run, so an agent's judgment ("this belongs
in team-x because…") evaporated when the conversation ended. There was no UI
for it at all.

The inversion: every automatic path now **proposes**, into a durable per-graph
**review queue**, and the user approves one entry at a time. Claude/Codex
routines do the judging and fill the queues; the app stores them and gives the
user somewhere to work through them, in the browser or in chat.

## Goals

- Nothing reaches a shared graph without an explicit per-entry approval.
- Candidates persist, carrying the proposer's reasoning, so a sweep on Monday
  can be reviewed on Friday.
- Each graph's queue has its own progress — draining one leaves the others
  untouched.
- A candidate can offer **redacted wording** for a memory whose substance
  belongs in the graph but whose words do not.
- Chat and the UI are interchangeable: one store, one set of watermarks.
- No scheduler inside the app. Routines are the agent's job.

## Non-goals

- Bulk approval. One entry at a time, deliberately.
- Topic/theme candidates. A row is one entry for one graph.
- Approving from anywhere but the user — no agent ever calls `queue approve`
  on its own initiative.

## Anti-goals

- A queue that silently drains itself. There is no auto-approve, no
  "approve everything older than N", no trust threshold.
- A rule that still publishes. If any automatic path can reach a shared store,
  the queue is decoration.
- Overwriting an approved redaction with the private text it was written to
  replace. Three separate code paths could have done this; all three are
  closed, and each has a test whose failure means a leak.

## Key decisions

**Everything goes through the queue.** Standing rules, `add --graph`, and
sweep routines all terminate in a row. A saved rule decides what is worth
looking at, not what gets shared — this reverses a documented invariant
(`MEMORY-GUARDRAILS.md`: "a saved rule IS standing approval") and that
sentence is now gone.

**Declared variants.** A shared copy may carry `variant_of_hash`, the home's
**body** hash at approval time, and hold approved redacted wording instead of
the entry's own. This is the single exception to the byte-identical-copy
model, and it is *declared* so the loader can tell it from a bug: current
(left alone), stale once the home's body changes (reported, re-proposed, still
left alone), or genuine drift (repaired as before).

Body-scoped, not whole-entry: a variant's frontmatter stays synced so tag
merges and chain links propagate, and hashing the whole entry would mark every
variant in the store stale on any frontmatter change. The corollary is that a
*title* cannot be redacted — such an entry stays private.

**Rows live in `memory/graphs/queue.json`**, beside `rules.json`, not in
`.index/`. That directory is documented as a rebuildable derivative, and a
routine-drafted redaction is not something a reindex can regenerate.

**No status field, no cleanup job.** Every read re-decides which rows are
still live against the store as it is — approved, declined, deleted and
hand-copied entries all fall out on their own. The precedent is
`slug-proposals.json`. Stale-variant re-reviews are *derived* at read time and
never persisted, so they cannot themselves go stale.

**Refusals are values; decisions throw.** A sweep over a hundred candidates
reports what it skipped and keeps going. `approve`/`dismiss` raise typed
errors so the HTTP layer answers 404/409 without matching message text.

## Deferred, with eyes open

**Recall returns the private body for a redacted entry.** The index holds one
row per logical entry, built from the home, so `recall --graph team-x`
surfaces the private wording even where the published copy is a redaction. The
index is local and private, so this is not a data leak — it is a *workflow*
leak, and `skills/recall-graph` is exactly the surface it undermines.

The sharpest instance is a digest: `memory digest --graph <g>` scaffolds a
summary **into that shared store**, and an agent refines its `## Synthesis`
afterwards. Written from recall, that prose would put the redacted wording
back into the very store the redaction was for — a write, not just a display.
`AGENTS.md` and the guardrails table now say to write it from the graph's own
copies.

Mitigated in instructions rather than code: `CLAUDE.md` and the skills say to
read the graph's own copy before quoting it into shared output, and
`MemoryEntry.variants` carries the flag needed to detect one. A derived-entry
model (approving a summary writes a *new* private entry, copied verbatim)
would solve it for free; it was considered and rejected in favour of one
entry, one id, one timeline. If graph-scoped recall on redacted entries starts
to matter, that is the thing to revisit.

Cheap future fast path: the `files` table already stores a per-file hash and
has no reader. `files.hash ≠ entries.hash` on a non-default graph detects a
variant with no schema change and no `CATALOG_VERSION` bump.

## Shape

| Layer | Where |
|---|---|
| Variant mechanics | `src/schema.ts`, `src/ingest.ts` (`hashBody`, `groupEntries`, `writeEntryAll`, `serializeVariant`, `readVariants`), `src/membership.ts` |
| Queue | `src/graph-queue.ts` |
| CLI | `memory queue list\|show\|add\|approve\|dismiss\|sweep` |
| HTTP | `/api/queue`, `/api/queue/<graph>[/approve\|dismiss\|enqueue]` |
| UI | `#/graphs` tabs; `src/ui/queue-map.js`; `renderQueue` in `src/ui/app.js` |
| Chat | `skills/sweep-graphs` (fill), `skills/review-queue` (drain) |

## Notes for whoever changes this next

- `groupEntries` is on the load path of **every** command. Get the variant
  partition wrong and the store stops loading. It is tested in
  `src/ingest-variants.test.ts`; keep those passing.
- Entries reaching the single-entry write paths come from the **catalog**,
  which is built from index rows and knows nothing of variants. That is why
  `readVariants` exists. Guessing here is what causes the leak.
- `/api/queue*` is deliberately *not* under `/api/graphs/`, and both the route
  and the UI hash parse the slug as an exact segment — a graph called
  `queue-archive` must reach its own manifest.
- `approve` is the first server write that publishes into a store meant to be
  handed to other people. That is why the loopback `Origin`/`Host` guard
  landed first.
