---
name: sweep-graphs
description: Use when the user wants fresh memories judged against a shared graph's criteria and proposed for review — "sweep the graphs", "find what belongs in team-x", "look for anything shareable", "fill the review queue", or on a schedule via /loop. Proposes candidates into the per-graph review queue; never copies anything.
---

# Sweeping for shared-graph candidates

This skill fills review queues. It reads private memories, judges them
against a graph's eligibility criteria, and queues the ones that fit — with
the reasoning attached — for the user to approve later, in the UI or via the
`review-queue` skill.

**It never publishes.** `queue add` is the only write it makes. That is what
makes it safe to run unattended, including under `/loop`.

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

1. **Pick the graphs.** One named by the user, or every shared graph:

   ```bash
   npx tsx src/cli.ts graphs list
   ```

2. **Read the criteria** — the body of `memory-graphs/<graph>/GRAPH.md`. This
   is the whole basis for your judgment. Each graph seeds an
   "## Eligibility — what belongs in this graph" checklist at creation; the
   user may have rewritten it. If it is still the untouched template, say so
   and ask the user to sharpen it rather than guessing what they meant.

3. **Resume where the last sweep stopped.** The watermark is per graph:

   ```bash
   npx tsx src/cli.ts queue list --graph <g> --json   # .graphs[0].sweptThrough
   ```

   Pass it as `--since` so you re-judge only what is new. On a first sweep
   there is no watermark; agree a window with the user rather than walking
   the entire corpus.

4. **Gather the unreviewed pool:**

   ```bash
   npx tsx src/cli.ts promote candidates --to <g> [--since YYYY-MM-DD]
   ```

   This is mechanical: private entries not already members and not previously
   declined at their current content. Semantic eligibility is your job.

5. **Judge each one against the criteria.** Read the entry when the title is
   not enough. Most entries should fail — **doubt disqualifies**. For each
   keeper decide which of two cases it is:

   - **It belongs as written.** Queue it with a reason naming the criteria it
     meets:
     ```bash
     npx tsx src/cli.ts queue add <id> --to <g> \
       --reason "…" --proposed-by "<your label, e.g. claude-sweep>"
     ```

   - **The substance belongs but the wording does not** — it names
     compensation, a health matter, a third party's confidence, anything the
     graph's readers should not get. Draft shareable wording and offer it
     alongside:
     ```bash
     printf '%s\n' "<the redacted wording>" > /tmp/summary.txt
     npx tsx src/cli.ts queue add <id> --to <g> \
       --reason "…" --summary-file /tmp/summary.txt --proposed-by "<label>"
     ```
     Say in the `reason` *why* a redaction is proposed, so the user can judge
     the call and not just the text. Keep every fact the graph needs and drop
     only what must not travel; a summary that loses the point is worse than
     declining.

   **A revealing title cannot be redacted** — only the body can. If the title
   itself gives it away, do not queue the entry at all.

6. **Record the watermark** so the next sweep resumes here:

   ```bash
   npx tsx src/cli.ts queue sweep --graph <g> --through <YYYY-MM-DD>
   ```

7. **Report**: how many were judged, how many queued (and how many with a
   proposed redaction), how many skipped and broadly why. Point at
   `/promote` (the review-queue skill) or the Manage Graphs screen. Never imply anything was
   shared — nothing was.

## Refusals are normal

`queue add` reports rather than throws, so a sweep keeps going. Common ones,
all fine to skip past:

- *already a member* — it got there another way
- *already declined … at its current content* — the user said no and the
  entry has not changed. Do **not** pass `--force` to get around this;
  re-propose only if the user asks.
- *no entry with id* — stale candidate list; re-run step 4

A blocked candidate (one referencing non-members) still queues, with its
blockers shown. Queue it, and queue what it references too if those also
qualify — the user resolves the order at review time.

## Principles

- **Propose, never publish.** `queue add` is the only state this skill
  changes.
- **The reason is the product.** A row the user cannot evaluate without
  re-reading the entry has not saved them anything. Name the criteria.
- **Doubt disqualifies.** A queue full of maybes is worse than a short one.
- **Never pass `--force`** on your own initiative; it overrides a decision
  the user already made.
- **Never widen the criteria** because a sweep found little. An empty sweep
  is a valid result — report it and stop.
