# Contributing

Thanks for improving Personal Memory. Bug reports, documentation fixes, UI
polish, retrieval improvements, connector templates, and agent-workflow
improvements are welcome.

## Ground Rules

- Preserve the local-first default. Do not make a hosted database, hosted vector
  store, or remote embedding provider required for normal use.
- Do not commit personal memory data. Keep `memory/`, `.index/`, model caches,
  connector overrides, tokens, and account-specific configuration out of source.
- Use the CLI for memory entries. Do not hand-create or edit files under
  `memory/entries/`; see [MEMORY-GUARDRAILS.md](MEMORY-GUARDRAILS.md).
- Keep PRs focused. One behavior change or documentation topic per PR is easier
  to review.
- Be respectful and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before You Start

Open an issue for large behavior changes, retrieval changes, schema changes, or
new connector patterns. Small typo fixes and broken-link fixes can go straight
to a pull request.

Good issues describe:

- what problem you hit
- what you expected to happen
- what happened instead
- the command or workflow involved
- whether private data was removed from examples

## How the project is laid out

```text
src/                      CLI, indexing, schema, server and UI APIs
src/ui/                   the local browser UI
src/*.test.ts             unit tests, run by `npm test`
skills/                   agent skills for capture, recall and pull workflows
connectors/               public connector templates
sources/                  public reference-source templates (all ship disabled)
scripts/                  migration, backup/restore, eval and shell tests
docs/                     user documentation and README assets
memory/                   your DEFAULT graph (gitignored, its own nested repo)
memory-graphs/            named SHARED graphs (gitignored, each its own repo)
.index/                   rebuildable local index (gitignored)
```

Where things live, roughly:

- **Command dispatch** is one switch in `src/cli.ts`; each `cmdX` function sits
  below it.
- **Retrieval** is the embedding, lexical and fusion code plus
  `src/index-slots.ts` for the index-slot machinery.
- **Graph membership and containment** are in `src/graphs.ts`; the containment
  guard that keeps a shared graph self-contained is enforced on the write paths
  in `src/cli.ts`.
- **Entry shape** is `src/schema.ts` — adding a field starts there.
- **Agent behavior** is mostly not code: `AGENTS.md`, `CLAUDE.md`, the
  `skills/` directory and the hooks in `.claude/`.

[docs/concepts.md](docs/concepts.md) explains the data model these files
implement.

## Development Workflow

```bash
git clone https://github.com/vladimanaev/personal-memory.git
cd personal-memory
npm install
npm run typecheck
npm test
```

`npm test` runs the unit tests plus the shell suites for the migration scripts,
the memory guardrails, the auto-commit hook and `memui`. Both it and
`npm run typecheck` should pass before you open a PR.

Useful commands:

```bash
npm run memory -- help
npm run memory -- connectors
npm run index
npm start
npm run eval            # retrieval quality against a committed baseline
```

For UI changes, run `npm start` and check the app locally at
`http://127.0.0.1:4664`.

Work against a throwaway store rather than your own record:

```bash
./docs/assets/demo-seed.sh /tmp/pm-dev   # ~15 invented entries, two timeline chains
cd /tmp/pm-dev && npx tsx /path/to/repo/src/cli.ts recall "..."
```

The CLI roots everything at the current working directory, so running it from
that directory keeps your real memories out of the loop entirely.

## Good first contributions

- Documentation gaps: anything in `docs/` that didn't answer your question.
- Connector templates for a source that isn't covered yet, written generically
  with no personal queries, channels or names.
- UI polish against the design tokens in `DESIGN.md` — the brief is calm and
  editorial, not dashboard.
- Retrieval evaluation: add cases to the eval corpus and show the before/after
  from `npm run eval`.
- README and docs assets — regeneration instructions are in
  [docs/assets/README.md](docs/assets/README.md); they must come from the
  synthetic demo store, never a real one.

## Pull Request Checklist

- [ ] The change is focused and explained.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] README or docs are updated for user-facing changes.
- [ ] No personal memory data, private connector overrides, `.index/`, model
      caches, credentials, or screenshots with private data are included.
- [ ] Changes to capture or recall behavior preserve CLI-based memory access.
- [ ] New connector templates avoid personal queries, channels, names, or IDs.

## Privacy Review

Before opening a PR, run:

```bash
git status --short
git diff --cached --stat
```

Make sure the staged files are source, docs, or sanitized assets only.
