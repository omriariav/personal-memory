---
name: recall-memory
description: Use whenever the user asks you to pull/pull up/look up memory, recall something, recap or catch them up, or brief/prep them for a meeting, 1:1, or review — and for any question about people, past events, decisions, commitments, or plans that should be grounded in the stored personal memory rather than chat history alone. Discovery runs ONLY through the memory CLI (recall / person / list) — never grep, ls, cat, Glob, or free-form Read over the store, from any tool including the shell.
---

# Recalling personal memory

You are answering grounded in the user's stored **Personal Memory**. Always
consult the memory before answering people/history
questions — do not rely on conversation history alone, which won't survive
across sessions.

## Locating the store

Everything in this skill is **store-relative** — not just the
`npx tsx src/cli.ts …` commands (the CLI resolves the store from its working
directory), but every path involved: `memory/…` and `connectors/…` files,
index files, and the entry paths that CLI output cites.

- Working inside the personal-memory repo already (`src/cli.ts` and
  `connectors/` present)? Run the commands and read the paths as written.
- Installed via the plugin marketplace and working in another project?
  `MEMORY_HOME` must point at the user's personal-memory clone. Run every
  command as `cd "$MEMORY_HOME" && npx tsx src/cli.ts …`, and resolve every
  store-relative file you read or edit under it too — entry paths printed by
  the CLI, connector files, `memory/summaries/…`, and git checks as
  `git -C "$MEMORY_HOME/memory" …`.
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## ⛔ Retrieve through the CLI — never grep the files

| Tempting shortcut | Why it's wrong |
|---|---|
| "I'll just grep `memory/` for the keyword" | Misses semantic matches; breaks past a handful of entries |
| "I'll glob and read all the entries" | Doesn't scale; no ranking; wastes context |
| "The repo is small, file search is fine" | It won't stay small — build the right habit now |
| "I'll just `grep -r` / `cat` it from Bash" | Same mistake, different tool — no ranking, no chain status; the hook denies it too |
| "`grep -rli "jane doe" .` — I'm not touching `memory/`" | You are. An unscoped sweep from the repo root walks straight into the store |
| "It's urgent, they're about to walk into the meeting" | Urgency is when a stale, half-complete answer costs the most |

**Discovery is always via `memory recall` / `memory query` / `memory list` /
`memory person`.**
Use `Read` only to open the specific files those commands cite. Do not use
Grep/Glob — **or shell `grep`/`rg`/`find`/`cat`/`ls`** — to find memories. The rule
is about *discovery*, not about which tool performs it: shelling out is not a
loophole, it is the same mistake with an extra step.

Concretely, hand-searching costs you two things the CLI gives for free: entries
that never spell the name or term your way (a project, a nickname, a related
workstream) never surface at all, and raw files carry no `⤷ superseded by` /
`status: resolved by` metadata — so a settled matter reads as if it were still
current.

## Adaptive depth — pick the right mode for the question

