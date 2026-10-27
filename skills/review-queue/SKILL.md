---
name: review-queue
description: Use when the user wants to work through pending shared-graph candidates in chat — "review the queue", "what's waiting for team-x", "promote memories", "review what can go public", "share entries with <graph>", "approve the queued candidates". Walks the per-graph review queue one entry at a time; every copy is user-confirmed.
---

# Working through a review queue

Nothing reaches a shared graph on its own. Standing rules, explicit "log this
to X" requests, and sweep routines all end in the same place: a per-graph
**review queue**. This skill drains one, in conversation.

The web UI's Manage Graphs → review queue tab drives the exact same store, so
a review can start here and finish there, or the other way round. Approving
in chat updates the same counts and watermarks the screen shows.

This skill only *drains*. To fill a queue — judge fresh entries against a
graph's criteria and propose them — use the `sweep-graphs` skill.

## Locating the store

Everything in this skill is **store-relative** — not just the
`npx tsx src/cli.ts …` commands (the CLI resolves the store from its working
directory), but every path involved: the entry paths the CLI's output cites,
and each graph's `GRAPH.md`.

- Working inside the personal-memory repo already (`src/cli.ts` present)? Run
  the commands and read the paths as written.
- Installed via the plugin marketplace and working in another project?
  `MEMORY_HOME` must point at the user's personal-memory clone. Run every
  command as `cd "$MEMORY_HOME" && npx tsx src/cli.ts …`, resolve every
  store-relative path under it, and run git checks as
  `git -C "$MEMORY_HOME/memory" …` (or
  `git -C "$MEMORY_HOME/memory-graphs/<name>"` for a shared graph's repo).
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## Steps

1. **See what is waiting.** No graph named? Show every queue and let the user
   pick:

   ```bash
   npx tsx src/cli.ts queue list
   ```

   Each lane reports its pending count, how many are blocked or stale, and
   when a routine last swept it. A graph that has never been swept has
   nothing waiting because nobody looked — say so rather than reporting it as
   empty, and offer `/sweep-graphs`.

2. **Read the lane.** `queue list --graph <g> --json` is the machine-readable
   form; `hasSummary` says whether a row carries proposed wording. Use
   `queue show <id> --graph <g>` to read that wording — `list` deliberately
   omits it.

3. **Present one candidate at a time.** For each row give the user:
   - id · date · type · title
   - who proposed it and why (the row's own `reason`, verbatim — it is the
     proposer's judgment, not yours to paraphrase away)
   - whether it is `blocked`, and by what
   - when a summary exists: the entry's own wording **and** the proposed
     wording, side by side, so the choice is visible

   Batch presentation is fine. Batch approval is not — "yes to all" has to
   come from the user, in their own words.

4. **Act on each decision**, one entry at a time:

   ```bash
   npx tsx src/cli.ts queue approve <id> --graph <g>             # the entry's own wording
   npx tsx src/cli.ts queue approve <id> --graph <g> --summary   # the proposed redaction
   npx tsx src/cli.ts queue dismiss <id> --graph <g> [--reason "…"]
   ```

   Undecided → do nothing; it stays queued.

5. **Blocked rows** reference entries that are not members of the target yet.
   A shared graph has to be self-contained, so the blocker joins first. Offer
   to queue it (`queue add <blocker> --to <g> --reason "…"`), review it like
   any other candidate, and come back.

6. **Stale rows** carry a summary drafted against wording the entry no longer
   has. Never approve one blind. Either re-read the entry and re-draft
   (`queue add <id> --to <g> --reason "…" --summary-file <path>` overwrites
   the row), or approve the entry's own wording instead.

7. **Report** what was approved, declined and skipped, with ids, and what is
   left in the lane.

## Principles

- **The user confirms every membership change.** Your judgment selects what
  to *present*; theirs decides what ships.
- **Doubt disqualifies.** If a candidate looks wrong for the graph, say so
  and recommend declining — do not approve something you would not defend.
- **Never paraphrase a `reason` into something more confident than it was.**
- **Only `queue approve` / `queue dismiss` mutate state here.** Never edit or
  relocate files by hand.
- **A redaction is offered, never imposed.** Drafting shareable wording is
  sanctioned — that is what a summary row is — but it reaches the graph only
  when the user approves that specific text, and the private entry is never
  rewritten to make it shareable.
- **Only the body can be redacted.** An entry whose *title* gives away what
  must stay private does not belong in the graph at all; decline it.
