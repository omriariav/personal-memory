# Upgrading an existing store

Pulling new code onto a machine with an existing store is safe by construction:
every store is gitignored and versioned in its own nested repo, so `git pull`
cannot touch a single entry file, and **every existing memory stays exactly
where it is** — membership is derived from file locations, so nothing inside
`memory/` needs migrating or reclassifying.

Take a backup first anyway; it is good practice before any migration:

```bash
tar -czf ~/memory-backup-$(date +%Y%m%d).tgz memory memory-public memory-graphs 2>/dev/null \
  || tar -czf ~/memory-backup-$(date +%Y%m%d).tgz memory
```

Then run the (idempotent) migration — the engine refuses to run on an old
layout until it has:

```bash
git pull
npx tsx scripts/migrate-graphs.ts
```

## The all-in-one wrapper

```bash
./scripts/migrate.sh
```

It creates and verifies a private backup, fast-forwards from the configured
upstream when possible, installs dependencies, runs the migration, and prints
the resulting graph registry. It never pushes commits or memory data to a
remote. `./scripts/migrate.sh --help` lists options such as `--no-update`,
`--skip-install`, and a custom backup directory.

Keep this wrapper as the stable entry point for future migrations: new steps
can be added behind the same backup-first command instead of requiring a new
upgrade sequence for every release.

## What the backup contains

The complete graph-store layout: `memory/`, the legacy `memory-public/` store
when present, and every named graph under `memory-graphs/`. It also preserves
the `.index/` files no rebuild can recreate — connector timestamps,
promotion/chain/slug dismissals, deferred slug proposals,
`maintenance-state.json`, `graph-maintenance.json`, and the `active.json` that
names the active index slot. Search tables and caches remain rebuildable.

A restored `active.json` naming a slot that was not in the archive falls back to
the legacy root index with a warning until
`npx tsx src/cli.ts index --build <slot>` rebuilds it.

Validate or restore an archive with:

```bash
./scripts/restore_backup.sh ../personal-memory-backups/personal-memory-<timestamp>.tgz --dry-run
./scripts/restore_backup.sh ../personal-memory-backups/personal-memory-<timestamp>.tgz --confirm
```

Restore validates paths and archive integrity before replacing anything, makes
another verified backup of the current stores and workflow state, and restores
the archive as one complete layout. For the current layout it rebuilds the
derived index when Node.js 20+ and local dependencies are available; otherwise
it prints the commands to run later. If a later step fails, it rolls the
original stores and complete prior index back automatically. An archive
containing the legacy `memory-public/` layout is restored exactly without an
index rebuild — the CLI stays unavailable until that layout is migrated again
with `./scripts/migrate.sh`.

## What the migration does

- **From the original single-graph layout** (just `memory/`): nothing
  relocates — all your memories are in the `default` graph by construction. The
  script checkpoints `memory/.git` and rebuilds the search index (the new format
  has a membership column; a few minutes, once).
- **From the two-graph layout** (`memory-public/` exists): if it holds entries,
  the script relocates it to `memory-graphs/public/` — a plain directory rename,
  its git history moves with it — and writes it a `GRAPH.md` manifest.
  Afterwards `public` is an ordinary named graph like any you create yourself,
  deletable anytime via the Graphs screen or
  `memory graphs delete public --confirm`. An empty public store is simply
  dropped; no graph ships by default.
- Re-running the script is always a no-op; it finishes with a consistency check
  (`memory graphs sync --dry-run`).

## Distribution rules now propose instead of publishing

If you have standing distribution rules, they change behaviour on this
upgrade. A rule used to copy a matching entry into its graph at capture time.
It now queues that entry as a candidate, and nothing reaches the shared graph
until you approve it.

Nothing already copied is touched — existing memberships stay exactly as they
are. What changes is everything from here on:

- A capture matching a rule prints `→ rule: queued …` instead of
  `→ rule: copied …`.
- `memory rules apply` backfills into the queue rather than copying, and its
  `--dry-run` says "would queue".
- `memory add --graph <name>` captures the memory in your default graph and
  queues it for `<name>`, where before it wrote into that graph and nowhere
  else. Entries created the old way have no private home; `memory graphs
  sync` already reports those, and `memory move <id> --to default` brings one
  back.

Nothing is required of you. To see what is waiting:

```bash
memory queue list
```

and work through it there or on the Manage Graphs screen.

## Vocabulary changes

- The home graph is now named `default` (`--graph private` is now
  `--graph default`).
- `promote` and `recall-graph` take an explicit graph name.
- The routing prompt is gone — per-graph eligibility criteria live in each
  graph's `GRAPH.md`.
- Marketplace/plugin users: update the clone `MEMORY_HOME` points at before
  using the `graphs`/`copy`/`rules` commands.

## Switching to the next-format index

Stores above roughly 2,000 entries benefit from the new-format index: metadata
and a pre-tokenized lexical column live in catalog tables, so a command filters
and ranks without re-parsing every file and reads bodies only for its hits. It is
never built in place and never forced — an existing store keeps reading its
legacy index until you activate a slot:

```bash
npx tsx src/cli.ts index --build next            # complete second index beside the current one; existing vectors reused
npx tsx src/cli.ts recall "…" --index-slot next  # try it (MEMORY_INDEX_SLOT=next does the same for every command)
npx tsx src/cli.ts index slots                   # what exists, and which slot is active
npx tsx src/cli.ts index --activate next         # switch; the old index stays as 'previous'
npx tsx src/cli.ts index --activate previous     # roll back any time
npx tsx src/cli.ts index --prune --confirm       # once satisfied: drop the non-active slots' derived artifacts
```

**Fresh stores start on the new format.** A tree with no `.index/` at all is
built straight into `.index/slots/main/` (no `active.json`, no legacy root), so
its `meta.json` lives at `.index/slots/main/meta.json`, not `.index/meta.json`.
Anything embedding the CLI should not poll the root file: ask `memory index
slots`, `memory maintenance`, or `indexStatus()` — which report the resolved slot
and whether it is built — instead of a fixed path. Only stores that already had a
legacy root keep it as the default until a slot is activated.

The gain is on the read path. Writers still parse every entry through the root
parse cache, and the `files` table has no reader yet, so `add` costs the same on
a new-format slot as on the legacy one; a scoped writer sync that reads that
table to decide what changed is the planned follow-up.

Writers (`add`, `copy`/`move`/`remove`/`link`, slug merges) keep every built slot
in sync, so `next` never goes stale while you compare. Reads refuse a new-format
slot that has no index yet rather than answering from nothing;
`npx tsx src/cli.ts index` builds it. `--prune` never touches the judgment
sidecars at the `.index/` root, and refuses the active slot.
`./scripts/migrate.sh --build-next-index` builds the slot as part of a
backup-first upgrade and never activates it. `memory maintenance` lists the slots
and prints a one-line hint when the store is large and only the legacy index
exists.

New-format slots score their lexical leg exactly like the legacy index by
default. `MEMORY_LEXICAL=fts` swaps in LanceDB's full-text index, which is faster
but not yet rank-identical — the measurements and the decision are in
[eval/fts-spike.md](eval/fts-spike.md).