**A. Narrow lookup** ("what did we decide about ranking?", "when did the Acme
kickoff happen?") → use `memory recall`. Pass the user's question as the first
positional. Add 1–3 agent-supplied phrasings when useful (keyword form,
entity/name form, alternate wording). The CLI also adds deterministic expansion
phrases unless `--no-expand` is passed; all phrases are fused into one weighted
ranking:

```bash
npx tsx src/cli.ts recall "what did we decide about ranking" "ranking decision" "ranker rollout" --person <slug> --since <date> --format json
```

Recall reports whether retrieval was exhaustive. By default, `recall` uses deep
candidate pools and `complete-if-small` (≤200 matching entries): when exhaustive
is true, **every** candidate entered consideration and nothing was silently
dropped before the `-k` cut. Use `--complete` to force a complete scan,
`--require-complete` when a non-exhaustive answer is unacceptable, and
`--no-expand` only when the supplied phrases should be used exactly. On
non-exhaustive runs the long tail is trimmed at half the top score (the JSON
report's `cutoff` field says how many were dropped); pass `--no-cutoff` when
you want the full tail, e.g. when sweeping for anything loosely related. Read
the top cited entry file(s) in full, then answer with citations (file paths).

If a hit is a `summary` entry, its output includes a `sources:` line — pull the
raw entries it cites when you need specifics behind the rollup.

**Names resolve through people profiles.** Write names the way the user says
them: "Zhenya", "Jane Doe", or a slug all reach the same person once
`memory/people/<slug>.md` lists the nickname (the JSON report's `entities`
field shows what resolved; `ambiguous` lists names shared by two people — ask
or pass `--person <slug>`). `--person` and `person <…>` accept a name or a
close slug too. When the user refers to someone by a name recall cannot
resolve, add it once:

```bash
npx tsx src/cli.ts people alias evgenia-ivanova --add "Zhenya"     # people list / people show <name> to look around
```

### ⏱ Timeline annotations — never answer from a stale chain member

Entries can be chained with `follows` links (note → pending-decision →
decision). When a hit belongs to a chain, recall annotates it:

- `⤷ superseded by: <id> (<type> · <date>)` — a later entry REPLACED this
  one's state: the same type again (a newer decision after a decision), or a
  decision/todo/note that closed an open `pending-decision`/`todo`. **Read
  that entry before answering** and present IT as the current state (cite
  both). Superseded members are ranked lower, never hidden — do not "correct"
  the order by hand.
- `↳ extended by: <id> (<type> · <date>)` — later developments were ADDED
  without replacing this entry (a meeting after a decision, a pending item
  raised from a note): this entry is still the state; cite both.
- `status: open` / `status: resolved by <id>` — whether a
  `pending-decision`/`todo` was settled. Never report an item marked
  `resolved by <x>` as still open, and never present a superseded plan or
  pending decision as the current one.
- In `--format json`, the same data is the `chain` field per hit
  (`prev`/`next`/`relations`/`superseded`/`current`/`latest`/`status`/
  `resolvedBy`) plus the raw `follows` ids. `current` is the entry holding
  the state now; `latest` is the newest member of the whole chain.

**B. Synthesis / planning** ("how has Jane evolved?", "themes across this
quarter?", "who's ready for promotion?", "prep for my staff meeting") →
**filter the slice, then read everything**:

1. Scope deterministically with metadata, not just semantic search:
   ```bash
   npx tsx src/cli.ts person jane-doe            # everything about a person
   npx tsx src/cli.ts list --type decision --since 2026-04-01
   npx tsx src/cli.ts list --tag roadmap
   ```
   For open-ended synthesis where a list filter is too blunt, use `recall`
   with `--complete`, `--require-complete`, or the default complete-if-small
   report as appropriate:
   ```bash
   npx tsx src/cli.ts recall "how has jane grown" "jane feedback promotion" --person jane-doe --complete --format json
   ```
2. **Read the matched files in full** (raw entries + any `memory/summaries/`
   rollups that cover the scope). At this corpus size the whole relevant slice
   fits in context — completeness beats top-k guessing here.
3. Synthesize: themes, what changed over time, open threads, risks, and what to
   watch next. Cite the entries you drew from.

## Graph scope — the default graph + named shared graphs

The store holds N graphs: **default** (`memory/` — secret, local-only, the
home of every capture) and any number of **named shared graphs**
(`memory-graphs/<slug>/` — separable stores for specific audiences, all
user-created; `npx tsx src/cli.ts graphs list` shows the registry).
One memory can be a **member of several graphs** (synced copies; the default
graph stays its home). `recall` / `query` / `list` / `person` search **all graphs
by default**, fused into one ranking; shared memberships are labeled
`[<graph>,…]` in text output (and hits carry `graphs: []` in
`--format json`). `--graph <name>` narrows to that graph's members.

- Answering the user's own questions → default (all graphs) is right.
- Preparing anything that will be **shared or leave the private context**
  (team update, doc for others, message draft) → recall with
  `--graph <name>` of the intended audience, or use the `recall-graph`
  skill — and never quote a default-graph-only entry's content, id, title, or path
  into shareable output.
- Containment: a shared graph is self-contained — its entries reference only
  fellow members. Only DEFAULT-graph entries may reference entries in other
  graphs, so a shared-graph hit's `⤷ superseded by` may point at an unshared
  entry (the matter continued privately); note only that newer non-shareable
  context exists, without describing it in shareable output.

## Filters available

`--person <slug>` · `--type <type>` · `--team <slug>` · `--tag <slug>` ·
`--since <YYYY-MM-DD>` · `--until <YYYY-MM-DD>` · `--graph <name>` ·
`-k <n>` · `--complete` · `--complete-if-small` · `--require-complete` ·
`--no-expand` · `--format json`

## Keeping recall sharp (compaction)

For a heavily-referenced person/topic/quarter, refresh a rolling summary:

```bash
npx tsx src/cli.ts digest --person jane-doe     # or --quarter 2026-Q2 / --tag roadmap
```

This writes/updates an additive `type: summary` entry under `memory/summaries/`
with `sources:` back-links. **Then write the `## Synthesis` section** of that
file into real prose (it ships as a scaffold) and run `npx tsx src/cli.ts index`.
Summaries augment — never replace — the raw entries.

To find out **which** digests are due (plus index health and slug issues), run:

```bash
npx tsx src/cli.ts maintenance        # prints ready-to-run digest commands
```

`maintenance` also lists **dangling links** — entries whose `follows` points at
an id that no longer exists — so a broken chain is visible. Slug merge
suggestions can be permanently ignored in the web UI's maintenance screen
(ignore button).

## Golden set — turn confirmed answers into regression tests

Ranking changes are gated by measurement. The private golden set
(`memory/eval/golden.json`, versioned by the nested repo, never leaves the
machine) holds real questions with the entry the user confirmed as the answer.
When a recall session ends with the user confirming which cited entry was
right, offer one line — never save automatically, the expected id is a human
judgment:

```bash
npx tsx src/cli.ts eval add-golden "<the user's exact question>" "<phrasing you used>" --expect <confirmed-id>
# a known follows chain: assert the latest state outranks the stale one
npx tsx src/cli.ts eval add-golden "where did we land on X" --expect <latest-id> --must-outrank <latest-id>:<superseded-id>
```

`add-golden` validates the ids, runs the case once so the current rank is
visible, and checkpoints `memory/.git`. `eval run --compare` scores the live
store against `memory/eval/baseline.json` (`--save-baseline` records it) and
exits 2 on regression; `eval list` shows each case with its last result. Never
write `memory/eval/` by hand and never copy its contents into `docs/` — real
titles and ids belong only in the private store.

## Principles

- Ground every claim in a cited entry; if memory is silent, say so plainly.
- Respect recency: newer entries can supersede older ones — follow
  `⤷ superseded by` annotations to the latest chain member and note conflicts.
- Stay honest about gaps; suggest logging a memory if something important is
  missing.
