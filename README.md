<p align="center">
  <img src="docs/assets/memory-graph.png" alt="Sanitized Personal Memory graph view" width="900">
</p>

<h1 align="center">Personal Memory</h1>

<p align="center">
  <strong>Local-first memory for your working life.</strong><br>
  Private by default, shareable on purpose.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen">
  <img alt="Local-first" src="https://img.shields.io/badge/data-stays%20on%20your%20disk-0b0b0b">
</p>

---

Six months of work produces context that never fits in chat history: who said
what in a 1:1, why a decision went the way it did, what the last incident
actually taught you, which hiring thread is still open.

Personal Memory keeps that record on your own disk as Markdown, and gives your
coding agent a grounded way to write to it and recall from it. There is no SDK
to integrate and no service to sign up for — you talk to the agent you already
have open.

<p align="center">
  <img src="docs/assets/ask-claude.gif" alt="A Claude Code session answering a question about a past decision, citing the memory entries it read" width="900">
</p>

That is the whole interface. You ask in plain language, the agent loads the
recall skill, runs the retrieval and answers from dated entries it cites.

Notice what it does with the question. That decision was settled in April and
then re-opened and settled again in October, and the record knows — so the
answer is the current state, with the history attached, rather than whichever
note happened to match the words you used.

## Private by default

Your working record is the most sensitive material you would ever give an AI.
So none of it leaves:

- Every capture lands in `memory/`, ignored by this repository and versioned in
  its own local git repo. `git pull` on the project cannot touch an entry.
- Embeddings run on your machine (`Xenova/bge-small-en-v1.5`). No API backend is
  used unless you deliberately set `MEMORY_EMBEDDINGS`.
- The UI binds to `127.0.0.1`.
- `.index/` is derived state and can be deleted and rebuilt at any time.
- No account, no hosted tier, no telemetry, nothing to opt out of.

Don't publish a populated `memory/` directory, or screenshots of one, unless
you have intentionally sanitized them.

## Shareable on purpose

Eventually you want someone to have *part* of the record — a team, a successor,
the person taking over a project. The hard part of sharing memory is not sending
it. It's knowing that what you send doesn't leak what you didn't.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-flow-dark.svg">
    <img src="docs/assets/graph-flow-light.svg" alt="Every capture lands in the default graph. Entries you promote are copied into a named shared graph that cannot reference anything you did not promote." width="900">
  </picture>
</p>

A **named graph** is a physically separate directory with its own git repo.
Entries reach one only by your decision — a standing rule for a tag or type, a
promotion review where you confirm entries one at a time, or asking outright
("log this to the platform-team graph"), which writes it there and nowhere
else. The 1:1s, the hiring debriefs and the feedback stay at home unless you
say otherwise.

And a shared graph is **self-contained** — an entry in it may only reference
fellow members. That is enforced on write, not left to discipline:

<p align="center">
  <img src="docs/assets/share-with-claude.gif" alt="A Claude Code session creating a shared graph, copying a decision chain into it, and confirming the private entries were left out" width="900">
</p>

A decision that settles an earlier pending-decision cannot go alone — the CLI
refuses it until its predecessor is a member too, because a reference pointing
out of a shared graph is exactly the kind of leak you cannot spot by reading the
files. The session ends by naming what stayed behind: the 1:1, the hiring
debrief, the feedback.

You hand the directory over yourself: push its repo, or copy it. There is no
sync service in the middle, which is the point.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/vladimanaev/personal-memory.git
cd personal-memory
npm install
claude          # or codex, or whichever agent you use
```

There is no server to start and no commands to learn. Open the folder in your
agent and talk to it — the repo's own instructions teach it the rest:

```text
"Log this 1:1 with Jane: promotion readiness, scope gaps, a follow-up for Friday."
"Remember that the platform team deferred project alpha until Q4."

"What do I know about Jane's promotion readiness?"
"Is the queue technology decision still open?"
"Help me prep for my next 1:1 with Jane."
```

A local UI is there for when you would rather read the record than ask it
questions — `npm start`, then `http://127.0.0.1:4664` — but nothing requires it.

### Or let it fill itself

Capture doesn't have to be something you remember to do. Connectors read Gmail,
Slack and Google Chat, and a scheduled routine can sweep them on an interval —
Claude Code's `/loop` or a scheduled task, Codex's equivalent, or plain `cron`:

```text
"Every 4 hours, pull Gmail and Slack and log anything memory-worthy."
```

Entries dedupe on source ids, so re-reading the same thread updates one entry
instead of piling up copies. Entirely optional: the store works the same if you
only ever talk to it directly.

Full setup, the plugin install that makes this work from *other* repos, and
connector configuration: **[docs/install.md](docs/install.md)**.

## Documentation

| | |
|---|---|
| [docs/install.md](docs/install.md) | Setup, `memui`, plugin install for other repos, connectors |
| [docs/cli.md](docs/cli.md) | Every command, with the flags that matter |
| [docs/concepts.md](docs/concepts.md) | Storage layout, entry schema, graphs, timeline chains, retrieval |
| [docs/reference-sources.md](docs/reference-sources.md) | Optional directory lookups for slug ground truth |
| [docs/upgrading.md](docs/upgrading.md) | Migration, backup and restore, index slots |
| [AGENTS.md](AGENTS.md) | The agent contract — capture, recall, citations |
| [MEMORY-GUARDRAILS.md](MEMORY-GUARDRAILS.md) | Write-safety rules for `memory/` |

Agent skills live in [`skills/`](skills): capture, recall, single-graph recall,
promotion, graph management, tag compaction, connector pulls, and a morning
brief.

## Contributing

Bug reports, docs fixes, UI polish, retrieval improvements and connector
templates are all welcome. The one rule that shapes everything else: **keep it
local-first** — nothing hosted may become required for normal use.

```bash
npm install
npm run typecheck
npm test
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the architecture, the
privacy review every PR goes through, and a few good first issues.

## Community

- Security reports: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- License: [Apache License 2.0](LICENSE)
