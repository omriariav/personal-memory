# Concepts

Personal Memory separates durable content from derived search state. The
durable content is Markdown you could read with `cat` and keep if this project
disappeared. Everything else — vectors, lexical tables, catalogs — is
rebuildable from it.

## On disk

```text
memory/entries/YYYY/MM/<id>.md     the DEFAULT graph — every capture lands here
memory/summaries/<id>.md           additive summaries written by `digest`
memory-graphs/<slug>/entries/...   one directory per named SHARED graph
.index/                            rebuildable search artifacts
connectors/<name>.md               public connector templates
memory/connectors/<name>.md        private connector overrides (gitignored)
sources/<name>.md                  public reference-source templates
memory/sources/<name>.md           private reference-source overrides (gitignored)
```

Both `memory/` and `memory-graphs/` are ignored by the main repository and
versioned in their own nested git repos, so a `git pull` on the project can
never touch an entry.

## Entries

Each entry is Markdown with strict YAML frontmatter:

```yaml
id: 2026-06-28-acme-kickoff
date: 2026-06-28
type: meeting
title: Kickoff with Acme
people: [jane-doe, john-smith]
teams: [platform-team]
tags: [roadmap, partnership]
source_ids: [slack:C0123ABCD:1700000000.0012]
follows: [2026-06-20-acme-partnership-pending]
```

`id` is derived from the date and title. `source_ids` is what makes re-ingesting
the same Slack thread or email idempotent. `people`, `teams` and `tags` are
slugs, and reusing an existing slug matters more than picking a pretty one —
`memory slugs list` shows the vocabulary in use.

Entries are append-only in spirit: you refresh one in place when the same
source says more, and you log a *new* linked entry when the situation changes.

## Graphs

The store is one default graph plus any number of named shared graphs.

- **`memory/` is the default graph.** It is secret, local-only, and the home of
  every capture. If you never create another graph, everything lives here and
  nothing about graphs ever comes up.
- **`memory-graphs/<slug>/` is a named shared graph.** Each is a physically
  separate store with its own nested git repo and a `GRAPH.md` manifest whose
  body states that graph's eligibility criteria. None ship built-in; you create
  them with `memory graphs create <slug>` or the UI's Graphs screen.

One memory can be a member of several graphs. The CLI materializes
byte-identical copies and keeps them in sync on every later update, with the
default graph always the home.

![The Manage Graphs screen listing the default graph and one named shared graph, with distribution rules below](assets/ui-graphs.png)

**A capture lands in the default graph unless you explicitly name another one.**
Entries reach a shared graph three ways:

1. **Standing distribution rules** — per tag or per type, configured in the
   UI's Graphs screen, previewed with `memory rules apply --dry-run`, and
   applied automatically to future captures.
2. **A promotion review** — `memory promote candidates --to <graph>` lists
   unreviewed entries; the agent judges each against the graph's `GRAPH.md`
   criteria, you confirm one at a time, and `memory copy <id> --to <graph>`
   executes. Declines are recorded with `memory promote dismiss`.
3. **An explicit request** — "log this to the platform-team graph", which runs
   `memory add --graph platform-team`.

Route 3 is worth understanding precisely, because it is the one that bypasses
the default graph: `add --graph <name>` writes the entry into that graph **and
nowhere else**. It does not leave a copy at home, and `memory list --graph
default` will not show it. That is why the agent instructions reserve `--graph`
for an explicit request and route everything else through rules or promotion —
routes 1 and 2 both *add* a membership to an entry that already lives in the
default graph, so the home copy always remains.

### Containment

A shared graph is self-contained: **an entry in it may only reference fellow
members.** This is enforced at write time, not by convention. Copying an entry
whose `follows` target is not yet a member fails and names the ids to copy
first:

```text
✗ 2026-04-02-payments-pipeline-will-run-on-kafka references entries not in
  'platform-team': 2026-03-04-queue-technology-for-the-payments-pipeline-kafka-vs-rabbitmq
  copy those first: copy <id> --to platform-team
```

That is what makes a shared graph safe to hand over: there is no dangling
pointer back into material you kept. Recall spans every graph by default and
labels shared memberships; `--graph <name>` scopes to one graph and never falls
back to another.

Wrong placements are fixed with `copy` and `move`, never by moving files.

## Timeline chains

The optional `follows` field links an entry to the earlier entries it develops
or settles, forming a chain per evolving matter. Everything else is derived at
read time, so there is nothing to keep in sync:

- Recall and query hits carry chain context. Stale members are annotated
  `⤷ superseded by: <id>`, still-current members with later additions get
  `↳ extended by: <id>`, and pending decisions and todos report `status: open`
  or `status: resolved by <id>` — in `--format json` too.
- Ranking gets a mild recency boost (at most +2%, decaying over roughly three
  months), so newer entries win near-ties without burying strong older matches.
- A successor of the same type supersedes; a decision closing an open item
  resolves it; a meeting after a decision merely *extends* it and the decision
  stays current.
- `memory maintenance` reports **dangling links** — a `follows` pointing at an
  id that no longer exists — so a broken chain never goes unnoticed.
- The UI shows each chained entry's full timeline in its detail panel, and the
  graph view draws chains as dashed edges.

![Entry detail showing a timeline from pending-decision to the decision that settled it](assets/ui-chain.png)

The practical effect: an old snapshot cannot masquerade as the current state.

## Retrieval

The index combines:

- local embeddings via Transformers.js (`Xenova/bge-small-en-v1.5` by default)
- LanceDB for vector search
- persistent BM25 lexical search
- reciprocal rank fusion
- metadata prefilters and source-of-truth validation

`recall` additionally expands your question into several phrasings, fuses them
into one ranking, and — for small candidate sets — guarantees it considered
everything rather than sampling. An optional local cross-encoder rerank
(`--rerank`) adds a second pass.

Indexing embeds in batches of 64, one model call per batch
(`MEMORY_EMBED_BATCH=<n>` to change it), so peak memory stays bounded as the
store grows.

## Connectors

`connectors/<name>.md` files carry fetch config in frontmatter and the
extraction prompt in the body. They are generic templates; a private override
at `memory/connectors/<name>.md` (gitignored) replaces its template entirely.
Personalization — real queries, channel ids, names — belongs only in the
override. `memory connectors` lists and validates what resolved.

Reference sources work the same way and are documented separately in
[reference-sources.md](reference-sources.md).
