# Index Slots, Catalog Seam and LanceDB FTS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one store carry several complete, side-by-side index "slots" (today's `.index/` root stays the untouched legacy slot; new-format slots live in `.index/slots/<name>/`), put every read behind one `Catalog` seam with a `LegacyCatalog` (today's `loadAllEntries` + `lexical.json`) and a `LanceCatalog` (new `entries`/`files` LanceDB tables + a LanceDB full-text index as the lexical leg), and ship `memory index --build|--activate|--prune|slots` so existing users switch only when they choose to.

**Architecture:** `src/index-slots.ts` resolves *which* `.index` directory a command uses (flag → env → `active.json` → legacy root) lazily per call, so `src/ingest.ts`'s module-load capture of `ROOT`/`INDEX_DIR` (the root, where the judgment sidecars live) is untouched. `src/catalog.ts` defines the `Catalog` interface; `LegacyCatalog` wraps today's loaders byte-for-byte, `LanceCatalog` reads two new tables beside `memory.lance` in a slot. `src/slot-build.ts` builds a new-format slot into `slots/<name>__building/` reusing chunk vectors by `(id, hash)` and renames on completion; `syncIndex` keeps every built slot current. Shadow-mode equality (`LegacyCatalog == LanceCatalog`) is tested before any caller is switched; callers then migrate in the order `searchDetailed → cli list/person/digest/promote/rules → membership/graph-maintenance → maintenance → server`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20 (`.nvmrc`), `tsx`, `node:test` + `node:assert/strict`, zod for persisted JSON, `@lancedb/lancedb` `^0.37.1` (FTS with exact top-k, `Index.fts`/`Index.btree`), `gray-matter`, bash for `scripts/migrate.sh`.

**Spec:** `~/.claude/plans/lets-go-over-the-virtual-magpie.md` — Phase 3 items 1, 2 and 5, the "Compatibility & migration policy" section (binding), and Verification item 4 compatibility tests (a)–(f). Spike results: `docs/eval/fts-spike.md` and `scripts/spike-fts.ts`. Excluded (follow-up plans): Phase 3 item 3 (IVF vector index, `MEMORY_VECTOR_INDEX`), item 4 (`report.timings` / `--show-timings`), and the UI slot toggle + Activate button (`server.ts` `GET /api/index/slots`, `POST /api/index/activate`, `app.js`).

## Global Constraints

- Branch: all work on `index-architecture` (already cut from `retrieval-quality`; last commit `67cdbd6`). Never push, never open a PR.
- Node 20: run `source ~/.nvm/nvm.sh && nvm use 20` first in every shell. Run code with `npx tsx …`; one test file with `node --import tsx --test src/<file>.test.ts`.
- After EVERY task: `npm run typecheck`, `npm test` (unit tests + `scripts/migration-scripts.test.sh` + `scripts/memory-guards.test.sh`) and `npm run eval` (synthetic harness vs `docs/eval/baseline-4k.json`, ~30 s) must be green. `npm run eval` metrics may not regress: recall@10, MRR, nDCG@10 within −0.01, no non-xfail case flips to fail.
- NEVER read, grep, ls, cat, find or write anything under `memory/`, `memory-graphs/` or the real `.index/` by hand. Tests use `mkdtempSync` temp roots or `.cache/eval/` corpora only. A PreToolUse hook denies shell commands whose TEXT mentions those paths together with search/write verbs (`grep`, `ls`, `cat`, `find`, `awk`, `>`, `tee `, `cp `, `mv `, `rm `, `touch `; an arrow function `=>` counts as `>`). Put such logic in a script file under the scratchpad and run `node <file>`. Commit messages that mention store paths go through `git commit -F <msgfile>`.
- Commits: explicit `git add <files>` only — never `git add -A` / `git add .`. Never commit anything under `memory/`, `memory-graphs/`, `.index/`, `.cache/`. Review `git status` before every commit.
- Compatibility (binding): source data is never rewritten; no frontmatter/schema change; nothing new is written into `memory-graphs/`. `.index/` changes are additive: today's `.index/` root is the legacy slot and its file shapes (`meta.json {embedderId, dim, indexVersion}`, `memory.lance`, `memory_headers.lance`, `lexical.json`, `entries-cache.json`) are never modified in shape; new-format slots live in `.index/slots/<name>/`; `.index/active.json` selects; the judgment sidecars (`connector-state.json`, `promotion-dismissals.json`, `chain-dismissals.json`, `slug-dismissals.json`, `slug-proposals.json`, `maintenance-state.json`, `graph-maintenance.json`) stay at the `.index/` root, shared by all slots, never pruned. Existing vectors are reused by `(id, hash)`, never re-embedded. `MEMORY_RANK_PROFILE=legacy` on the legacy slot must reproduce today's output byte-for-byte (pinned by the golden fixture in Task 2). `.gitignore` already ignores `.index/` (slots included) — nothing to add.
- Behaviour is pinnable: a fresh clone with an existing v6 `.index/` and no `active.json` runs every command on the legacy root exactly as today. Output changes are additive fields only (`report.index`, `↻ synced slot` lines).
- Code style: match the repo — ESM, `.js` import suffixes, zod schemas for every persisted JSON file, pure functions in their own modules with unit tests, `node:test` + `node:assert/strict`, ALWAYS pass a message to `assert.ok` (a message-less failing `assert.ok` hangs node's source re-parse under tsx). Lance queries that read `_score` must `.select([..., "_score"])` explicitly.
- Tests that need `ROOT`/`INDEX_DIR` rooted at a temp store run the engine in a child process whose cwd is the temp store (pattern: `src/store-headers.test.ts:22-35`), with `MEMORY_EMBEDDINGS=fake` (`FakeEmbedder`, `src/embed.ts:117-132`, deterministic, no model). Pure functions take an explicit `root` parameter and are tested in-process.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/index-slots.ts` | Slot naming/paths, `resolveIndexSlotDetailed`/`resolveIndexDir` (flag → env → `active.json` → default), zod schemas for `active.json`, format-2 `meta.json`, `catalog-manifest.json`, atomic writes, `listSlots`, `PRESERVED_SIDECARS` / `DERIVED_ARTIFACTS`. No LanceDB, no entry loading. |
| Create `src/index-slots.test.ts` | In-process tests over a temp `.index` root. |
| Create `src/test-store.ts` | Shared test helper (not matched by the `*.test.ts` glob): seed a scratch store, run a script in a child process rooted there. |
| Create `src/legacy-golden.test.ts` + `src/fixtures/legacy-golden.json` | Pins today's recall output on a fixed 7-entry store under both ranking profiles (compat tests (a) and (f)). Recorded BEFORE any store change. |
| Modify `src/store.ts` | Lazy slot-aware index dir; `syncIndex` over every built slot; `searchDetailed` consumes a `Catalog`; `indexStatus`/`optimizeIndex` slot-aware. |
| Modify `src/chains.ts:146` | `buildChainIndex` parameter retyped to `ChainSource[]`. |
| Modify `src/schema.ts` | `CatalogEntryRow`, `CatalogFileRow`, `packList`/`unpackList`. |
| Modify `src/ingest.ts:54-63` | `normalizeSourceId` rejects `|`. |
| Create `src/catalog.ts` | `Catalog` interface, `CatalogEntryMeta`, `LegacyCatalog`, `LanceCatalog`, `openCatalog`, `lexicalMode()`. |
| Create `src/catalog-sync.ts` | Row builders, `syncCatalogTables`, `ensureCatalogIndices`, `scanDirMtimes`, manifest read/write, `syncCatalogFromDisk` (no vectors). |
| Create `src/catalog-legacy.test.ts`, `src/catalog-shadow.test.ts` | Legacy adapter tests; shadow-mode equality `LegacyCatalog == LanceCatalog` on a generated corpus (no model). |
| Modify `src/lexical.ts` | `buildLexicalFromTokens` (reference BM25 over the `entries.lex` column). |
| Create `src/slot-build.ts` | `buildSlot` (vectors reused by `(id, hash)`, `__building` rename), `activateSlot`, `pruneSlots`, `slotStatus`. |
| Create `src/slot-build.test.ts`, `src/slot-sync.test.ts`, `src/slot-search-parity.test.ts`, `src/catalog-freshness.test.ts`, `src/slot-activate.test.ts` | Compat tests (b), writer sync, (c), freshness, (d). |
| Modify `src/cli.ts` | `index --build|--dry-run|--force|--rebuild|--reembed|--activate|--prune|--confirm`, `index slots`, `--index-slot` on recall/query/list/person, `↻ synced slot` line, list/person/digest/promote/rules via `Catalog`. |
| Modify `src/recall.ts` | `RecallOptions.slot`, `RecallReport.index`. |
| Modify `scripts/eval-retrieval.ts`, `package.json` | `--index-slot <name>` for the harness; `eval:slot` script. |
| Modify `src/membership.ts`, `src/graph-maintenance.ts` | Reads via `Catalog` (`byIds`, `referrers`, `filter`); `analyzeGraphHygiene`/`slugUsage` accept `SlugSource`. |
| Modify `src/maintenance.ts`, `src/scheduled-maintenance.ts` | Slot status + hint; weekly optimize folds FTS on every built slot. |
| Modify `src/server.ts` | Three `loadAllEntries` reads → `Catalog` (no UI change). |
| Modify `scripts/migration_lib.sh`, `scripts/migrate.sh`, `scripts/migration-scripts.test.sh` | `DURABLE_INDEX_STATE_FILES` extended; `--build-next-index`; test (e). |
| Modify `AGENTS.md`, `README.md`, `MEMORY-GUARDRAILS.md`, `skills/recall-memory/SKILL.md`, `docs/eval/fts-spike.md` | Docs folded into the tasks that need them. |

Code facts every task relies on (cite when in doubt):
- `src/ingest.ts:15-19` — `ROOT = process.cwd()`, `INDEX_DIR = join(ROOT, ".index")` captured at module load; `ENTRY_CACHE_PATH` at `ingest.ts:116` (root artifact, used by `loadEntryFiles` `ingest.ts:143-188`); `groupEntries` `ingest.ts:202-241`; `loadAllEntries` `ingest.ts:244-246`; `entrySearchText` `ingest.ts:278-281`; `hashEntry` `ingest.ts:33-39` (memoized per object via a WeakMap set in `groupEntries` `ingest.ts:237`); `parseEntry` `ingest.ts:96-109` (path-based, no cwd dependency beyond `graphOfPath`).
- `src/graphs.ts:20` — `ROOT = process.cwd()` (no `INDEX_DIR` there); `listGraphStores` `graphs.ts:99-102`; `Store` `graphs.ts:30-37`.
- `src/store.ts:60` `META_PATH`; `store.ts:133` `INDEX_VERSION = 6`; `store.ts:135-152` meta read/write; `store.ts:165-188` `recordsFor`; `store.ts:195-267` `syncIndex`; `store.ts:299-326` headers; `store.ts:342-358` `optimizeIndex`; `store.ts:364-404` `indexStatus`; `store.ts:558-778` `searchDetailed` (entries loaded at `:589`, chain index `:591`, filters `:592`, LanceDB connect `:615`, semantic lists `:625-658`, lexical lists `:661-669`, hydration of hits `:721-757`); `store.ts:802-837` `findSimilar`.
- `src/lexical.ts:13` `LEXICAL_PATH` (root), `:47-51` `tokenize`, `:73-87` `addDoc`/`buildLexical`, `:94-127` `syncLexical`, `:135-140` `ensureLexical`, `:146-168` `bm25Scores` (k1 = 1.5, b = 0.75).
- `src/ranking.ts:11-20` `SearchFilters`, `:39-51` `Rankable`/`Filterable`, `:55-69` `matchesFilters`/`applyFilters`, `:83-93` `whereClause`, `:122-133` `candidatePool`.
- `src/chains.ts:146` `buildChainIndex(entries: MemoryEntry[])` (uses only `id`, `type`, `date`, `updated`, `follows`).
- `src/schema.ts:163-188` `MemoryRecord`, `packSlugs`.
- `src/cli.ts:508-524` `cmdIndex`; `:526-576` `cmdQuery`; `:626-678` `cmdRecall`; `:680-704` `cmdList`; `:706-729` `cmdPerson`; `:731-818` `cmdDigest`; `:820-875` `cmdPromote`; `:877-919` `cmdRules`; `:296-300` `add` sync + output lines; `:1149-1220` `HELP`; `:1222-1255` dispatch.
- `src/maintenance.ts:66-81` index-health block; `src/scheduled-maintenance.ts:12` sidecar path (stays root), `:106-151` `executeMaintenance` → `optimizeIndex`.
- `src/membership.ts:37,87,167,213` `loadAllEntries` reads; `src/graph-maintenance.ts:353,391,448,501` reads, `:221-226` `analyzeGraphHygiene(entries: MemoryEntry[])`, `:79-107` `countByKind`/`slugUsage` (fields `id`, `date`, `people`, `teams`, `tags` only).
- `src/server.ts:80` `apiData`, `:197` `apiGraphs`, `:254` `apiGraphManifest`, `:121` `apiSearch` → `search()`, `:596` warmup.
- `src/graph-rules.ts:60-71` — the zod + `tmp` + `rename` atomic-write pattern to copy.
- `scripts/migration_lib.sh:6-12` `DURABLE_INDEX_STATE_FILES`, `:65-69` the hard-coded archive allow-list (must follow the array); `scripts/migrate.sh:45-68` option parsing, `:169-179` final steps; `scripts/migration-scripts.test.sh:56-71` fixture with a fake `npx` that logs its args to `MIGRATION_NPX_LOG`.
- LanceDB 0.37 API shapes (from `node_modules/@lancedb/lancedb/dist/*.d.ts`): `db.createTable(name, rows)`, `db.openTable`, `db.tableNames()`, `db.dropTable`; `table.add(rows)`, `table.delete(predicate)`, `table.countRows()`, `table.query().where(sql).select([...]).limit(n).toArray()`, `table.query().fullTextSearch(terms, { columns: "lex" })`, `table.createIndex(column, { config: lancedb.Index.fts({...}) | lancedb.Index.btree() })`, `table.listIndices()` → `{ name, indexType, columns }[]`, `table.optimize({ cleanupOlderThan })`, `table.indexStats(name)` → `{ numIndexedRows, numUnindexedRows, indexType }`. FTS index options (spike-validated): `{ baseTokenizer: "whitespace", lowercase: false, stem: false, removeStopWords: false, asciiFolding: false, withPosition: false }`; the default index name for column `lex` is `lex_idx`.

---

### Task 1: `src/index-slots.ts` — slot paths, resolution and persisted schemas

**Files:**
- Create: `src/index-slots.ts`
- Test: `src/index-slots.test.ts`

**Interfaces:**
- Consumes: nothing from the repo (only `node:fs`, `node:path`, `zod`). Deliberately does NOT import `./ingest.js` (so `ingest.ts` can later import it without a cycle); it captures the root the same way `ingest.ts:15-19` does: `INDEX_ROOT = join(process.cwd(), ".index")`.
- Produces (used by every later task):
  ```ts
  export const INDEX_ROOT: string;                 // === ingest.INDEX_DIR
  export const LEGACY_SLOT = "legacy";             // the .index/ root
  export const FRESH_SLOT = "main";                // default slot for a store with no index yet (Task 9 flips the default)
  export const SLOTS_DIRNAME = "slots";
  export const BUILDING_SUFFIX = "__building";
  export const ACTIVE_FILENAME = "active.json";
  export const META_FILENAME = "meta.json";
  export const MANIFEST_FILENAME = "catalog-manifest.json";
  export const CATALOG_VERSION = 1;
  export const RESERVED_SLOT_NAMES: ReadonlySet<string>;  // "legacy", "previous"
  export const PRESERVED_SIDECARS: readonly string[];
  export const DERIVED_ARTIFACTS: readonly string[];
  export const ActiveFileSchema; export type ActiveFile = { slot: string; previous?: string };
  export const SlotMetaSchema; export type SlotMeta = { format: 2; indexVersion: number; embedderId: string; dim: number; catalogVersion: number; vectorIndex: "flat"; headerTable: boolean; lexical: "fts"; builtAt: string };
  export const CatalogManifestSchema; export type CatalogManifest = { catalogVersion: number; generation: number; dirs: Record<string, number>; N: number; avgdl: number; syncedAt: string };
  export type LegacyMeta = { format: 1; embedderId?: string; dim?: number; indexVersion?: number };
  export type IndexMeta = LegacyMeta | SlotMeta;
  export function isSlotName(name: unknown): name is string;
  export function slotDir(slot: string, root?: string): string;        // "legacy" → root, else root/slots/<slot>
  export function buildingDir(slot: string, root?: string): string;    // root/slots/<slot>__building
  export function slotFormat(slot: string): 1 | 2;                     // legacy → 1, everything else → 2
  export function readIndexMetaSync(dir: string): IndexMeta | null;
  export function readActiveSync(root?: string): ActiveFile | null;    // missing → null; invalid → throws
  export async function writeActive(file: ActiveFile, root?: string): Promise<string>;  // tmp + rename
  export function slotExists(slot: string, root?: string): boolean;    // legacy: true; else meta.json present
  export type SlotSource = "override" | "env" | "active" | "previous" | "default";
  export interface SlotResolution { slot: string; dir: string; format: 1 | 2; source: SlotSource; warning?: string }
  export function resolveIndexSlotDetailed(opts?: { override?: string; env?: Record<string, string | undefined>; root?: string }): SlotResolution;
  export function resolveIndexSlot(opts?): string;
  export function resolveIndexDir(opts?): string;
  export interface SlotInfo { name: string; dir: string; format: 1 | 2; built: boolean; building: boolean; active: boolean; previous: boolean }
  export function listSlots(root?: string): SlotInfo[];
  export function listBuiltSlots(root?: string): SlotInfo[];
  ```

- [ ] **Step 1: Write the failing test**

`src/index-slots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DERIVED_ARTIFACTS,
  LEGACY_SLOT,
  PRESERVED_SIDECARS,
  isSlotName,
  listSlots,
  readActiveSync,
  resolveIndexSlotDetailed,
  slotDir,
  writeActive,
} from "./index-slots.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pm-slots-"));
}

function mkSlot(root: string, name: string, meta: Record<string, unknown> = { format: 2, indexVersion: 6, embedderId: "fake:hashed-bag", dim: 64, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-10-01T00:00:00.000Z" }): void {
  mkdirSync(join(root, "slots", name), { recursive: true });
  writeFileSync(join(root, "slots", name, "meta.json"), JSON.stringify(meta));
}

test("resolution: no active.json and no env → the legacy root", () => {
  const root = tempRoot();
  try {
    const r = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual(r, { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: env names a slot that is not built → clear error naming the build command", () => {
  const root = tempRoot();
  try {
    assert.throws(() => resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "nope" } }), /unknown index slot 'nope'.*index --build nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: override beats env beats active.json; all resolve to the slot dir", () => {
  const root = tempRoot();
  try {
    mkSlot(root, "next");
    mkSlot(root, "other");
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next" }));
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).source, "active");
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).dir, join(root, "slots", "next"));
    const viaEnv = resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "other" } });
    assert.deepEqual([viaEnv.slot, viaEnv.source], ["other", "env"]);
    const viaFlag = resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "other" }, override: LEGACY_SLOT });
    assert.deepEqual([viaFlag.slot, viaFlag.dir, viaFlag.format, viaFlag.source], [LEGACY_SLOT, root, 1, "override"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: 'previous' resolves active.previous; active.json pointing at a missing slot falls back to legacy with a warning", () => {
  const root = tempRoot();
  try {
    mkSlot(root, "next");
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next", previous: "legacy" }));
    const prev = resolveIndexSlotDetailed({ root, env: {}, override: "previous" });
    assert.deepEqual([prev.slot, prev.source], [LEGACY_SLOT, "previous"]);
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "gone" }));
    const fallback = resolveIndexSlotDetailed({ root, env: {} });
    assert.equal(fallback.slot, LEGACY_SLOT);
    assert.match(fallback.warning ?? "", /active\.json names slot 'gone'/);
    assert.throws(() => resolveIndexSlotDetailed({ root, env: {}, override: "previous" }), /no previous index slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active.json: atomic write round-trips; a corrupt file throws instead of silently picking a slot", async () => {
  const root = tempRoot();
  try {
    assert.equal(readActiveSync(root), null);
    const path = await writeActive({ slot: "next", previous: LEGACY_SLOT }, root);
    assert.equal(path, join(root, "active.json"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { slot: "next", previous: LEGACY_SLOT });
    assert.deepEqual(readActiveSync(root), { slot: "next", previous: LEGACY_SLOT });
    writeFileSync(path, "{not json");
    assert.throws(() => readActiveSync(root), /active\.json/);
    await assert.rejects(writeActive({ slot: "Bad Name" } as never, root), /slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listSlots: legacy row reflects meta.json presence; built, building and active/previous flags", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(listSlots(root).map((s) => [s.name, s.built, s.active]), [[LEGACY_SLOT, false, true]]);
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
    mkSlot(root, "next");
    mkdirSync(join(root, "slots", "later__building"), { recursive: true });
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next", previous: LEGACY_SLOT }));
    const rows = listSlots(root).map((s) => `${s.name}:${s.format}:${s.built ? "built" : "-"}:${s.building ? "building" : "-"}:${s.active ? "active" : "-"}:${s.previous ? "prev" : "-"}`);
    assert.deepEqual(rows, ["legacy:1:built:-:-:prev", "later:2:-:building:-:-", "next:2:built:-:active:-"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names: slotDir maps legacy to the root and rejects invalid or reserved names", () => {
  assert.equal(slotDir(LEGACY_SLOT, "/r/.index"), "/r/.index");
  assert.equal(slotDir("next", "/r/.index"), "/r/.index/slots/next");
  assert.throws(() => slotDir("Next", "/r/.index"), /invalid index slot name/);
  assert.throws(() => slotDir("x__building", "/r/.index"), /invalid index slot name/);
  assert.equal(isSlotName("previous"), false);
  assert.ok(PRESERVED_SIDECARS.includes("active.json"), "active.json is a preserved sidecar");
  assert.ok(DERIVED_ARTIFACTS.every((f) => !PRESERVED_SIDECARS.includes(f)), "derived and preserved sets are disjoint");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && node --import tsx --test src/index-slots.test.ts`
Expected: FAIL — `Cannot find module './index-slots.js'`.

- [ ] **Step 3: Write the implementation**

`src/index-slots.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Index slots: `.index/` root = the legacy slot (today's files, never changed
 * in shape); `.index/slots/<name>/` = a complete self-contained new-format
 * index; `.index/active.json` names the active one (absent ⇒ legacy root).
 * Judgment sidecars always stay at the root, shared by every slot.
 *
 * Resolution is LAZY (a function, not a module constant) so `--index-slot`
 * parsed into MEMORY_INDEX_SLOT after the store module loaded still applies,
 * while the root itself is captured at load exactly like ingest.ts:15-19.
 */
export const INDEX_ROOT = join(process.cwd(), ".index");
export const LEGACY_SLOT = "legacy";
export const FRESH_SLOT = "main";
export const SLOTS_DIRNAME = "slots";
export const BUILDING_SUFFIX = "__building";
export const ACTIVE_FILENAME = "active.json";
export const META_FILENAME = "meta.json";
export const MANIFEST_FILENAME = "catalog-manifest.json";
export const CATALOG_VERSION = 1;

const SLOT_RE = /^[a-z0-9][a-z0-9-]*$/;
export const RESERVED_SLOT_NAMES: ReadonlySet<string> = new Set([LEGACY_SLOT, "previous"]);

/** Judgment sidecars: always at the .index/ root, shared by every slot, never pruned. */
export const PRESERVED_SIDECARS: readonly string[] = Object.freeze([
  "connector-state.json",
  "promotion-dismissals.json",
  "chain-dismissals.json",
  "slug-dismissals.json",
  "slug-proposals.json",
  "maintenance-state.json",
  "graph-maintenance.json",
  ACTIVE_FILENAME,
]);

/** Rebuildable artifacts of the legacy root slot — the only root paths `--prune` may delete. */
export const DERIVED_ARTIFACTS: readonly string[] = Object.freeze([
  "memory.lance",
  "memory_headers.lance",
  "lexical.json",
  "entries-cache.json",
  META_FILENAME,
]);

const slotName = z.string().regex(SLOT_RE, "must be a lower-kebab slot name");

export const ActiveFileSchema = z.object({ slot: slotName, previous: slotName.optional() }).strict();
export type ActiveFile = z.infer<typeof ActiveFileSchema>;

export const SlotMetaSchema = z
  .object({
    format: z.literal(2),
    indexVersion: z.number().int(),
    embedderId: z.string().min(1),
    dim: z.number().int().positive(),
    catalogVersion: z.number().int(),
    vectorIndex: z.enum(["flat"]),
    headerTable: z.boolean(),
    lexical: z.enum(["fts"]),
    builtAt: z.string().min(1),
  })
  .strict();
export type SlotMeta = z.infer<typeof SlotMetaSchema>;

export const CatalogManifestSchema = z
  .object({
    catalogVersion: z.number().int(),
    generation: z.number().int().nonnegative(),
    /** store-relative dir → mtimeMs, for the read-path freshness check. */
    dirs: z.record(z.string(), z.number()),
    N: z.number().int().nonnegative(),
    avgdl: z.number().nonnegative(),
    syncedAt: z.string().min(1),
  })
  .strict();
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>;

export type LegacyMeta = { format: 1; embedderId?: string; dim?: number; indexVersion?: number };
export type IndexMeta = LegacyMeta | SlotMeta;

export function isSlotName(name: unknown): name is string {
  return typeof name === "string" && SLOT_RE.test(name) && !name.endsWith(BUILDING_SUFFIX) && !RESERVED_SLOT_NAMES.has(name);
}

export function slotDir(slot: string, root: string = INDEX_ROOT): string {
  if (slot === LEGACY_SLOT) return root;
  if (!isSlotName(slot)) {
    throw new Error(`invalid index slot name '${slot}' — lower-kebab (a-z, 0-9, -), not 'legacy'/'previous', not ending in ${BUILDING_SUFFIX}`);
  }
  return join(root, SLOTS_DIRNAME, slot);
}

export function buildingDir(slot: string, root: string = INDEX_ROOT): string {
  return `${slotDir(slot, root)}${BUILDING_SUFFIX}`;
}

export function slotFormat(slot: string): 1 | 2 {
  return slot === LEGACY_SLOT ? 1 : 2;
}

export function readIndexMetaSync(dir: string): IndexMeta | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, META_FILENAME), "utf8");
  } catch {
    return null;
  }
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data && data.format === 2) return SlotMetaSchema.parse(data);
  // Legacy shape: missing fields are defaults; never fail on an old file.
  const meta: LegacyMeta = { format: 1 };
  if (typeof data?.embedderId === "string") meta.embedderId = data.embedderId;
  if (typeof data?.dim === "number") meta.dim = data.dim;
  if (typeof data?.indexVersion === "number") meta.indexVersion = data.indexVersion;
  return meta;
}

export function readActiveSync(root: string = INDEX_ROOT): ActiveFile | null {
  const path = join(root, ACTIVE_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid ${path}: ${err instanceof Error ? err.message : String(err)} — delete it to fall back to the legacy root`);
  }
  const parsed = ActiveFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`invalid ${path}:\n` + parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
  }
  return parsed.data;
}

export async function writeActive(file: ActiveFile, root: string = INDEX_ROOT): Promise<string> {
  const parsed = ActiveFileSchema.parse(file);
  await mkdir(root, { recursive: true });
  const path = join(root, ACTIVE_FILENAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return path;
}

export function slotExists(slot: string, root: string = INDEX_ROOT): boolean {
  if (slot === LEGACY_SLOT) return true;
  if (!isSlotName(slot)) return false;
  return existsSync(join(slotDir(slot, root), META_FILENAME));
}

export type SlotSource = "override" | "env" | "active" | "previous" | "default";

export interface SlotResolution {
  slot: string;
  dir: string;
  format: 1 | 2;
  source: SlotSource;
  /** Set when active.json named a slot that is missing on disk (legacy fallback). */
  warning?: string;
}

/** `--index-slot` → MEMORY_INDEX_SLOT → active.json → the legacy root. */
export function resolveIndexSlotDetailed(
  opts: { override?: string; env?: Record<string, string | undefined>; root?: string } = {},
): SlotResolution {
  const root = opts.root ?? INDEX_ROOT;
  const env = opts.env ?? process.env;
  const active = readActiveSync(root);
  const explicit = opts.override || env.MEMORY_INDEX_SLOT || undefined;
  if (explicit !== undefined) {
    let name = explicit;
    let source: SlotSource = opts.override ? "override" : "env";
    if (name === "previous") {
      if (!active?.previous) throw new Error("no previous index slot is recorded in .index/active.json");
      name = active.previous;
      source = "previous";
    }
    if (name !== LEGACY_SLOT && !isSlotName(name)) {
      throw new Error(`invalid index slot name '${name}'`);
    }
    if (!slotExists(name, root)) {
      throw new Error(`unknown index slot '${name}' — build it with: npx tsx src/cli.ts index --build ${name}   (index slots lists what exists)`);
    }
    return { slot: name, dir: slotDir(name, root), format: slotFormat(name), source };
  }
  if (active) {
    if (slotExists(active.slot, root)) {
      return { slot: active.slot, dir: slotDir(active.slot, root), format: slotFormat(active.slot), source: "active" };
    }
    return {
      slot: LEGACY_SLOT,
      dir: root,
      format: 1,
      source: "default",
      warning: `active.json names slot '${active.slot}' which is missing on disk — using the legacy root index (rebuild with: npx tsx src/cli.ts index --build ${active.slot})`,
    };
  }
  return { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" };
}

export function resolveIndexSlot(opts?: Parameters<typeof resolveIndexSlotDetailed>[0]): string {
  return resolveIndexSlotDetailed(opts).slot;
}

export function resolveIndexDir(opts?: Parameters<typeof resolveIndexSlotDetailed>[0]): string {
  return resolveIndexSlotDetailed(opts).dir;
}

export interface SlotInfo {
  name: string;
  dir: string;
  format: 1 | 2;
  /** meta.json present (a complete index). */
  built: boolean;
  /** A `<name>__building` directory (an interrupted build; discarded by the next build). */
  building: boolean;
  active: boolean;
  previous: boolean;
}

export function listSlots(root: string = INDEX_ROOT): SlotInfo[] {
  const active = readActiveSync(root);
  const current = active && slotExists(active.slot, root) ? active.slot : LEGACY_SLOT;
  const rows: SlotInfo[] = [
    {
      name: LEGACY_SLOT,
      dir: root,
      format: 1,
      built: existsSync(join(root, META_FILENAME)),
      building: false,
      active: current === LEGACY_SLOT,
      previous: active?.previous === LEGACY_SLOT,
    },
  ];
  const slotsDir = join(root, SLOTS_DIRNAME);
  if (existsSync(slotsDir)) {
    for (const ent of readdirSync(slotsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const building = ent.name.endsWith(BUILDING_SUFFIX);
      const name = building ? ent.name.slice(0, -BUILDING_SUFFIX.length) : ent.name;
      if (!isSlotName(name)) continue;
      rows.push({
        name,
        dir: join(slotsDir, ent.name),
        format: 2,
        built: !building && existsSync(join(slotsDir, ent.name, META_FILENAME)),
        building,
        active: !building && current === name,
        previous: !building && active?.previous === name,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function listBuiltSlots(root: string = INDEX_ROOT): SlotInfo[] {
  return listSlots(root).filter((s) => s.built);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/index-slots.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Typecheck, full tests, commit**

Run: `npm run typecheck && npm test`
Expected: green (no caller changed).

```bash
git add src/index-slots.ts src/index-slots.test.ts
git commit -m "Index slots: lazy slot resolution, active/meta/manifest schemas, preserved vs derived constants"
```

---

### Task 2: Pin today's output — the legacy golden fixture (compat tests (a) and (f))

Recorded on the current commit BEFORE any store change, so every later task can prove the legacy slot still produces byte-identical results.

**Files:**
- Create: `src/test-store.ts` (shared helper, not a test)
- Create: `src/legacy-golden.test.ts`
- Create: `src/fixtures/legacy-golden.json` (generated by the test with `UPDATE_GOLDEN=1`)

**Interfaces:**
- Consumes: `src/recall.ts` `recall(positionals, opts)`; `src/store.ts` `syncIndex`; `FakeEmbedder` via `MEMORY_EMBEDDINGS=fake`.
- Produces:
  ```ts
  // src/test-store.ts
  export const REPO: string;                                   // repo root (dirname of src/)
  export function md(fm: Record<string, unknown>, body: string): string;    // frontmatter + body text
  export interface SeedEntry { id: string; date: string; type: string; title: string; body: string; people?: string[]; teams?: string[]; tags?: string[]; sources?: string[]; follows?: string[]; source_ids?: string[]; graphs?: string[] }
  export const GOLDEN_ENTRIES: SeedEntry[];                    // the 7-entry fixture store
  export function seedStore(root: string, entries?: SeedEntry[]): void;     // writes memory/… and memory-graphs/<g>/… copies
  export function runInStore(cwd: string, script: string, env?: Record<string, string>): unknown;  // child process, JSON of last stdout line
  export function normalizeReport(report: unknown, root: string): unknown;  // absolute temp paths → "<root>/…"
  ```

- [ ] **Step 1: Write the helper and the test**

`src/test-store.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only helpers for integration tests that need the engine rooted at a
 * scratch store. `src/ingest.ts` captures process.cwd() at import time, so
 * the engine runs in a child process whose cwd is the scratch root (pattern
 * from src/store-headers.test.ts). Never used by production code.
 */
export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const STORE_MOD = JSON.stringify(join(REPO, "src", "store.ts"));
export const RECALL_MOD = JSON.stringify(join(REPO, "src", "recall.ts"));

function yamlList(xs: string[]): string {
  return xs.length ? `[${xs.join(", ")}]` : "[]";
}

export function md(fm: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: ${yamlList(v as string[])}` : `${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", body, "");
  return lines.join("\n");
}

export interface SeedEntry {
  id: string;
  date: string;
  type: string;
  title: string;
  body: string;
  people?: string[];
  teams?: string[];
  tags?: string[];
  sources?: string[];
  follows?: string[];
  source_ids?: string[];
  /** Graph memberships; "default" is always the home. Shared copies are byte-identical. */
  graphs?: string[];
}

export const GOLDEN_ENTRIES: SeedEntry[] = [
  { id: "2026-01-01-zebra-migration", date: "2026-01-01", type: "note", title: "Zebra migration plan", people: ["ana-levi"], teams: ["platform"], tags: ["migration"], body: "long body about databases and regions ".repeat(20).trim(), graphs: ["default", "team-x"] },
  { id: "2026-01-02-quokka-budget", date: "2026-01-02", type: "decision", title: "Quokka budget review", people: ["boris-cohen", "ana-levi"], tags: ["budget"], body: "spending and forecasts ".repeat(20).trim(), source_ids: ["slack:C1:1.0"] },
  { id: "2026-01-03-otter-hiring", date: "2026-01-03", type: "hiring", title: "Otter hiring loop", people: ["chen-mizrahi"], teams: ["platform"], body: "interviews and offers ".repeat(20).trim() },
  { id: "2026-01-04-budget-pending", date: "2026-01-04", type: "pending-decision", title: "Budget freeze pending", people: ["boris-cohen"], tags: ["budget"], body: "Should we freeze the budget until the forecast settles?" },
  { id: "2026-01-05-budget-decided", date: "2026-01-05", type: "decision", title: "Budget freeze approved", people: ["boris-cohen"], tags: ["budget"], follows: ["2026-01-04-budget-pending"], body: "Freeze approved: spending paused until the quarterly forecast settles." },
  { id: "2026-01-06-rare-codeword", date: "2026-01-06", type: "event", title: "Rare codeword event", tags: ["needle"], body: "codeword zephyr quokka adopted as the internal protocol name." },
  { id: "summary-tag-budget", date: "2026-01-07", type: "summary", title: "Rolling summary — #budget", people: ["boris-cohen"], tags: ["budget"], sources: ["2026-01-02-quokka-budget", "2026-01-04-budget-pending", "2026-01-05-budget-decided"], body: "## Synthesis\n\nBudget was reviewed, a freeze was proposed and then approved." },
];

function entryFile(e: SeedEntry): string {
  return md(
    { id: e.id, date: e.date, type: e.type, title: e.title, people: e.people ?? [], teams: e.teams ?? [], tags: e.tags ?? [], sources: e.sources, follows: e.follows, source_ids: e.source_ids },
    e.body,
  );
}

export function seedStore(root: string, entries: SeedEntry[] = GOLDEN_ENTRIES): void {
  for (const e of entries) {
    const file = entryFile(e);
    for (const g of e.graphs ?? ["default"]) {
      const store = g === "default" ? join(root, "memory") : join(root, "memory-graphs", g);
      const [y, m] = e.date.split("-");
      const dir = e.type === "summary" ? join(store, "summaries") : join(store, "entries", y!, m!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${e.id}.md`), file, "utf8");
    }
  }
}

/** Run `script` (an async body) in a child process rooted at `cwd`; returns the JSON parsed from the last stdout line. */
export function runInStore(cwd: string, script: string, env: Record<string, string> = {}): unknown {
  const wrapped = `(async () => { ${script} })().catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), "-e", wrapped], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_RANK_PROFILE: "current", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

/** Replace the scratch root in every string so fixtures are machine-independent. */
export function normalizeReport(report: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(report).split(root).join("<root>"));
}
```

`src/legacy-golden.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, RECALL_MOD, STORE_MOD, normalizeReport, runInStore, seedStore } from "./test-store.js";

/**
 * Compatibility pin (spec Phase 3 verification (a) + (f)): on a store whose
 * `.index/` has no active.json, recall output must stay byte-identical to the
 * output recorded before index slots existed, under both ranking profiles.
 * Re-record ONLY when a deliberate output change ships: UPDATE_GOLDEN=1.
 */
const FIXTURE = join(REPO, "src", "fixtures", "legacy-golden.json");
const NOW = Date.UTC(2026, 1, 1);

const QUERIES: { positionals: string[]; opts: Record<string, unknown> }[] = [
  { positionals: ["otter hiring loop"], opts: { k: 5 } },
  { positionals: ["budget review", "spending forecasts"], opts: { filters: { person: "boris-cohen" }, k: 10 } },
  { positionals: ["zebra migration"], opts: { filters: { graph: "team-x" }, k: 5 } },
  { positionals: ["codeword zephyr"], opts: { k: 3, completeness: "none" } },
];

function record(root: string): unknown {
  const out: Record<string, unknown> = {};
  for (const profile of ["current", "legacy"]) {
    out[profile] = runInStore(
      root,
      `const { recall } = await import(${RECALL_MOD});
       const queries = ${JSON.stringify(QUERIES)};
       const reports = [];
       for (const q of queries) reports.push(await recall(q.positionals, { ...q.opts, now: ${NOW} }));
       console.log(JSON.stringify(reports));`,
      { MEMORY_RANK_PROFILE: profile },
    );
  }
  return normalizeReport(out, root);
}

test("legacy slot: recall output is byte-identical to the recorded golden under both profiles", { timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-golden-"));
  try {
    seedStore(root);
    const sync = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`) as { added: number };
    assert.equal(sync.added, 7);
    assert.equal(existsSync(join(root, ".index", "active.json")), false, "a plain sync never writes active.json");
    assert.equal(existsSync(join(root, ".index", "slots")), false, "a plain sync never creates slots/");
    const actual = record(root);
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Record the fixture on the CURRENT commit, then verify it passes**

Run: `mkdir -p src/fixtures && UPDATE_GOLDEN=1 node --import tsx --test src/legacy-golden.test.ts && node --import tsx --test src/legacy-golden.test.ts`
Expected: both runs PASS; `src/fixtures/legacy-golden.json` exists, contains `"current"` and `"legacy"` keys with 4 reports each, no absolute temp path (grep it for `/var/folders` or `/tmp` — must be empty), and every hit's `path` starts with `<root>/`.

- [ ] **Step 3: Sanity-check the fixture content**

Open `src/fixtures/legacy-golden.json` and confirm: query 2 returns `2026-01-05-budget-decided` with `chain.superseded === false` and `2026-01-04-budget-pending` with `chain.status === "resolved"`; query 3's hits all have `graphs` containing `team-x`; query 4 returns `2026-01-06-rare-codeword` first. If any of these does not hold, the seed store is wrong — fix `GOLDEN_ENTRIES`, re-record.

- [ ] **Step 4: Commit**

```bash
git add src/test-store.ts src/legacy-golden.test.ts src/fixtures/legacy-golden.json
git commit -m "Pin today's recall output on the legacy index as a golden fixture (both ranking profiles)"
```

---

### Task 3: Store reads the index dir lazily through the slot resolver

**Files:**
- Modify: `src/store.ts:6` (imports), `:60` (`META_PATH`), `:141-152` (`readMeta`/`writeMeta`), `:200-203`, `:303`, `:320-321`, `:330`, `:346-347`, `:379`, `:615`, `:807` (every `INDEX_DIR` use)
- Modify: `src/chains.ts:60-63`, `:146`
- Test: `src/store-slots.test.ts`

**Interfaces:**
- Consumes: `resolveIndexSlotDetailed`, `META_FILENAME`, `readIndexMetaSync`, `LEGACY_SLOT` from Task 1.
- Produces:
  ```ts
  // store.ts (module-private, but the pattern every later task follows)
  function currentSlot(): SlotResolution;             // resolveIndexSlotDetailed()
  function indexDir(): string;                        // currentSlot().dir
  function metaPath(dir: string): string;
  async function readMeta(dir: string): Promise<IndexMeta | null>;
  async function writeLegacyMeta(dir: string, meta: { embedderId: string; dim: number; indexVersion: number }): Promise<void>;
  // chains.ts
  export type ChainSource = Pick<MemoryEntry, "id" | "type" | "date" | "updated" | "follows">;
  export function buildChainIndex(entries: ChainSource[]): Map<string, ChainAnnotation>;
  ```
  `IndexStatus` gains `slot: string` and `format: 1 | 2` (additive).

- [ ] **Step 1: Write the failing test**

`src/store-slots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_MOD, runInStore, seedStore } from "./test-store.js";

test("store resolves the index dir per call: default = legacy root; an unknown MEMORY_INDEX_SLOT is a clear error", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-store-slots-"));
  try {
    seedStore(root);
    const status = runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log(JSON.stringify(await s.indexStatus()));`) as { slot: string; format: number; indexedEntries: number };
    assert.equal(status.slot, "legacy");
    assert.equal(status.format, 1);
    assert.equal(status.indexedEntries, 7);
    assert.ok(existsSync(join(root, ".index", "meta.json")), "legacy meta.json written at the root");
    assert.throws(
      () => runInStore(root, `const s = await import(${STORE_MOD}); await s.indexStatus();`, { MEMORY_INDEX_SLOT: "nope" }),
      /unknown index slot 'nope'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/store-slots.test.ts`
Expected: FAIL — `status.slot` is `undefined`, and the unknown-slot child exits 0 (no error thrown).

- [ ] **Step 3: Implement**

In `src/store.ts`:

1. Change the ingest import (line 6) to drop `INDEX_DIR`:
   ```ts
   import { chunkEntry, displayChunkText, entrySearchText, hashEntry, headerText, loadAllEntries } from "./ingest.js";
   import { META_FILENAME, readIndexMetaSync, resolveIndexSlotDetailed, type IndexMeta, type SlotResolution } from "./index-slots.js";
   ```
2. Replace `const META_PATH = join(INDEX_DIR, "meta.json");` (line 60) and `readMeta`/`writeMeta` (lines 135-152) with:
   ```ts
   function currentSlot(): SlotResolution {
     return resolveIndexSlotDetailed();
   }
   /** The index directory of the slot this call targets — resolved lazily, never captured at load. */
   function indexDir(): string {
     return currentSlot().dir;
   }
   function metaPath(dir: string): string {
     return join(dir, META_FILENAME);
   }
   async function readMeta(dir: string): Promise<IndexMeta | null> {
     return readIndexMetaSync(dir);
   }
   /** Legacy root meta: shape frozen forever (`{embedderId, dim, indexVersion}`). */
   async function writeLegacyMeta(dir: string, meta: { embedderId: string; dim: number; indexVersion: number }): Promise<void> {
     await mkdir(dir, { recursive: true });
     await writeFile(metaPath(dir), JSON.stringify(meta, null, 2), "utf8");
   }
   ```
   Keep the `IndexMeta` interface removed (the type now comes from index-slots).
3. In `syncIndex` (lines 200-208): `const dir = indexDir(); await mkdir(dir, { recursive: true }); const db = await lancedb.connect(dir); const meta = await readMeta(dir); const embedderChanged = !meta || meta.embedderId !== embedder.id || meta.dim !== embedder.dim; const versionChanged = meta?.indexVersion !== INDEX_VERSION;` and line 264 → `await writeLegacyMeta(dir, { embedderId: embedder.id, dim: embedder.dim, indexVersion: INDEX_VERSION });`.
4. `headerStatus` (line 303), `backfillHeaders` (320-321), `dropHeadersForTest` (330), `optimizeIndex` (346-347), `indexStatus` (379), `searchDetailed` (615), `findSimilar` (807): replace `INDEX_DIR` with a local `const dir = indexDir();` and `lancedb.connect(dir)` / `mkdir(dir, …)`. In `indexStatus` read meta from `dir` and add to `base`: `slot: currentSlot().slot, format: currentSlot().format` (extend the `IndexStatus` interface with `slot: string; format: 1 | 2;`).

In `src/chains.ts`: add after the imports
```ts
/** The slice of an entry the chain index needs — catalogs supply this without bodies. */
export type ChainSource = Pick<MemoryEntry, "id" | "type" | "date" | "updated" | "follows">;
```
retype `function refDate(e: Pick<MemoryEntry, "date" | "updated">)` (line 61) and `export function buildChainIndex(entries: ChainSource[])` (line 146); `byId` becomes `Map<string, ChainSource>`. `entryStatus` keeps `MemoryEntry` (it reads `type` only; leave as is).

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/store-slots.test.ts src/legacy-golden.test.ts && npm run typecheck && npm test && npm run eval`
Expected: all green; eval delta 0 on every metric.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/chains.ts src/store-slots.test.ts
git commit -m "Resolve the index directory lazily through the slot resolver; chain index accepts a body-less source"
```

### Task 4: The `Catalog` seam and `LegacyCatalog`

**Files:**
- Create: `src/catalog.ts`
- Modify: `src/schema.ts` (append `packList`/`unpackList`, `CatalogEntryRow`, `CatalogFileRow`)
- Modify: `src/ingest.ts:54-63` (`normalizeSourceId` rejects `|`)
- Modify: `src/ingest.test.ts` (append one test)
- Test: `src/catalog-legacy.test.ts`

**Interfaces:**
- Consumes: `loadAllEntries`, `hashEntry` (`ingest.ts`); `ensureLexical`, `bm25Scores` (`lexical.ts`); `applyFilters`, `type Filterable`, `type SearchFilters` (`ranking.ts`); `type ChainSource` (Task 3); `resolveIndexSlotDetailed` (Task 1).
- Produces:
  ```ts
  // schema.ts
  export function packList(xs: string[] | undefined): string;   // "|a|b|" or ""
  export function unpackList(s: string): string[];               // "" → []
  export interface CatalogEntryRow { id; date; updated; type; title; people; teams; tags; graphs; follows; sources; source_ids; hash; home_path; paths_json; lex; len: number; chunks: number }  // all strings except len/chunks
  export interface CatalogFileRow { relpath: string; graph: string; id: string; mtimeMs: number; size: number; hash: string }
  // catalog.ts
  export type LexicalMode = "postings" | "fts";
  export function lexicalMode(env?: Record<string, string | undefined>): LexicalMode;  // MEMORY_LEXICAL, default "fts", else throws
  export interface CatalogEntryMeta extends Filterable { title: string; hash: string; path: string; paths: Record<string, string>; sources?: string[]; follows?: string[]; source_ids?: string[] }
  export interface LexicalHit { id: string; score: number }
  export interface Catalog {
    readonly kind: "legacy" | "lance";
    readonly slot: string;
    readonly dir: string;
    readonly format: 1 | 2;
    filter(f: SearchFilters): Promise<CatalogEntryMeta[]>;
    byIds(ids: string[]): Promise<CatalogEntryMeta[]>;
    linked(): Promise<ChainSource[]>;            // every entry that links or is linked to (the chain index input)
    referrers(id: string): Promise<CatalogEntryMeta[]>;   // entries whose follows/sources name `id`
    bySourceIds(ids: string[]): Promise<CatalogEntryMeta[]>;
    count(): Promise<number>;
    all(): Promise<CatalogEntryMeta[]>;          // explicit O(N) metas — maintenance only
    hydrate(metas: CatalogEntryMeta[]): Promise<MemoryEntry[]>;
    lexical(query: string, allowed: Set<string>, limit: number): Promise<LexicalHit[]>;  // best first; Legacy and `postings` return the full scored list (limit is a hint for FTS)
    refresh(): Promise<{ refreshed: boolean }>;
  }
  export function metaOf(e: MemoryEntry): CatalogEntryMeta;
  export class LegacyCatalog implements Catalog { constructor(slot: string, dir: string, opts?: { load?: () => Promise<MemoryEntry[]>; lexicalPath?: string }) }
  export async function openCatalog(opts?: { slot?: string }): Promise<Catalog>;   // format 1 → LegacyCatalog; format 2 → LanceCatalog (Task 5)
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/ingest.test.ts`:

```ts
test("normalizeSourceId: lowercases the scheme and rejects '|' (the catalog's list delimiter)", async () => {
  const { normalizeSourceId } = await import("./ingest.js");
  assert.equal(normalizeSourceId("Slack:C1:1.0"), "slack:C1:1.0");
  assert.throws(() => normalizeSourceId("slack:C1|x"), /must not contain '\|'/);
});
```

`src/catalog-legacy.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "./schema.js";
import { packList, unpackList } from "./schema.js";
import { hashEntry } from "./ingest.js";
import { LegacyCatalog, lexicalMode, metaOf } from "./catalog.js";

function entry(p: Partial<MemoryEntry> & Pick<MemoryEntry, "id">): MemoryEntry {
  return {
    date: "2026-01-01", type: "note", title: p.id, people: [], teams: [], tags: [], body: `body of ${p.id}`,
    path: `/r/memory/entries/2026/01/${p.id}.md`, paths: { default: `/r/memory/entries/2026/01/${p.id}.md` }, graphs: ["default"],
    ...p,
  } as MemoryEntry;
}

const ENTRIES = [
  entry({ id: "a", people: ["ana"], tags: ["budget"], body: "alpha budget review" }),
  entry({ id: "b", date: "2026-02-01", type: "decision", people: ["boris"], follows: ["a"], body: "beta decision on budget" }),
  entry({ id: "c", date: "2026-03-01", type: "summary", sources: ["a"], source_ids: ["slack:C1:1.0"], body: "gamma rollup", graphs: ["default", "team-x"] }),
  entry({ id: "d", people: ["ana"], body: "delta unrelated note" }),
];

function catalog(dir: string): LegacyCatalog {
  return new LegacyCatalog("legacy", dir, { load: async () => ENTRIES, lexicalPath: join(dir, "lexical.json") });
}

test("packList/unpackList round-trip; empty ⇄ ''", () => {
  assert.equal(packList(["a", "b"]), "|a|b|");
  assert.equal(packList([]), "");
  assert.equal(packList(undefined), "");
  assert.deepEqual(unpackList("|a|b|"), ["a", "b"]);
  assert.deepEqual(unpackList(""), []);
});

test("lexicalMode: default fts, postings accepted, anything else rejected", () => {
  assert.equal(lexicalMode({}), "fts");
  assert.equal(lexicalMode({ MEMORY_LEXICAL: "postings" }), "postings");
  assert.throws(() => lexicalMode({ MEMORY_LEXICAL: "bm25" }), /MEMORY_LEXICAL/);
});

test("LegacyCatalog: filter/byIds/linked/referrers/bySourceIds/count/all over the injected entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-cat-legacy-"));
  try {
    const c = catalog(dir);
    assert.equal(await c.count(), 4);
    assert.deepEqual((await c.filter({ person: "ana" })).map((m) => m.id), ["a", "d"]);
    assert.deepEqual((await c.filter({ graph: "team-x" })).map((m) => m.id), ["c"]);
    assert.deepEqual((await c.byIds(["c", "zzz", "a"])).map((m) => m.id), ["a", "c"]);
    assert.deepEqual((await c.linked()).map((m) => m.id).sort(), ["a", "b"]);
    assert.deepEqual((await c.referrers("a")).map((m) => m.id).sort(), ["b", "c"]);
    assert.deepEqual((await c.bySourceIds(["slack:C1:1.0"])).map((m) => m.id), ["c"]);
    assert.deepEqual((await c.bySourceIds([])).length, 0);
    assert.equal((await c.all()).length, 4);
    const meta = (await c.byIds(["a"]))[0]!;
    assert.equal(meta.hash, hashEntry(ENTRIES[0]!));
    assert.ok(!("body" in meta), "metas never carry bodies");
    assert.deepEqual(metaOf(ENTRIES[2]!).sources, ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LegacyCatalog: hydrate returns the SAME entry objects (hash memo intact) and lexical is today's full BM25 list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-cat-legacy-"));
  try {
    const c = catalog(dir);
    const metas = await c.byIds(["b", "a"]);
    const hydrated = await c.hydrate(metas);
    assert.equal(hydrated[0], ENTRIES[1], "identity preserved");
    assert.equal(hydrated[1], ENTRIES[0]);
    const hits = await c.lexical("budget", new Set(["a", "b", "c", "d"]), 1);
    assert.deepEqual(hits.map((h) => h.id), ["b", "a"], "full list despite limit 1: today's lexical leg is never truncated");
    assert.ok(hits[0]!.score > hits[1]!.score, "sorted best first");
    assert.deepEqual((await c.lexical("budget", new Set(["a"]), 10)).map((h) => h.id), ["a"], "restricted to allowed ids");
    assert.deepEqual(await c.refresh(), { refreshed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/catalog-legacy.test.ts src/ingest.test.ts`
Expected: FAIL — `Cannot find module './catalog.js'`; the ingest test fails on the missing `|` rejection.

- [ ] **Step 3: Implement**

`src/schema.ts` — append:

```ts
/**
 * Pipe-delimited list column (same shape as `packSlugs`, for lists whose
 * members are not slugs — source ids, follows, sources). Members must never
 * contain `|`; `normalizeSourceId` enforces that for source ids.
 */
export function packList(xs: string[] | undefined): string {
  return xs?.length ? `|${xs.join("|")}|` : "";
}

export function unpackList(s: string): string[] {
  return s ? s.slice(1, -1).split("|") : [];
}

/** One row per logical entry in a new-format slot's `entries` table (Phase 3 catalog). */
export interface CatalogEntryRow {
  id: string;
  date: string;
  /** ISO date or "" when unset. */
  updated: string;
  type: string;
  title: string;
  people: string;
  teams: string;
  tags: string;
  graphs: string;
  follows: string;
  sources: string;
  source_ids: string;
  hash: string;
  /** Home copy's path, relative to the repo root. */
  home_path: string;
  /** JSON of graph → repo-relative path for every copy. */
  paths_json: string;
  /** Pre-tokenized `entrySearchText` (space-joined `tokenize` output) — the FTS column. */
  lex: string;
  /** Token count (BM25 document length). */
  len: number;
  /** Number of chunk rows this entry has in the `memory` table. */
  chunks: number;
}

/** One row per materialized file in a new-format slot's `files` table. */
export interface CatalogFileRow {
  relpath: string;
  graph: string;
  id: string;
  mtimeMs: number;
  size: number;
  hash: string;
}
```

`src/ingest.ts:54-63` — add the delimiter check:

```ts
export function normalizeSourceId(raw: string): string {
  const s = raw.trim();
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) {
    throw new Error(
      `invalid source id '${raw}' — expected '<scheme>:<rest>', e.g. slack:C123:1700000000.1 or gmail:<thread-id>`,
    );
  }
  if (s.includes("|")) throw new Error(`invalid source id '${raw}' — must not contain '|'`);
  return `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1)}`;
}
```

`src/catalog.ts`:

```ts
import { loadAllEntries, hashEntry } from "./ingest.js";
import { ensureLexical, bm25Scores } from "./lexical.js";
import { applyFilters, type Filterable, type SearchFilters } from "./ranking.js";
import type { ChainSource } from "./chains.js";
import type { MemoryEntry } from "./schema.js";
import { resolveIndexSlotDetailed } from "./index-slots.js";

/**
 * The one read seam over an index slot. `LegacyCatalog` wraps today's
 * loaders (parse everything, BM25 from lexical.json) so the legacy root slot
 * behaves byte-for-byte as before; `LanceCatalog` (catalog-lance.ts) reads the
 * `entries` / `files` tables of a new-format slot. Callers never branch on
 * the format — `openCatalog()` picks the adapter from the slot's meta.json.
 */

export type LexicalMode = "postings" | "fts";

/** MEMORY_LEXICAL: `fts` (LanceDB full-text index, new-format slots) or `postings` (the reference BM25 scorer). */
export function lexicalMode(env: Record<string, string | undefined> = process.env): LexicalMode {
  const raw = env.MEMORY_LEXICAL ?? "fts";
  if (raw === "fts" || raw === "postings") return raw;
  throw new Error(`MEMORY_LEXICAL must be one of fts|postings, got '${raw}'`);
}

/** Everything a read needs about an entry short of its body. */
export interface CatalogEntryMeta extends Filterable {
  title: string;
  hash: string;
  /** Absolute home path. */
  path: string;
  /** graph → absolute path of every copy. */
  paths: Record<string, string>;
  sources?: string[];
  follows?: string[];
  source_ids?: string[];
}

export interface LexicalHit {
  id: string;
  score: number;
}

export interface Catalog {
  readonly kind: "legacy" | "lance";
  readonly slot: string;
  readonly dir: string;
  readonly format: 1 | 2;
  /** Filter-matching entries (SQL prefilter where available; `matchesFilters` is always the authority). */
  filter(f: SearchFilters): Promise<CatalogEntryMeta[]>;
  byIds(ids: string[]): Promise<CatalogEntryMeta[]>;
  /** Every entry that links (`follows`) or is linked to — the complete chain-index input. */
  linked(): Promise<ChainSource[]>;
  /** Entries whose `follows` or `sources` name `id`. */
  referrers(id: string): Promise<CatalogEntryMeta[]>;
  bySourceIds(ids: string[]): Promise<CatalogEntryMeta[]>;
  count(): Promise<number>;
  /** Explicit O(N) over metas — maintenance and audits only. */
  all(): Promise<CatalogEntryMeta[]>;
  /** Full entries (bodies) for exactly these metas, in the same order. */
  hydrate(metas: CatalogEntryMeta[]): Promise<MemoryEntry[]>;
  /**
   * Lexical ranking list for one phrasing, restricted to `allowed`, best
   * first. `limit` bounds an FTS query; the postings scorer returns the full
   * scored list (today's behaviour — RRF sees every scored id).
   */
  lexical(query: string, allowed: Set<string>, limit: number): Promise<LexicalHit[]>;
  /** Bring the catalog up to date with the Markdown on disk (no-op for legacy). */
  refresh(): Promise<{ refreshed: boolean }>;
}

export function metaOf(e: MemoryEntry): CatalogEntryMeta {
  return {
    id: e.id,
    date: e.date,
    ...(e.updated ? { updated: e.updated } : {}),
    type: e.type,
    title: e.title,
    people: e.people,
    teams: e.teams,
    tags: e.tags,
    graphs: e.graphs,
    ...(e.sources ? { sources: e.sources } : {}),
    ...(e.follows ? { follows: e.follows } : {}),
    ...(e.source_ids ? { source_ids: e.source_ids } : {}),
    hash: hashEntry(e),
    path: e.path,
    paths: e.paths,
  };
}

export class LegacyCatalog implements Catalog {
  readonly kind = "legacy" as const;
  readonly format = 1 as const;
  private cache: Promise<MemoryEntry[]> | null = null;

  constructor(
    readonly slot: string,
    readonly dir: string,
    private readonly opts: { load?: () => Promise<MemoryEntry[]>; lexicalPath?: string } = {},
  ) {}

  private entries(): Promise<MemoryEntry[]> {
    if (!this.cache) this.cache = (this.opts.load ?? loadAllEntries)();
    return this.cache;
  }

  private async byId(): Promise<Map<string, MemoryEntry>> {
    return new Map((await this.entries()).map((e) => [e.id, e]));
  }

  async filter(f: SearchFilters): Promise<CatalogEntryMeta[]> {
    return applyFilters(await this.entries(), f).map(metaOf);
  }

  async byIds(ids: string[]): Promise<CatalogEntryMeta[]> {
    const want = new Set(ids);
    return (await this.entries()).filter((e) => want.has(e.id)).map(metaOf);
  }

  async linked(): Promise<ChainSource[]> {
    const entries = await this.entries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const members = new Set<string>();
    for (const e of entries) {
      if (!e.follows?.length) continue;
      members.add(e.id);
      for (const t of e.follows) if (byId.has(t)) members.add(t);
    }
    return entries.filter((e) => members.has(e.id)).map(({ id, type, date, updated, follows }) => ({ id, type, date, ...(updated ? { updated } : {}), ...(follows ? { follows } : {}) }));
  }

  async referrers(id: string): Promise<CatalogEntryMeta[]> {
    return (await this.entries()).filter((e) => (e.follows?.includes(id) ?? false) || (e.sources?.includes(id) ?? false)).map(metaOf);
  }

  async bySourceIds(ids: string[]): Promise<CatalogEntryMeta[]> {
    if (ids.length === 0) return [];
    const want = new Set(ids);
    return (await this.entries()).filter((e) => (e.source_ids ?? []).some((s) => want.has(s))).map(metaOf);
  }

  async count(): Promise<number> {
    return (await this.entries()).length;
  }

  async all(): Promise<CatalogEntryMeta[]> {
    return (await this.entries()).map(metaOf);
  }

  async hydrate(metas: CatalogEntryMeta[]): Promise<MemoryEntry[]> {
    const byId = await this.byId();
    return metas.map((m) => {
      const e = byId.get(m.id);
      if (!e) throw new Error(`catalog: no entry with id '${m.id}'`);
      return e;
    });
  }

  async lexical(query: string, allowed: Set<string>, _limit: number): Promise<LexicalHit[]> {
    const idx = await ensureLexical(await this.entries(), this.opts.lexicalPath);
    return [...bm25Scores(query, idx).entries()]
      .filter(([id]) => allowed.has(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ id, score }));
  }

  async refresh(): Promise<{ refreshed: boolean }> {
    return { refreshed: false };
  }
}

/** Open the catalog of the resolved slot (`--index-slot` → env → active.json → legacy root). */
export async function openCatalog(opts: { slot?: string } = {}): Promise<Catalog> {
  const r = resolveIndexSlotDetailed(opts.slot ? { override: opts.slot } : {});
  if (r.format === 1) return new LegacyCatalog(r.slot, r.dir);
  const { LanceCatalog } = await import("./catalog-lance.js");
  return LanceCatalog.open({ slot: r.slot, dir: r.dir });
}
```

Until Task 5 lands, `./catalog-lance.js` does not exist; `openCatalog` is only reachable for format 2 which nothing can build yet. To keep `tsc` green in this task, create a minimal `src/catalog-lance.ts` now that Task 5 fills in:

```ts
import type { Catalog } from "./catalog.js";

export class LanceCatalog {
  static async open(opts: { slot: string; dir: string }): Promise<Catalog> {
    throw new Error(`index slot '${opts.slot}' (${opts.dir}) is a new-format slot — this build cannot read it yet`);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/catalog-legacy.test.ts src/ingest.test.ts && npm run typecheck && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts src/catalog-lance.ts src/catalog-legacy.test.ts src/schema.ts src/ingest.ts src/ingest.test.ts
git commit -m "Catalog seam: interface, LegacyCatalog over today's loaders, list-column packing, source ids reject the delimiter"
```

---

### Task 5: Catalog tables, `LanceCatalog`, and the shadow-mode equality test

**Files:**
- Create: `src/catalog-sync.ts`
- Replace: `src/catalog-lance.ts`
- Modify: `src/lexical.ts:73-87` (`addDoc` → `addDocTokens`; export `buildLexicalFromTokens`)
- Test: `src/catalog-shadow.test.ts`

**Interfaces:**
- Consumes: `CatalogEntryRow`, `CatalogFileRow`, `packList`, `unpackList`, `packSlugs` (schema); `entrySearchText`, `chunkEntry`, `hashEntry`, `parseEntry`, `groupEntries`, `ROOT` (ingest); `tokenize`, `bm25Scores`, `type LexicalIndex` (lexical); `whereClause`, `applyFilters`, `SLUG_RE` (ranking); `listGraphStores`, `type Store` (graphs); `CatalogManifestSchema`, `MANIFEST_FILENAME`, `CATALOG_VERSION` (index-slots); `Catalog`, `CatalogEntryMeta`, `LexicalHit`, `lexicalMode` (Task 4).
- Produces:
  ```ts
  // lexical.ts
  export function buildLexicalFromTokens(docs: { id: string; hash: string; tokens: string[] }[]): LexicalIndex;
  // catalog-sync.ts
  export const ENTRIES_TABLE = "entries"; export const FILES_TABLE = "files";
  export const FTS_INDEX_OPTIONS: Parameters<typeof lancedb.Index.fts>[0];   // the spike-validated options
  export const META_COLUMNS: readonly string[];   // every CatalogEntryRow column except lex
  export function entryRowFor(e: MemoryEntry, root: string): CatalogEntryRow;
  export function metaFromRow(row: Omit<CatalogEntryRow, "lex">, root: string): CatalogEntryMeta;
  export function likeLiteral(s: string): string;   // '→'' and %/_ → _ (superset match; JS re-checks)
  export async function openCatalogTables(db: lancedb.Connection): Promise<{ entries: lancedb.Table | null; files: lancedb.Table | null }>;
  export async function syncCatalogTables(db: lancedb.Connection, entries: MemoryEntry[], opts: { root: string }): Promise<{ added: number; removed: number; unchanged: number }>;
  export async function ensureCatalogIndices(db: lancedb.Connection): Promise<void>;
  export async function dropCatalogTables(db: lancedb.Connection): Promise<void>;
  export async function scanDirMtimes(stores: Pick<Store, "entriesDir" | "summariesDir">[], root: string): Promise<Record<string, number>>;
  export async function readManifest(dir: string): Promise<CatalogManifest | null>;
  export async function writeManifest(dir: string, m: CatalogManifest): Promise<void>;
  export async function manifestFor(db: lancedb.Connection, dirs: Record<string, number>, previous: CatalogManifest | null): Promise<CatalogManifest>;
  export async function loadEntriesFromDisk(stores: Store[]): Promise<MemoryEntry[]>;  // parseEntry + groupEntries, no entries-cache.json
  export async function syncCatalogFromDisk(db: lancedb.Connection, dir: string, opts: { root: string; stores: Store[] }): Promise<{ added: number; removed: number; unchanged: number }>;  // catalog tables + manifest only, never vectors
  // catalog-lance.ts
  export class LanceCatalog implements Catalog {
    static async open(opts: { slot: string; dir: string; root?: string; stores?: Store[]; mode?: LexicalMode; autoRefresh?: boolean }): Promise<LanceCatalog>;
  }
  ```

- [ ] **Step 1: Write the failing shadow test**

`src/catalog-shadow.test.ts` (in-process; no model, no cwd dependency — entries are parsed by path):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { generateCorpus } from "./eval-corpus.js";
import { hashEntry, parseEntry, groupEntries } from "./ingest.js";
import type { MemoryEntry } from "./schema.js";
import type { SearchFilters } from "./ranking.js";
import { LegacyCatalog, type Catalog, type CatalogEntryMeta } from "./catalog.js";
import { LanceCatalog } from "./catalog-lance.js";
import { ensureCatalogIndices, likeLiteral, syncCatalogTables, writeManifest, manifestFor, scanDirMtimes } from "./catalog-sync.js";

/**
 * Shadow mode (spec Phase 3 item 1): before any caller switches, the two
 * adapters must agree on every read over the same corpus — filtered sets,
 * chain-index input, source-id lookups, hydration, and the lexical leg
 * (identical lists under `postings`; rank agreement under `fts`, whose only
 * documented difference is Lance's k1 = 1.2 vs our 1.5 and tie order).
 */

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kendallTauB(a: number[], b: number[]): number {
  let c = 0, d = 0, ta = 0, tb = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i]! - a[j]!);
      const db = Math.sign(b[i]! - b[j]!);
      if (da === 0 && db === 0) continue;
      if (da === 0) ta++;
      else if (db === 0) tb++;
      else if (da === db) c++;
      else d++;
    }
  }
  const denom = Math.sqrt((c + d + ta) * (c + d + tb));
  return denom === 0 ? 1 : (c - d) / denom;
}

async function loadCorpus(root: string): Promise<{ entries: MemoryEntry[]; queries: string[] }> {
  const manifest = await generateCorpus({ root, total: 300, seed: 7, families: ["needle", "filter", "title"] });
  const { readdirSync } = await import("node:fs");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".md")) files.push(p);
    }
  };
  walk(join(root, "memory", "entries"));
  files.sort();
  const parsed = await Promise.all(files.map(parseEntry));
  // Four source ids so bySourceIds has something to find (incl. LIKE metacharacters).
  const sourceIds = ["slack:C1:1700000000.1", "gmail:thread_1", "gmail:100%", "gcal:ev-1"];
  const entries = groupEntries(parsed, "throw").entries.map((e, i) => (i < 4 ? { ...e, source_ids: [sourceIds[i]!] } : e));
  return { entries, queries: manifest.cases.map((c) => c.query) };
}

async function buildLance(entries: MemoryEntry[], root: string, dir: string, mode: "postings" | "fts"): Promise<LanceCatalog> {
  const db = await lancedb.connect(dir);
  await syncCatalogTables(db, entries, { root });
  await ensureCatalogIndices(db);
  const stores = [{ entriesDir: join(root, "memory", "entries"), summariesDir: join(root, "memory", "summaries") }];
  await writeManifest(dir, await manifestFor(db, await scanDirMtimes(stores, root), null));
  return LanceCatalog.open({ slot: "next", dir, root, mode, autoRefresh: false });
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

test("shadow mode: LanceCatalog == LegacyCatalog on a 300-entry synthetic corpus", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-shadow-"));
  try {
    const { entries, queries } = await loadCorpus(root);
    const legacy: Catalog = new LegacyCatalog("legacy", join(root, ".index"), { load: async () => entries, lexicalPath: join(root, ".index", "lexical.json") });
    const lance = await buildLance(entries, root, join(root, ".index", "slots", "next"), "postings");

    assert.equal(await lance.count(), await legacy.count());
    assert.deepEqual(ids(await lance.all()), ids(await legacy.all()));

    // filters: 150 random draws, same shape as src/store-filters.test.ts
    const rand = mulberry32(11);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const people = [...new Set(entries.flatMap((e) => e.people))];
    const tags = [...new Set(entries.flatMap((e) => e.tags))];
    const types = [...new Set(entries.map((e) => e.type))];
    for (let i = 0; i < 150; i++) {
      const f: SearchFilters = {};
      if (rand() < 0.5) f.person = pick(people);
      if (rand() < 0.4) f.tag = pick(tags);
      if (rand() < 0.3) f.type = pick(types);
      if (rand() < 0.4) f.since = pick(["2024-01-01", "2025-06-01"]);
      if (rand() < 0.3) f.until = pick(["2025-01-01", "2026-03-01"]);
      assert.deepEqual(ids(await lance.filter(f)), ids(await legacy.filter(f)), `filter ${JSON.stringify(f)}`);
    }

    // metas are field-identical
    const sample = entries.slice(0, 20).map((e) => e.id);
    assert.deepEqual(await lance.byIds(sample), await legacy.byIds(sample));

    // chain-index input and referrers
    const linkedL = await lance.linked();
    const linkedG = await legacy.linked();
    assert.ok(linkedG.length > 0, "corpus has follows chains");
    assert.deepEqual(linkedL.sort((a, b) => a.id.localeCompare(b.id)), linkedG.sort((a, b) => a.id.localeCompare(b.id)));
    const target = linkedG.find((e) => e.follows?.length)!.follows![0]!;
    assert.deepEqual(ids(await lance.referrers(target)), ids(await legacy.referrers(target)));

    // source ids (including LIKE metacharacters)
    for (const sid of ["slack:C1:1700000000.1", "gmail:thread_1", "gmail:100%", "gmail:thread-1", "nope:x"]) {
      assert.deepEqual(ids(await lance.bySourceIds([sid])), ids(await legacy.bySourceIds([sid])), sid);
    }

    // hydration: same MemoryEntry fields and the same content hash
    const metas = await lance.byIds(sample.slice(0, 5));
    const hydratedL = await lance.hydrate(metas);
    const hydratedG = await legacy.hydrate(metas);
    for (let i = 0; i < metas.length; i++) {
      assert.deepEqual({ ...hydratedL[i] }, { ...hydratedG[i] });
      assert.equal(hashEntry(hydratedL[i]!), metas[i]!.hash);
    }

    // lexical leg, postings mode: identical ranked lists (ids AND scores)
    const allowed = new Set(entries.map((e) => e.id));
    for (const q of queries.slice(0, 60)) {
      const a = await lance.lexical(q, allowed, 40);
      const b = await legacy.lexical(q, allowed, 40);
      assert.deepEqual(a, b, `postings lexical for "${q}"`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shadow mode, fts: Lance full-text ranking agrees with bm25Scores up to the documented k1 difference", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-shadow-fts-"));
  try {
    const { entries, queries } = await loadCorpus(root);
    const legacy = new LegacyCatalog("legacy", join(root, ".index"), { load: async () => entries, lexicalPath: join(root, ".index", "lexical.json") });
    const lance = await buildLance(entries, root, join(root, ".index", "slots", "next"), "fts");
    const allowed = new Set(entries.map((e) => e.id));
    const taus: number[] = [];
    let top1 = 0;
    let compared = 0;
    for (const q of queries.slice(0, 80)) {
      const fts = await lance.lexical(q, allowed, 40);
      const ref = await legacy.lexical(q, allowed, 40);
      if (fts.length < 2 || ref.length === 0) continue;
      compared++;
      assert.ok(fts.length <= 40, "fts honours the limit");
      const refScore = new Map(ref.map((h) => [h.id, h.score]));
      taus.push(kendallTauB(fts.map((h) => refScore.get(h.id) ?? 0), fts.map((h) => h.score)));
      const refMax = ref[0]!.score;
      const refTops = new Set(ref.filter((h) => h.score === refMax).map((h) => h.id));
      if (refTops.has(fts[0]!.id)) top1++;
    }
    assert.ok(compared >= 40, `compared ${compared} phrasings`);
    const meanTau = taus.reduce((s, x) => s + x, 0) / taus.length;
    assert.ok(meanTau >= 0.9, `mean Kendall tau ${meanTau.toFixed(3)} (spike: 0.98)`);
    assert.ok(top1 / compared >= 0.95, `top-1 agreement ${top1}/${compared}`);
    // filtered FTS returns filtered rows only (spike gate 1)
    const f: SearchFilters = { type: "decision" };
    const filtered = new Set((await legacy.filter(f)).map((m) => m.id));
    const hits = await lance.lexical(queries[0]!, filtered, 40);
    assert.ok(hits.every((h) => filtered.has(h.id)), "every FTS hit is inside the filter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("likeLiteral: quotes doubled, LIKE metacharacters widened to a single-char wildcard", () => {
  assert.equal(likeLiteral("it's"), "it''s");
  assert.equal(likeLiteral("100%_x"), "100__x");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/catalog-shadow.test.ts`
Expected: FAIL — `catalog-sync.js` missing / `LanceCatalog.open` throws "cannot read it yet".

- [ ] **Step 3: Implement**

`src/lexical.ts` — replace `addDoc` (lines 73-80) and add the token-based builder:

```ts
function addDocTokens(idx: LexicalIndex, id: string, hash: string, terms: string[]): void {
  const ord = idx.docs.length;
  idx.docs.push({ id, hash, len: terms.length });
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, f] of tf) (idx.postings[t] ??= []).push([ord, f]);
}

function addDoc(idx: LexicalIndex, e: MemoryEntry): void {
  addDocTokens(idx, e.id, hashEntry(e), tokenize(entrySearchText(e)));
}

/** Build the reference BM25 index from pre-tokenized docs (the catalog's `lex` column). */
export function buildLexicalFromTokens(docs: { id: string; hash: string; tokens: string[] }[]): LexicalIndex {
  const idx = emptyIndex();
  for (const d of docs) addDocTokens(idx, d.id, d.hash, d.tokens);
  return idx;
}
```

`src/catalog-sync.ts`:

```ts
import { readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { CATALOG_VERSION, CatalogManifestSchema, MANIFEST_FILENAME, type CatalogManifest } from "./index-slots.js";
import { chunkEntry, entrySearchText, groupEntries, hashEntry, parseEntry } from "./ingest.js";
import { tokenize } from "./lexical.js";
import { packList, packSlugs, unpackList, type CatalogEntryRow, type CatalogFileRow, type MemoryEntry } from "./schema.js";
import type { Store } from "./graphs.js";
import type { CatalogEntryMeta } from "./catalog.js";

/**
 * The two derived tables of a new-format slot, kept beside `memory.lance`:
 *   entries — one row per logical entry (frontmatter, hash, paths, pre-tokenized text)
 *   files   — one row per materialized Markdown file (relpath, mtime, size, hash)
 * Both are rebuilt from the Markdown source of truth; nothing here embeds.
 */
export const ENTRIES_TABLE = "entries";
export const FILES_TABLE = "files";

/** Spike-validated: tokens are exactly `tokenize()` output, so the query is `tokenize(q).join(" ")`. */
export const FTS_INDEX_OPTIONS = {
  baseTokenizer: "whitespace",
  lowercase: false,
  stem: false,
  removeStopWords: false,
  asciiFolding: false,
  withPosition: false,
} as const;

export const META_COLUMNS: readonly string[] = Object.freeze([
  "id", "date", "updated", "type", "title", "people", "teams", "tags", "graphs", "follows", "sources", "source_ids", "hash", "home_path", "paths_json", "len", "chunks",
]);

export function entryRowFor(e: MemoryEntry, root: string): CatalogEntryRow {
  const tokens = tokenize(entrySearchText(e));
  const paths: Record<string, string> = {};
  for (const [g, p] of Object.entries(e.paths)) paths[g] = relative(root, p);
  return {
    id: e.id,
    date: e.date,
    updated: e.updated ?? "",
    type: e.type,
    title: e.title,
    people: packSlugs(e.people),
    teams: packSlugs(e.teams),
    tags: packSlugs(e.tags),
    graphs: packSlugs(e.graphs),
    follows: packList(e.follows),
    sources: packList(e.sources),
    source_ids: packList(e.source_ids),
    hash: hashEntry(e),
    home_path: relative(root, e.path),
    paths_json: JSON.stringify(paths),
    lex: tokens.join(" "),
    len: tokens.length,
    chunks: chunkEntry(e).length,
  };
}

/** Key order matters: `hashEntry` hashes JSON of the frontmatter in zod's schema order (id, date, type, title, people, teams, tags, sources, source_ids, follows). */
export function metaFromRow(row: Omit<CatalogEntryRow, "lex">, root: string): CatalogEntryMeta {
  const sources = unpackList(row.sources);
  const follows = unpackList(row.follows);
  const sourceIds = unpackList(row.source_ids);
  const paths: Record<string, string> = {};
  for (const [g, p] of Object.entries(JSON.parse(row.paths_json) as Record<string, string>)) paths[g] = join(root, p);
  return {
    id: row.id,
    date: row.date,
    ...(row.updated ? { updated: row.updated } : {}),
    type: row.type as MemoryEntry["type"],
    title: row.title,
    people: unpackList(row.people),
    teams: unpackList(row.teams),
    tags: unpackList(row.tags),
    graphs: unpackList(row.graphs),
    ...(sources.length ? { sources } : {}),
    ...(follows.length ? { follows } : {}),
    ...(sourceIds.length ? { source_ids: sourceIds } : {}),
    hash: row.hash,
    path: join(root, row.home_path),
    paths,
  };
}

/** Superset LIKE literal: quotes doubled; `%`/`_` become the single-char wildcard. Callers re-check in JS. */
export function likeLiteral(s: string): string {
  return s.replace(/'/g, "''").replace(/[%_]/g, "_");
}

export async function openCatalogTables(db: lancedb.Connection): Promise<{ entries: lancedb.Table | null; files: lancedb.Table | null }> {
  const names = await db.tableNames();
  return {
    entries: names.includes(ENTRIES_TABLE) ? await db.openTable(ENTRIES_TABLE) : null,
    files: names.includes(FILES_TABLE) ? await db.openTable(FILES_TABLE) : null,
  };
}

function sqlList(ids: string[]): string {
  return ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(", ");
}

async function addRows(db: lancedb.Connection, table: lancedb.Table | null, name: string, rows: Record<string, unknown>[]): Promise<lancedb.Table | null> {
  if (rows.length === 0) return table;
  if (!table) return db.createTable(name, rows);
  await table.add(rows);
  return table;
}

/**
 * Incremental catalog sync: an entry row is replaced when its hash OR its
 * membership changed (copy/move keep the hash — same rule as syncIndex);
 * file rows are replaced for those entries; rows of deleted ids are dropped.
 */
export async function syncCatalogTables(
  db: lancedb.Connection,
  entries: MemoryEntry[],
  opts: { root: string },
): Promise<{ added: number; removed: number; unchanged: number }> {
  let { entries: table, files } = await openCatalogTables(db);
  const existing = new Map<string, { hash: string; graphs: string }>();
  if (table) {
    const rows = (await table.query().select(["id", "hash", "graphs"]).toArray()) as { id: string; hash: string; graphs: string }[];
    for (const r of rows) existing.set(r.id, { hash: r.hash, graphs: r.graphs });
  }
  const wanted = new Set(entries.map((e) => e.id));
  const changed = entries.filter((e) => {
    const cur = existing.get(e.id);
    return cur?.hash !== hashEntry(e) || cur?.graphs !== packSlugs(e.graphs);
  });
  const removedIds = [...existing.keys()].filter((id) => !wanted.has(id));
  const toDelete = [...new Set([...removedIds, ...changed.map((e) => e.id)])];
  if (toDelete.length > 0) {
    for (let i = 0; i < toDelete.length; i += 500) {
      const pred = `id IN (${sqlList(toDelete.slice(i, i + 500))})`;
      if (table) await table.delete(pred);
      if (files) await files.delete(pred);
    }
  }
  const entryRows = changed.map((e) => entryRowFor(e, opts.root) as unknown as Record<string, unknown>);
  const fileRows: Record<string, unknown>[] = [];
  for (const e of changed) {
    const hash = hashEntry(e);
    for (const [graph, path] of Object.entries(e.paths)) {
      const st = await stat(path);
      const row: CatalogFileRow = { relpath: relative(opts.root, path), graph, id: e.id, mtimeMs: st.mtimeMs, size: st.size, hash };
      fileRows.push(row as unknown as Record<string, unknown>);
    }
  }
  table = await addRows(db, table, ENTRIES_TABLE, entryRows);
  files = await addRows(db, files, FILES_TABLE, fileRows);
  return { added: changed.length, removed: removedIds.length, unchanged: entries.length - changed.length };
}

/** FTS on `lex` + btree on id/date/type (entries) and relpath (files). Idempotent; no-op on missing/empty tables. */
export async function ensureCatalogIndices(db: lancedb.Connection): Promise<void> {
  const { entries, files } = await openCatalogTables(db);
  if (entries && (await entries.countRows()) > 0) {
    const have = new Set((await entries.listIndices()).flatMap((i) => i.columns));
    if (!have.has("lex")) await entries.createIndex("lex", { config: lancedb.Index.fts({ ...FTS_INDEX_OPTIONS }) });
    for (const col of ["id", "date", "type"]) {
      if (!have.has(col)) await entries.createIndex(col, { config: lancedb.Index.btree() });
    }
  }
  if (files && (await files.countRows()) > 0) {
    const have = new Set((await files.listIndices()).flatMap((i) => i.columns));
    if (!have.has("relpath")) await files.createIndex("relpath", { config: lancedb.Index.btree() });
  }
}

export async function dropCatalogTables(db: lancedb.Connection): Promise<void> {
  const names = await db.tableNames();
  for (const name of [ENTRIES_TABLE, FILES_TABLE]) if (names.includes(name)) await db.dropTable(name);
}

/** mtimeMs of every entries/, entries/YYYY, entries/YYYY/MM and summaries/ dir per store (store-relative keys). */
export async function scanDirMtimes(stores: Pick<Store, "entriesDir" | "summariesDir">[], root: string): Promise<Record<string, number>> {
  const { readdir } = await import("node:fs/promises");
  const out: Record<string, number> = {};
  const record = async (dir: string) => {
    if (!existsSync(dir)) return;
    out[relative(root, dir)] = (await stat(dir)).mtimeMs;
  };
  for (const s of stores) {
    await record(s.entriesDir);
    await record(s.summariesDir);
    if (!existsSync(s.entriesDir)) continue;
    for (const y of await readdir(s.entriesDir, { withFileTypes: true })) {
      if (!y.isDirectory()) continue;
      const yDir = join(s.entriesDir, y.name);
      await record(yDir);
      for (const m of await readdir(yDir, { withFileTypes: true })) if (m.isDirectory()) await record(join(yDir, m.name));
    }
  }
  return out;
}

export async function readManifest(dir: string): Promise<CatalogManifest | null> {
  try {
    return CatalogManifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), "utf8")));
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, m: CatalogManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, MANIFEST_FILENAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(CatalogManifestSchema.parse(m), null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function manifestFor(db: lancedb.Connection, dirs: Record<string, number>, previous: CatalogManifest | null): Promise<CatalogManifest> {
  const { entries } = await openCatalogTables(db);
  let N = 0;
  let total = 0;
  if (entries) {
    const rows = (await entries.query().select(["len"]).toArray()) as { len: number }[];
    N = rows.length;
    for (const r of rows) total += r.len;
  }
  return { catalogVersion: CATALOG_VERSION, generation: (previous?.generation ?? 0) + 1, dirs, N, avgdl: N ? total / N : 0, syncedAt: new Date().toISOString() };
}

async function listMarkdown(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listMarkdown(p)));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Parse every store from disk without the legacy entries-cache.json (the catalog IS the cache). Throws on drift like loadAllEntries. */
export async function loadEntriesFromDisk(stores: Store[]): Promise<MemoryEntry[]> {
  const files: string[] = [];
  for (const s of stores) files.push(...(await listMarkdown(s.entriesDir)), ...(await listMarkdown(s.summariesDir)));
  return groupEntries(await Promise.all(files.map(parseEntry)), "throw").entries;
}

/** Catalog tables + manifest from the Markdown on disk. Never touches vectors or the embedder. */
export async function syncCatalogFromDisk(
  db: lancedb.Connection,
  dir: string,
  opts: { root: string; stores: Store[] },
): Promise<{ added: number; removed: number; unchanged: number }> {
  const entries = await loadEntriesFromDisk(opts.stores);
  const stats = await syncCatalogTables(db, entries, { root: opts.root });
  await ensureCatalogIndices(db);
  await writeManifest(dir, await manifestFor(db, await scanDirMtimes(opts.stores, opts.root), await readManifest(dir)));
  return stats;
}
```

`src/catalog-lance.ts` (replacing the stub):

```ts
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import * as lancedb from "@lancedb/lancedb";
import { lexicalMode, type Catalog, type CatalogEntryMeta, type LexicalHit, type LexicalMode } from "./catalog.js";
import { ENTRIES_TABLE, META_COLUMNS, likeLiteral, metaFromRow, openCatalogTables, syncCatalogFromDisk } from "./catalog-sync.js";
import { ROOT } from "./ingest.js";
import { listGraphStores, type Store } from "./graphs.js";
import { bm25Scores, buildLexicalFromTokens, tokenize, type LexicalIndex } from "./lexical.js";
import { applyFilters, SLUG_RE, whereClause, type SearchFilters } from "./ranking.js";
import type { ChainSource } from "./chains.js";
import { FrontmatterSchema, type CatalogEntryRow, type MemoryEntry } from "./schema.js";

type MetaRow = Omit<CatalogEntryRow, "lex">;

function sqlList(ids: string[]): string {
  return ids.map((i) => `'${i}'`).join(", ");
}

/** Reads a new-format slot's `entries` table; bodies are read from disk only for hits. */
export class LanceCatalog implements Catalog {
  readonly kind = "lance" as const;
  readonly format = 2 as const;
  private postings: Promise<LexicalIndex> | null = null;

  private constructor(
    readonly slot: string,
    readonly dir: string,
    private readonly db: lancedb.Connection,
    private table: lancedb.Table | null,
    private readonly root: string,
    private readonly stores: Store[],
    private readonly mode: LexicalMode,
    private readonly autoRefresh: boolean,
  ) {}

  static async open(opts: { slot: string; dir: string; root?: string; stores?: Store[]; mode?: LexicalMode; autoRefresh?: boolean }): Promise<LanceCatalog> {
    const db = await lancedb.connect(opts.dir);
    const { entries } = await openCatalogTables(db);
    const c = new LanceCatalog(opts.slot, opts.dir, db, entries, opts.root ?? ROOT, opts.stores ?? listGraphStores(), opts.mode ?? lexicalMode(), opts.autoRefresh ?? true);
    if (c.autoRefresh) await c.refresh();
    return c;
  }

  private async rows(where?: string): Promise<MetaRow[]> {
    if (!this.table) return [];
    let q = this.table.query().select([...META_COLUMNS]);
    if (where) q = q.where(where);
    return (await q.toArray()) as MetaRow[];
  }

  private metas(rows: MetaRow[]): CatalogEntryMeta[] {
    return rows.map((r) => metaFromRow(r, this.root));
  }

  async filter(f: SearchFilters): Promise<CatalogEntryMeta[]> {
    return applyFilters(this.metas(await this.rows(whereClause(f))), f);
  }

  async byIds(ids: string[]): Promise<CatalogEntryMeta[]> {
    const valid = [...new Set(ids.filter((id) => SLUG_RE.test(id)))];
    const out: CatalogEntryMeta[] = [];
    for (let i = 0; i < valid.length; i += 500) {
      out.push(...this.metas(await this.rows(`id IN (${sqlList(valid.slice(i, i + 500))})`)));
    }
    const want = new Set(ids);
    return out.filter((m) => want.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async linked(): Promise<ChainSource[]> {
    const linkers = this.metas(await this.rows("follows <> ''"));
    const targets = [...new Set(linkers.flatMap((m) => m.follows ?? []))];
    const byId = new Map(linkers.map((m) => [m.id, m]));
    for (const t of await this.byIds(targets)) byId.set(t.id, t);
    return [...byId.values()].map(({ id, type, date, updated, follows }) => ({ id, type, date, ...(updated ? { updated } : {}), ...(follows ? { follows } : {}) }));
  }

  async referrers(id: string): Promise<CatalogEntryMeta[]> {
    if (!SLUG_RE.test(id)) return [];
    const rows = await this.rows(`follows LIKE '%|${id}|%' OR sources LIKE '%|${id}|%'`);
    return this.metas(rows).filter((m) => (m.follows?.includes(id) ?? false) || (m.sources?.includes(id) ?? false));
  }

  async bySourceIds(ids: string[]): Promise<CatalogEntryMeta[]> {
    if (ids.length === 0) return [];
    const where = ids.map((s) => `source_ids LIKE '%|${likeLiteral(s)}|%'`).join(" OR ");
    const want = new Set(ids);
    return this.metas(await this.rows(where)).filter((m) => (m.source_ids ?? []).some((s) => want.has(s)));
  }

  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  async all(): Promise<CatalogEntryMeta[]> {
    return this.metas(await this.rows());
  }

  async hydrate(metas: CatalogEntryMeta[]): Promise<MemoryEntry[]> {
    return Promise.all(
      metas.map(async (m) => {
        const raw = await readFile(m.path, "utf8");
        const { data, content } = matter(raw);
        const fm = FrontmatterSchema.parse(data);
        return { ...fm, body: content.trim(), path: m.path, paths: m.paths, graphs: m.graphs };
      }),
    );
  }

  private referenceIndex(): Promise<LexicalIndex> {
    if (!this.postings) {
      this.postings = (async () => {
        if (!this.table) return buildLexicalFromTokens([]);
        const rows = (await this.table.query().select(["id", "hash", "lex"]).toArray()) as { id: string; hash: string; lex: string }[];
        return buildLexicalFromTokens(rows.map((r) => ({ id: r.id, hash: r.hash, tokens: r.lex ? r.lex.split(" ") : [] })));
      })();
    }
    return this.postings;
  }

  async lexical(query: string, allowed: Set<string>, limit: number): Promise<LexicalHit[]> {
    if (this.mode === "postings") {
      return [...bm25Scores(query, await this.referenceIndex()).entries()]
        .filter(([id]) => allowed.has(id))
        .sort((a, b) => b[1] - a[1])
        .map(([id, score]) => ({ id, score }));
    }
    const terms = tokenize(query).join(" ");
    if (!terms || !this.table) return [];
    const rows = (await this.table
      .query()
      .fullTextSearch(terms, { columns: "lex" })
      .select(["id", "_score"])
      .limit(limit)
      .toArray()) as { id: string; _score: number }[];
    return rows.filter((r) => allowed.has(r.id)).map((r) => ({ id: r.id, score: r._score }));
  }

  /** Task 8 adds the manifest/dir-mtime policy; until then: build the tables when they are missing. */
  async refresh(): Promise<{ refreshed: boolean }> {
    if (this.table) return { refreshed: false };
    await syncCatalogFromDisk(this.db, this.dir, { root: this.root, stores: this.stores });
    this.table = (await openCatalogTables(this.db)).entries;
    this.postings = null;
    return { refreshed: true };
  }
}
```

Note on `hydrate` key order: `{ ...fm, body, path, paths, graphs }` with `fm` from `FrontmatterSchema.parse` reproduces exactly what `groupEntries` builds (`ingest.ts:235-236`), so `hashEntry` on a hydrated entry equals the stored hash — the shadow test asserts it.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/catalog-shadow.test.ts src/catalog-legacy.test.ts src/lexical.test.ts && npm run typecheck && npm test`
Expected: green. If the fts test's `meanTau` lands below 0.9, print the worst phrasings (same shape as `scripts/spike-fts.ts:294-298`) — the expected cause is `whereClause` not being applied to the FTS query; `lexical()` takes an `allowed` set, not filters, so the test only post-filters. That is by design: `searchDetailed` (Task 9) passes `where` to the vector leg and `allowed` to the lexical leg exactly as today.

- [ ] **Step 5: Commit**

```bash
git add src/catalog-sync.ts src/catalog-lance.ts src/lexical.ts src/catalog-shadow.test.ts
git commit -m "LanceCatalog over entries/files tables with a whitespace FTS index; shadow-mode equality with LegacyCatalog"
```

### Task 6: `memory index --build <slot>` — build a new-format slot reusing vectors (compat test (b))

**Files:**
- Create: `src/slot-build.ts`
- Modify: `src/store.ts` (export `recordsFor`, `headerRecordsFor`, `TABLE`, `HEADERS_TABLE`, `INDEX_VERSION`, `headerLegEnabled`)
- Modify: `src/cli.ts:508-524` (`cmdIndex`), `:1178` (HELP line)
- Test: `src/slot-build.test.ts`

**Interfaces:**
- Consumes: `loadAllEntries`, `hashEntry`, `ROOT` (ingest); `getEmbedder`, `type Embedder` (embed); `recordsFor`, `headerRecordsFor`, `headerLegEnabled`, `INDEX_VERSION`, `TABLE`, `HEADERS_TABLE` (store, newly exported); `syncCatalogTables`, `ensureCatalogIndices`, `writeManifest`, `manifestFor`, `scanDirMtimes` (Task 5); `slotDir`, `buildingDir`, `isSlotName`, `slotExists`, `resolveIndexSlotDetailed`, `SlotMetaSchema`, `META_FILENAME`, `CATALOG_VERSION`, `INDEX_ROOT` (Task 1); `listGraphStores` (graphs); `type MemoryRecord`, `packSlugs` (schema).
- Produces:
  ```ts
  // store.ts — now exported
  export const TABLE = "memory"; export const HEADERS_TABLE = "memory_headers"; export const INDEX_VERSION = 6;
  export async function recordsFor(entries: MemoryEntry[], embedder: Embedder): Promise<MemoryRecord[]>;
  export async function headerRecordsFor(entries: MemoryEntry[], embedder: Embedder): Promise<HeaderRecord[]>;
  export function headerLegEnabled(): boolean;   // already exported
  // slot-build.ts
  export interface BuildReport { slot: string; dir: string; entries: number; chunks: number; vectorsReused: number; embedded: number; headers: number; ms: number; dryRun: boolean; skipped?: "already-built" }
  export async function buildSlot(opts?: { name?: string; dryRun?: boolean; force?: boolean; embedder?: Embedder; root?: string }): Promise<BuildReport>;
  export function formatBuildReport(r: BuildReport): string;   // "entries N · vectors reused N · embedded N · headers N · ms N"
  ```

- [ ] **Step 1: Write the failing test**

`src/slot-build.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PRESERVED_SIDECARS } from "./index-slots.js";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));

/** sha256 of every file under dir (recursive, sorted), skipping `skip` subdirs. */
function treeHash(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const rel = relative(dir, p);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (ent.isDirectory()) walk(p);
      else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** An embedder wrapper that counts how many texts were embedded; same id as FakeEmbedder so vectors are reusable. */
const COUNTING_EMBEDDER = `
  const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))});
  const inner = new FakeEmbedder();
  let embeddedTexts = 0;
  const embedder = { id: inner.id, dim: inner.dim, embed: async (texts) => { embeddedTexts += texts.length; return inner.embed(texts); } };
`;

test("index --build next: reuses every vector, leaves the root slot untouched, preserves sidecars, is a no-op on re-run", { timeout: 240_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-build-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`);
    const indexRoot = join(root, ".index");
    for (const f of PRESERVED_SIDECARS) if (f !== "active.json") writeFileSync(join(indexRoot, f), `{"sidecar":"${f}"}`);
    const before = treeHash(indexRoot, ["slots"]);

    const dry = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", dryRun: true, embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, unknown>; embeddedTexts: number };
    assert.equal(dry.r.dryRun, true);
    assert.equal(dry.embeddedTexts, 0, "dry run never embeds");
    assert.equal(existsSync(join(indexRoot, "slots")), false, "dry run writes nothing");

    const built = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, number>; embeddedTexts: number };
    assert.equal(built.r.entries, 7);
    assert.equal(built.r.embedded, 0, "existing chunk vectors are copied by (id, hash)");
    assert.equal(built.r.vectorsReused, built.r.chunks);
    assert.equal(built.embeddedTexts, 0);
    assert.equal(built.r.headers, 0, "header leg is dormant by default");
    assert.deepEqual(treeHash(indexRoot, ["slots"]), before, "root slot and sidecars byte-identical");
    const slotDir = join(indexRoot, "slots", "next");
    assert.ok(existsSync(join(slotDir, "meta.json")), "meta.json written");
    assert.equal(JSON.parse(readFileSync(join(slotDir, "meta.json"), "utf8")).format, 2);
    assert.ok(existsSync(join(slotDir, "catalog-manifest.json")), "manifest written");
    assert.ok(existsSync(join(slotDir, "entries.lance")), "entries table");
    assert.ok(existsSync(join(slotDir, "files.lance")), "files table");
    assert.ok(existsSync(join(slotDir, "memory.lance")), "chunk table");
    assert.equal(existsSync(join(indexRoot, "slots", "next__building")), false, "build dir renamed away");
    assert.equal(existsSync(join(indexRoot, "active.json")), false, "build never activates");

    const slotBefore = treeHash(slotDir);
    const again = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify(r));`) as Record<string, unknown>;
    assert.equal(again.skipped, "already-built");
    assert.deepEqual(treeHash(slotDir), slotBefore, "re-run changes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build: a build that dies mid-way leaves only <slot>__building, which the next build discards", { timeout: 240_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-build-kill-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`);
    // one NEW entry, so the build must embed something — the throwing embedder dies there
    writeFileSync(join(root, "memory", "entries", "2026", "01", "2026-01-08-new-after-sync.md"), md({ id: "2026-01-08-new-after-sync", date: "2026-01-08", type: "note", title: "New after sync", people: [], teams: [], tags: [] }, "fresh body"));
    assert.throws(
      () => runInStore(root, `const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))}); const inner = new FakeEmbedder(); const embedder = { id: inner.id, dim: inner.dim, embed: async () => { throw new Error("killed"); } }; const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next", embedder });`),
      /killed/,
    );
    assert.equal(existsSync(join(root, ".index", "slots", "next")), false, "no complete slot");
    assert.ok(existsSync(join(root, ".index", "slots", "next__building")), "partial build left in __building");
    const ok = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, number>; embeddedTexts: number };
    assert.equal(ok.r.entries, 8);
    assert.equal(ok.r.embedded, 1, "only the new entry's chunk was embedded");
    assert.equal(ok.embeddedTexts, 1);
    assert.equal(existsSync(join(root, ".index", "slots", "next__building")), false, "partial dir discarded");
    assert.ok(statSync(join(root, ".index", "slots", "next", "meta.json")).isFile(), "complete slot present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build rejects reserved and invalid names", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-build-names-"));
  try {
    seedStore(root);
    for (const bad of ["legacy", "previous", "Next", "x__building"]) {
      assert.throws(() => runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: ${JSON.stringify(bad)} });`), /slot name/, bad);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/slot-build.test.ts`
Expected: FAIL — `Cannot find module '…/src/slot-build.ts'`.

- [ ] **Step 3: Implement**

`src/store.ts`: change `const TABLE = "memory";` → `export const TABLE = "memory";`, `const HEADERS_TABLE` → `export const HEADERS_TABLE`, `const INDEX_VERSION = 6` → `export const INDEX_VERSION = 6`, `async function recordsFor` → `export async function recordsFor`, `async function headerRecordsFor` → `export async function headerRecordsFor`, and `interface HeaderRecord` → `export interface HeaderRecord`.

`src/slot-build.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { getEmbedder, type Embedder } from "./embed.js";
import { ROOT, hashEntry, loadAllEntries } from "./ingest.js";
import { listGraphStores } from "./graphs.js";
import {
  CATALOG_VERSION,
  INDEX_ROOT,
  META_FILENAME,
  RESERVED_SLOT_NAMES,
  SlotMetaSchema,
  buildingDir,
  isSlotName,
  resolveIndexSlotDetailed,
  slotDir,
  slotExists,
  type SlotMeta,
} from "./index-slots.js";
import { ensureCatalogIndices, manifestFor, scanDirMtimes, syncCatalogTables, writeManifest } from "./catalog-sync.js";
import { HEADERS_TABLE, INDEX_VERSION, TABLE, headerLegEnabled, headerRecordsFor, recordsFor, type HeaderRecord } from "./store.js";
import type { MemoryEntry, MemoryRecord } from "./schema.js";

/**
 * Build a complete new-format index slot beside the active one, never in
 * place: into `slots/<name>__building/`, renamed to `slots/<name>/` only when
 * every table, meta.json and the manifest are written. Chunk vectors (and
 * header vectors) whose (id, hash) already exist in the active slot are
 * copied, never re-embedded. Never activates.
 */
export interface BuildReport {
  slot: string;
  dir: string;
  entries: number;
  chunks: number;
  vectorsReused: number;
  embedded: number;
  headers: number;
  ms: number;
  dryRun: boolean;
  skipped?: "already-built";
}

export function formatBuildReport(r: BuildReport): string {
  return `entries ${r.entries} · vectors reused ${r.vectorsReused} · embedded ${r.embedded} · headers ${r.headers} · ms ${r.ms}`;
}

function requireBuildName(name: string): string {
  if (RESERVED_SLOT_NAMES.has(name) || !isSlotName(name)) {
    throw new Error(`invalid index slot name '${name}' — lower-kebab, not 'legacy'/'previous', not ending in __building`);
  }
  return name;
}

async function existingVectors(sourceDir: string, table: string, wanted: Map<string, string>, embedderId: string, dim: number): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  if (!existsSync(join(sourceDir, `${table}.lance`))) return out;
  const { readIndexMetaSync } = await import("./index-slots.js");
  const meta = readIndexMetaSync(sourceDir);
  if (!meta || meta.embedderId !== embedderId || meta.dim !== dim) return out; // different model: nothing reusable
  const db = await lancedb.connect(sourceDir);
  const t = await db.openTable(table);
  const rows = (await t.query().toArray()) as Record<string, unknown>[];
  for (const r of rows) {
    const id = r.id as string;
    if (wanted.get(id) !== (r.hash as string)) continue;
    (out.get(id) ?? out.set(id, []).get(id)!).push(r);
  }
  return out;
}

export async function buildSlot(
  opts: { name?: string; dryRun?: boolean; force?: boolean; embedder?: Embedder; root?: string } = {},
): Promise<BuildReport> {
  const t0 = performance.now();
  const name = requireBuildName(opts.name ?? "next");
  const root = opts.root ?? INDEX_ROOT;
  const dir = slotDir(name, root);
  const building = buildingDir(name, root);
  const embedder = opts.embedder ?? getEmbedder();

  if (!opts.force && slotExists(name, root)) {
    return { slot: name, dir, entries: 0, chunks: 0, vectorsReused: 0, embedded: 0, headers: 0, ms: Math.round(performance.now() - t0), dryRun: Boolean(opts.dryRun), skipped: "already-built" };
  }

  const entries: MemoryEntry[] = await loadAllEntries();
  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));
  const source = resolveIndexSlotDetailed({ root, env: {} }); // the active slot is the vector source (never the one being built)
  const sourceDir = source.slot === name ? dir : source.dir;
  const reusable = await existingVectors(sourceDir, TABLE, wanted, embedder.id, embedder.dim);
  const toEmbed = entries.filter((e) => !reusable.has(e.id));
  const reusedRows = entries.flatMap((e) => reusable.get(e.id) ?? []);
  const headersWanted = headerLegEnabled();
  const reusableHeaders = headersWanted ? await existingVectors(sourceDir, HEADERS_TABLE, wanted, embedder.id, embedder.dim) : new Map();
  const headersToEmbed = headersWanted ? entries.filter((e) => !reusableHeaders.has(e.id)) : [];

  if (opts.dryRun) {
    const chunks = reusedRows.length + toEmbed.reduce((n, e) => n + (e.body.split(/\n\s*\n/).filter(Boolean).length || 1), 0);
    return { slot: name, dir, entries: entries.length, chunks, vectorsReused: reusedRows.length, embedded: 0, headers: 0, ms: Math.round(performance.now() - t0), dryRun: true };
  }

  // A previous interrupted build is discarded wholesale — it is never resumed.
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true });
  const db = await lancedb.connect(building);

  const fresh: MemoryRecord[] = toEmbed.length ? await recordsFor(toEmbed, embedder) : [];
  const chunkRows = [...reusedRows, ...(fresh as unknown as Record<string, unknown>[])];
  if (chunkRows.length > 0) await db.createTable(TABLE, chunkRows);

  let headers = 0;
  if (headersWanted) {
    const freshHeaders: HeaderRecord[] = headersToEmbed.length ? await headerRecordsFor(headersToEmbed, embedder) : [];
    const headerRows = [...entries.flatMap((e) => reusableHeaders.get(e.id) ?? []), ...(freshHeaders as unknown as Record<string, unknown>[])];
    if (headerRows.length > 0) await db.createTable(HEADERS_TABLE, headerRows);
    headers = headerRows.length;
  }

  await syncCatalogTables(db, entries, { root: ROOT });
  await ensureCatalogIndices(db);
  await writeManifest(building, await manifestFor(db, await scanDirMtimes(listGraphStores(), ROOT), null));

  const meta: SlotMeta = SlotMetaSchema.parse({
    format: 2,
    indexVersion: INDEX_VERSION,
    embedderId: embedder.id,
    dim: embedder.dim,
    catalogVersion: CATALOG_VERSION,
    vectorIndex: "flat",
    headerTable: headersWanted,
    lexical: "fts",
    builtAt: new Date().toISOString(),
  });
  await writeFile(join(building, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  if (opts.force) await rm(dir, { recursive: true, force: true });
  await rename(building, dir);
  return {
    slot: name,
    dir,
    entries: entries.length,
    chunks: chunkRows.length,
    vectorsReused: reusedRows.length,
    embedded: fresh.length,
    headers,
    ms: Math.round(performance.now() - t0),
    dryRun: false,
  };
}
```

`src/cli.ts` `cmdIndex` (lines 508-524) becomes:

```ts
async function cmdIndex(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      optimize: { type: "boolean" },
      "header-batch": { type: "string" },
      build: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  if (values.build !== undefined) {
    const { buildSlot, formatBuildReport } = await import("./slot-build.js");
    const r = await buildSlot({ name: values.build as string, dryRun: Boolean(values["dry-run"]), force: Boolean(values.force) });
    if (r.skipped === "already-built") {
      console.log(`✓ slot '${r.slot}' is already built — try it with --index-slot ${r.slot}, activate with: index --activate ${r.slot}, or rebuild with --build ${r.slot} --force`);
      return;
    }
    console.log(`${r.dryRun ? "(dry run) would build" : "✓ built"} slot '${r.slot}' — ${formatBuildReport(r)}`);
    if (!r.dryRun) console.log(`  try it:   npx tsx src/cli.ts recall "…" --index-slot ${r.slot}\n  activate: npx tsx src/cli.ts index --activate ${r.slot}`);
    return;
  }
  const stats = await syncIndex({ force: Boolean(values.force) });
  console.log(
    `✓ index synced — ${stats.added} (re)embedded, ${stats.removed} removed, ${stats.unchanged} unchanged`,
  );
  if (values.optimize) {
    const { optimizeIndex } = await import("./store.js");
    const r = await optimizeIndex(7, { headerBatch: positiveInt(values["header-batch"], 500, "--header-batch") });
    console.log(
      `✓ optimized — headers backfilled ${r.headers.embedded}, ${r.headers.remaining} remaining${r.headers.remaining ? " (run again to continue)" : ""}`,
    );
  }
}
```

HELP (line 1178) becomes two lines:
```
  memory index [--force] [--optimize [--header-batch N]]   # --optimize compacts + backfills title vectors (memory_headers) in bounded batches
  memory index --build <slot> [--dry-run] [--force]         # build a complete new-format index beside the current one (vectors reused; never activates)
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/slot-build.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green; eval unchanged (no read path changed).

- [ ] **Step 5: Commit**

```bash
git add src/slot-build.ts src/slot-build.test.ts src/store.ts src/cli.ts
git commit -m "memory index --build <slot>: new-format slot built beside the active index, vectors reused by (id, hash)"
```

---

### Task 7: Writers keep every built slot in sync

**Files:**
- Modify: `src/store.ts:195-267` (`syncIndex`), `src/membership.ts:16-20` (`SyncStats` unchanged — extra fields are structural)
- Modify: `src/cli.ts:296-300` (`add` output), `cmdIndex` (`--rebuild`, `--reembed`), HELP
- Test: `src/slot-sync.test.ts`

**Interfaces:**
- Consumes: `listBuiltSlots`, `resolveIndexSlotDetailed`, `slotDir`, `slotFormat`, `SlotMetaSchema`, `CATALOG_VERSION` (Task 1); `syncCatalogTables`, `ensureCatalogIndices`, `dropCatalogTables`, `writeManifest`, `manifestFor`, `scanDirMtimes`, `readManifest` (Task 5); `listGraphStores`.
- Produces:
  ```ts
  export interface SlotSyncStats { slot: string; format: 1 | 2; added: number; removed: number; unchanged: number }
  export interface SyncIndexResult { added: number; removed: number; unchanged: number; slots: SlotSyncStats[] }  // top-level numbers = the active slot's
  export async function syncIndex(opts?: { force?: boolean; rebuild?: boolean; slots?: "active" | "all" }): Promise<SyncIndexResult>;
  ```
  `--rebuild`: format-2 active slot drops and rebuilds its catalog tables + FTS (vectors kept); legacy: incremental sync + lexical rebuild. `--reembed` ≡ `--force` (drop vectors, re-embed everything).

- [ ] **Step 1: Write the failing test**

`src/slot-sync.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));
const LANCE = JSON.stringify(join(REPO, "node_modules", "@lancedb", "lancedb", "dist", "index.js"));

const COUNT_ROWS = `
  const lancedb = await import(${LANCE});
  async function count(dir, table) { const db = await lancedb.connect(dir); if (!(await db.tableNames()).includes(table)) return 0; return (await db.openTable(table)).countRows(); }
`;

test("syncIndex after --build next: one embedding pass feeds BOTH slots; the next slot's catalog and FTS stay current", { timeout: 240_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-sync-slots-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`);
    runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next" });`);
    const dir = join(root, "memory", "entries", "2026", "01");
    writeFileSync(join(dir, "2026-01-09-penguin-rollout.md"), md({ id: "2026-01-09-penguin-rollout", date: "2026-01-09", type: "note", title: "Penguin rollout", people: [], teams: [], tags: ["rollout"] }, "penguin rollout body text"));
    const r = runInStore(
      root,
      `${COUNT_ROWS}
       const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))});
       const embed = FakeEmbedder.prototype.embed; let calls = 0;
       FakeEmbedder.prototype.embed = function (texts) { calls += texts.length; return embed.call(this, texts); };
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex();
       const legacyChunks = await count(${JSON.stringify(join(root, ".index"))}, "memory");
       const nextChunks = await count(${JSON.stringify(join(root, ".index", "slots", "next"))}, "memory");
       const nextEntries = await count(${JSON.stringify(join(root, ".index", "slots", "next"))}, "entries");
       const { LanceCatalog } = await import(${JSON.stringify(join(REPO, "src", "catalog-lance.ts"))});
       const cat = await LanceCatalog.open({ slot: "next", dir: ${JSON.stringify(join(root, ".index", "slots", "next"))}, autoRefresh: false });
       const hits = await cat.lexical("penguin rollout", new Set(["2026-01-09-penguin-rollout"]), 10);
       console.log(JSON.stringify({ sync, calls, legacyChunks, nextChunks, nextEntries, hits }));`,
    ) as { sync: { added: number; slots: { slot: string; format: number; added: number }[] }; calls: number; legacyChunks: number; nextChunks: number; nextEntries: number; hits: { id: string }[] };
    assert.equal(r.sync.added, 1);
    assert.deepEqual(r.sync.slots.map((s) => `${s.slot}:${s.format}:${s.added}`), ["legacy:1:1", "next:2:1"]);
    assert.equal(r.calls, 1, "the new chunk was embedded exactly once for both slots");
    assert.equal(r.legacyChunks, r.nextChunks, "both slots hold the same chunk rows");
    assert.equal(r.nextEntries, 8);
    assert.deepEqual(r.hits.map((h) => h.id), ["2026-01-09-penguin-rollout"], "FTS finds the un-indexed new row before optimize");
    const manifest = JSON.parse(readFileSync(join(root, ".index", "slots", "next", "catalog-manifest.json"), "utf8"));
    assert.equal(manifest.N, 8);
    assert.equal(manifest.generation, 2, "manifest generation advanced");
    assert.ok(!readFileSync(join(root, ".index", "lexical.json"), "utf8").includes('"format"'), "legacy lexical.json shape untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIndex --rebuild on a format-2 active slot rebuilds the catalog without re-embedding", { timeout: 240_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-sync-rebuild-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`);
    runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next" });`);
    const r = runInStore(
      root,
      `const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))});
       const embed = FakeEmbedder.prototype.embed; let calls = 0;
       FakeEmbedder.prototype.embed = function (texts) { calls += texts.length; return embed.call(this, texts); };
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex({ rebuild: true, slots: "active" });
       console.log(JSON.stringify({ sync, calls }));`,
      { MEMORY_INDEX_SLOT: "next" },
    ) as { sync: { slots: { slot: string }[]; unchanged: number }; calls: number };
    assert.deepEqual(r.sync.slots.map((s) => s.slot), ["next"]);
    assert.equal(r.sync.unchanged, 7);
    assert.equal(r.calls, 0, "rebuild keeps every vector");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/slot-sync.test.ts`
Expected: FAIL — `sync.slots` undefined; `nextEntries` is 7 (the next slot was not synced).

- [ ] **Step 3: Implement**

Replace `syncIndex` in `src/store.ts` (lines 190-267) with:

```ts
export interface SlotSyncStats {
  slot: string;
  format: 1 | 2;
  added: number;
  removed: number;
  unchanged: number;
}

export interface SyncIndexResult {
  /** The active slot's numbers (what existing callers print). */
  added: number;
  removed: number;
  unchanged: number;
  slots: SlotSyncStats[];
}

/** Today's chunk-table sync for ONE slot directory; `records` memoizes embedding across slots. */
async function syncSlotVectors(
  db: lancedb.Connection,
  dir: string,
  format: 1 | 2,
  entries: MemoryEntry[],
  embedder: Embedder,
  opts: { force: boolean; records: (changed: MemoryEntry[]) => Promise<MemoryRecord[]> },
): Promise<{ added: number; removed: number; unchanged: number; changed: MemoryEntry[]; removedIds: string[] }> {
  const meta = await readMeta(dir);
  const embedderChanged = !meta || meta.embedderId !== embedder.id || meta.dim !== embedder.dim;
  const versionChanged = meta?.indexVersion !== INDEX_VERSION;
  const catalogChanged = format === 2 && (meta?.format !== 2 || meta.catalogVersion !== CATALOG_VERSION);
  const force = opts.force || embedderChanged || versionChanged || catalogChanged;

  if (force) {
    const names = await db.tableNames();
    if (names.includes(TABLE)) await db.dropTable(TABLE);
    if (names.includes(HEADERS_TABLE)) await db.dropTable(HEADERS_TABLE);
  }
  let table = await openTable(db);
  const existing = new Map<string, { hash: string; graphs: string }>();
  if (table && !force) {
    const rows = (await table.query().select(["id", "hash", "graphs"]).toArray()) as { id: string; hash: string; graphs: string }[];
    for (const r of rows) existing.set(r.id, { hash: r.hash, graphs: r.graphs });
  }
  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));
  const changed = entries.filter((e) => {
    const cur = existing.get(e.id);
    return cur?.hash !== wanted.get(e.id) || cur?.graphs !== packSlugs(e.graphs);
  });
  const removedIds = [...existing.keys()].filter((id) => !wanted.has(id));
  const toDelete = [...new Set([...removedIds, ...changed.map((e) => e.id)])];
  if (table && toDelete.length > 0) await table.delete(`id IN (${sqlList(toDelete)})`);
  const newRecords = changed.length ? await opts.records(changed) : [];
  if (newRecords.length > 0) {
    const rows = newRecords as unknown as Record<string, unknown>[];
    if (!table) table = await db.createTable(TABLE, rows);
    else await table.add(rows);
  }
  const headers = await openHeaders(db);
  if (headers && removedIds.length > 0) await headers.delete(`id IN (${sqlList(removedIds)})`);
  if (changed.length > 0 && headerLegEnabled()) await upsertHeaders(db, await headerRecordsFor(changed, embedder));

  if (format === 1) {
    await writeLegacyMeta(dir, { embedderId: embedder.id, dim: embedder.dim, indexVersion: INDEX_VERSION });
  } else {
    const previous = meta?.format === 2 ? meta : null;
    const next: SlotMeta = SlotMetaSchema.parse({
      format: 2,
      indexVersion: INDEX_VERSION,
      embedderId: embedder.id,
      dim: embedder.dim,
      catalogVersion: CATALOG_VERSION,
      vectorIndex: "flat",
      headerTable: previous?.headerTable ?? headerLegEnabled(),
      lexical: "fts",
      builtAt: previous?.builtAt ?? new Date().toISOString(),
    });
    await mkdir(dir, { recursive: true });
    await writeFile(metaPath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return { added: changed.length, removed: removedIds.length, unchanged: entries.length - changed.length, changed, removedIds };
}

/**
 * Incrementally sync the index with the Markdown source of truth — for the
 * active slot AND every other built slot (so a `next` slot under evaluation
 * never goes stale). Entries are embedded once and shared across slots.
 */
export async function syncIndex(opts: { force?: boolean; rebuild?: boolean; slots?: "active" | "all" } = {}): Promise<SyncIndexResult> {
  const embedder = getEmbedder();
  const entries = await loadAllEntries();
  const active = currentSlot();
  const names = opts.slots === "active" ? [active.slot] : [active.slot, ...listBuiltSlots().map((s) => s.name).filter((n) => n !== active.slot)];

  const memo = new Map<string, MemoryRecord[]>();
  const records = async (changed: MemoryEntry[]): Promise<MemoryRecord[]> => {
    const missing = changed.filter((e) => !memo.has(e.id));
    if (missing.length) {
      for (const r of await recordsFor(missing, embedder)) (memo.get(r.id) ?? memo.set(r.id, []).get(r.id)!).push(r);
    }
    return changed.flatMap((e) => memo.get(e.id) ?? []);
  };

  const slots: SlotSyncStats[] = [];
  for (const slot of names) {
    const dir = slotDir(slot);
    const format = slotFormat(slot);
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    const r = await syncSlotVectors(db, dir, format, entries, embedder, { force: Boolean(opts.force), records });
    if (format === 1) {
      await syncLexical(entries); // root lexical.json — the legacy slot's lexical leg
    } else {
      if (opts.rebuild) await dropCatalogTables(db);
      await syncCatalogTables(db, entries, { root: ROOT });
      await ensureCatalogIndices(db);
      await writeManifest(dir, await manifestFor(db, await scanDirMtimes(listGraphStores(), ROOT), await readManifest(dir)));
    }
    slots.push({ slot, format, added: r.added, removed: r.removed, unchanged: r.unchanged });
  }
  const first = slots[0]!;
  return { added: first.added, removed: first.removed, unchanged: first.unchanged, slots };
}
```

Add the imports at the top of `store.ts`:
```ts
import { ROOT, chunkEntry, displayChunkText, entrySearchText, hashEntry, headerText, loadAllEntries } from "./ingest.js";
import { listGraphStores } from "./graphs.js";
import { CATALOG_VERSION, META_FILENAME, SlotMetaSchema, listBuiltSlots, readIndexMetaSync, resolveIndexSlotDetailed, slotDir, slotFormat, type IndexMeta, type SlotMeta, type SlotResolution } from "./index-slots.js";
import { dropCatalogTables, ensureCatalogIndices, manifestFor, readManifest, scanDirMtimes, syncCatalogTables, writeManifest } from "./catalog-sync.js";
```
(`catalog-sync.ts` imports `ingest`/`lexical`/`schema`/`graphs`/`index-slots` only — no cycle with `store.ts`.)

`src/cli.ts`: in `cmdIndex` add options `rebuild: { type: "boolean" }, reembed: { type: "boolean" }` and call `syncIndex({ force: Boolean(values.force || values.reembed), rebuild: Boolean(values.rebuild) })`; after the `✓ index synced` line print one line per extra slot: `for (const s of stats.slots.slice(1)) console.log(`  ↻ synced slot ${s.slot} (+${s.added} changed, ${s.removed} removed)`);`. In `cmdAdd` after line 300 add the same loop: `for (const s of stats.slots.slice(1)) console.log(`  ↻ synced slot ${s.slot}`);`. HELP: `memory index [--force|--reembed] [--rebuild] [--optimize [--header-batch N]]   # --rebuild: rebuild the active slot's catalog/lexical tables reusing vectors; --reembed (= --force): drop and re-embed`.

`src/membership.ts` `SyncStats` (line 16-20) stays; `SyncIndexResult` is assignable to it.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/slot-sync.test.ts src/slot-build.test.ts src/legacy-golden.test.ts src/store-headers.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green; the golden fixture still matches (legacy path unchanged in behaviour: same deletes/adds/meta/lexical); eval delta 0.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/cli.ts src/slot-sync.test.ts
git commit -m "Writers sync every built slot: one embedding pass shared across slots; --rebuild/--reembed"
```

---

### Task 8: Freshness on the read path (new-format slots only)

**Files:**
- Modify: `src/catalog-lance.ts` (`refresh()`)
- Test: `src/catalog-freshness.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `scanDirMtimes`, `syncCatalogFromDisk` (Task 5).
- Produces: `LanceCatalog.refresh()` semantics:
  1. tables missing or manifest missing → full catalog sync from disk (no vectors);
  2. `MEMORY_SYNC=strict` → always full sync;
  3. otherwise stat every `entries/`, `entries/YYYY`, `entries/YYYY/MM`, `summaries/` dir of every store (~60 stats) and compare with `manifest.dirs`; any difference → full sync;
  4. when a sync ran, print `↻ catalog refreshed (<slot>)` to stderr once.
  Known limitation (documented in AGENTS.md in Task 16): an in-place edit of an existing file by hand does not change its directory's mtime, so it is picked up by the next writer sync, `memory index`, or `MEMORY_SYNC=strict`; the legacy slot re-parses per command and does not have this gap.

- [ ] **Step 1: Write the failing test**

`src/catalog-freshness.test.ts` (in-process: `LanceCatalog.open` takes explicit `root`/`stores`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceCatalog } from "./catalog-lance.js";
import { readManifest, syncCatalogFromDisk } from "./catalog-sync.js";
import { md } from "./test-store.js";

function store(root: string) {
  return { graph: "default", dir: join(root, "memory"), entriesDir: join(root, "memory", "entries"), summariesDir: join(root, "memory", "summaries"), manifestPath: join(root, "memory", "GRAPH.md") };
}

function write(root: string, id: string, date: string, title: string): void {
  const [y, m] = date.split("-");
  const dir = join(root, "memory", "entries", y!, m!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), md({ id, date, type: "note", title, people: [], teams: [], tags: [] }, `${title} body`));
}

test("refresh: builds a missing catalog, then stays quiet until a directory changes; strict mode always re-syncs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-fresh-"));
  const slot = join(root, ".index", "slots", "main");
  try {
    write(root, "2026-01-01-alpha", "2026-01-01", "Alpha");
    const stores = [store(root)];
    const first = await LanceCatalog.open({ slot: "main", dir: slot, root, stores, mode: "fts" });
    assert.equal(await first.count(), 1, "missing tables → built from disk on open");
    assert.equal((await readManifest(slot))!.generation, 1);

    const quiet = await LanceCatalog.open({ slot: "main", dir: slot, root, stores, mode: "fts", autoRefresh: false });
    assert.deepEqual(await quiet.refresh(), { refreshed: false }, "no dir changed → no sync");

    // A new month directory appears (parent entries/2026 mtime changes) → refreshed.
    write(root, "2026-02-01-beta", "2026-02-01", "Beta");
    assert.deepEqual(await quiet.refresh(), { refreshed: true });
    assert.equal(await quiet.count(), 2);
    assert.equal((await readManifest(slot))!.generation, 2);

    // A file deleted from an existing month dir → that dir's mtime changes → refreshed.
    rmSync(join(root, "memory", "entries", "2026", "01", "2026-01-01-alpha.md"));
    assert.deepEqual(await quiet.refresh(), { refreshed: true });
    assert.equal(await quiet.count(), 1);

    // In-place edit (same path): dir mtime unchanged → NOT detected without strict.
    const beta = join(root, "memory", "entries", "2026", "02", "2026-02-01-beta.md");
    const dirStat = join(root, "memory", "entries", "2026", "02");
    const before = readFileSync(beta, "utf8");
    writeFileSync(beta, before.replace("Beta body", "Beta body edited"));
    utimesSync(dirStat, new Date(0), new Date((await readManifest(slot))!.dirs["memory/entries/2026/02"]!));
    assert.deepEqual(await quiet.refresh(), { refreshed: false }, "documented gap: in-place edits need strict or a writer sync");
    process.env.MEMORY_SYNC = "strict";
    try {
      assert.deepEqual(await quiet.refresh(), { refreshed: true }, "strict forces the scan");
    } finally {
      delete process.env.MEMORY_SYNC;
    }
    const edited = await quiet.hydrate(await quiet.byIds(["2026-02-01-beta"]));
    assert.match(edited[0]!.body, /edited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCatalogFromDisk never touches vector tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-fresh-vec-"));
  const slot = join(root, ".index", "slots", "main");
  try {
    write(root, "2026-01-01-alpha", "2026-01-01", "Alpha");
    const db = await lancedb.connect(slot);
    await db.createTable("memory", [{ id: "x", hash: "h", vector: [0.1, 0.2] }]);
    await syncCatalogFromDisk(db, slot, { root, stores: [store(root)] });
    assert.deepEqual((await db.tableNames()).sort(), ["entries", "files", "memory"]);
    assert.equal(await (await db.openTable("memory")).countRows(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/catalog-freshness.test.ts`
Expected: FAIL — after writing Beta, `refresh()` returns `{ refreshed: false }` (Task 5's refresh only builds missing tables).

- [ ] **Step 3: Implement**

Replace `refresh()` in `src/catalog-lance.ts`:

```ts
  /**
   * Freshness: a missing catalog or manifest is built from disk; otherwise
   * ~60 directory stats are compared with the manifest (MEMORY_SYNC=strict
   * skips the comparison and always re-syncs). In-place edits of an existing
   * file do not change its directory's mtime — writers sync after their own
   * writes, `memory index` and strict mode cover hand edits.
   */
  async refresh(): Promise<{ refreshed: boolean }> {
    const manifest = await readManifest(this.dir);
    let stale = !this.table || !manifest || process.env.MEMORY_SYNC === "strict";
    if (!stale && manifest) {
      const dirs = await scanDirMtimes(this.stores, this.root);
      const keys = new Set([...Object.keys(dirs), ...Object.keys(manifest.dirs)]);
      for (const k of keys) {
        if (dirs[k] !== manifest.dirs[k]) {
          stale = true;
          break;
        }
      }
    }
    if (!stale) return { refreshed: false };
    await syncCatalogFromDisk(this.db, this.dir, { root: this.root, stores: this.stores });
    this.table = (await openCatalogTables(this.db)).entries;
    this.postings = null;
    if (process.env.MEMORY_QUIET !== "1") console.error(`↻ catalog refreshed (${this.slot})`);
    return { refreshed: true };
  }
```
and extend the `catalog-sync.js` import with `readManifest, scanDirMtimes`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/catalog-freshness.test.ts src/catalog-shadow.test.ts && npm run typecheck && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/catalog-lance.ts src/catalog-freshness.test.ts
git commit -m "LanceCatalog freshness: manifest vs directory mtimes on the read path, MEMORY_SYNC=strict forces a scan"
```

### Task 9: `searchDetailed` reads through the `Catalog` (first caller switch; compat test (c); fresh stores build the new format)

**Files:**
- Modify: `src/store.ts:31-54` (`knownPeople`, `entityMatchesFor`), `:439-484` (`rareEntityEdges`, `explicitEdges` param types), `:486-525` (`SearchReport.index`, `SearchOptions.slot`), `:558-778` (`searchDetailed`), `:802-837` (`findSimilar`)
- Modify: `src/index-slots.ts` (`resolveIndexSlotDetailed` fresh-store default), `src/index-slots.test.ts` (one case)
- Modify: `src/legacy-golden.test.ts` (pin the legacy slot explicitly), `src/store-slots.test.ts`
- Test: `src/slot-search-parity.test.ts`

**Interfaces:**
- Consumes: `openCatalog`, `type Catalog`, `type CatalogEntryMeta` (Task 4); `buildChainIndex(ChainSource[])` (Task 3).
- Produces:
  ```ts
  export interface SearchOptions { …; slot?: string }                       // explicit slot (recall --index-slot)
  export interface SearchReport { …; index: { slot: string; format: 1 | 2 } }  // additive
  // index-slots.ts: a store with NO .index/meta.json, no memory.lance and no active.json resolves to FRESH_SLOT ("main", format 2, source "default")
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/index-slots.test.ts`:

```ts
test("resolution: a store with no index at all defaults to the fresh new-format slot 'main'; a root meta.json means legacy", () => {
  const root = tempRoot();
  try {
    const fresh = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual([fresh.slot, fresh.format, fresh.source, fresh.dir], ["main", 2, "default", join(root, "slots", "main")]);
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "x", dim: 1, indexVersion: 6 }));
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).slot, LEGACY_SLOT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```
and change the first test's expectation (`no active.json and no env → the legacy root`) to create `meta.json` first (an existing v6 index), since an empty root is now a fresh store.

In `src/legacy-golden.test.ts` and `src/store-slots.test.ts`, pass `{ MEMORY_INDEX_SLOT: "legacy" }` as the env of every `runInStore` call (the golden pins the legacy slot; compat (a) is "a v6 `.index` fixture with no active.json", which the `syncIndex` under `MEMORY_INDEX_SLOT=legacy` creates — subsequent reads WITHOUT the env must still resolve to legacy: add after the sync in the golden test: `assert.equal((runInStore(root, \`const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.indexStatus()));\`) as { slot: string }).slot, "legacy", "a v6 root index with no active.json is the legacy slot by default");`).

`src/slot-search-parity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, RECALL_MOD, STORE_MOD, normalizeReport, runInStore, seedStore } from "./test-store.js";

const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));
const NOW = Date.UTC(2026, 1, 1);
const QUERIES = [
  { positionals: ["otter hiring loop"], opts: { k: 5 } },
  { positionals: ["budget review", "spending forecasts"], opts: { filters: { person: "boris-cohen" }, k: 10 } },
  { positionals: ["zebra migration"], opts: { filters: { graph: "team-x" }, k: 5 } },
  { positionals: ["codeword zephyr"], opts: { k: 3, completeness: "none" } },
  { positionals: ["freeze approved"], opts: { k: 10 } },
];

function recallAll(root: string, env: Record<string, string>): { index: { slot: string }; hits: { id: string }[] }[] {
  const reports = runInStore(
    root,
    `const { recall } = await import(${RECALL_MOD});
     const out = [];
     for (const q of ${JSON.stringify(QUERIES)}) out.push(await recall(q.positionals, { ...q.opts, now: ${NOW} }));
     console.log(JSON.stringify(out));`,
    env,
  );
  return normalizeReport(reports, root) as never;
}

function stripIndex(reports: { index?: unknown }[]): unknown[] {
  return reports.map(({ index: _i, ...rest }) => rest);
}

test("compat (c): --index-slot next with the legacy profile and the postings scorer is identical to the legacy slot", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-parity-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next" });`);
    const legacy = recallAll(root, { MEMORY_INDEX_SLOT: "legacy", MEMORY_RANK_PROFILE: "legacy" });
    const next = recallAll(root, { MEMORY_INDEX_SLOT: "next", MEMORY_RANK_PROFILE: "legacy", MEMORY_LEXICAL: "postings" });
    assert.deepEqual(legacy.map((r) => r.index.slot), ["legacy", "legacy", "legacy", "legacy", "legacy"]);
    assert.deepEqual(next.map((r) => r.index.slot), ["next", "next", "next", "next", "next"]);
    assert.deepEqual(stripIndex(next), stripIndex(legacy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compat (c): with the FTS lexical leg (default on next) the hit sets agree and the top hit is the same", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-parity-fts-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next" });`);
    const legacy = recallAll(root, { MEMORY_INDEX_SLOT: "legacy" });
    const next = recallAll(root, { MEMORY_INDEX_SLOT: "next" });
    for (let i = 0; i < QUERIES.length; i++) {
      const a = legacy[i]!.hits.map((h) => h.id);
      const b = next[i]!.hits.map((h) => h.id);
      assert.equal(b[0], a[0], `top hit for ${QUERIES[i]!.positionals[0]}`);
      const overlap = a.filter((id) => b.includes(id)).length / Math.max(a.length, b.length, 1);
      assert.ok(overlap >= 0.8, `overlap ${overlap} for ${QUERIES[i]!.positionals[0]}: ${a} vs ${b}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/slot-search-parity.test.ts src/index-slots.test.ts`
Expected: FAIL — `index` is undefined on the reports; the fresh-default case fails.

- [ ] **Step 3: Implement**

`src/index-slots.ts` — in `resolveIndexSlotDetailed`, replace the final `return { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" };` with:

```ts
  // Fresh store (no legacy index at all): build the new format directly.
  const legacyIndexPresent = existsSync(join(root, META_FILENAME)) || existsSync(join(root, "memory.lance"));
  if (!legacyIndexPresent) return { slot: FRESH_SLOT, dir: slotDir(FRESH_SLOT, root), format: 2, source: "default" };
  return { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" };
```
and in `listSlots`, compute `current` the same way (`active && slotExists(...) ? active.slot : resolveIndexSlotDetailed({ root, env: {} }).slot`). In `syncIndex` (Task 7) the fresh default must become explicit once an index exists: after the loop, `if (active.source === "default" && active.format === 2 && !readActiveSync()) await writeActive({ slot: active.slot });` (import `readActiveSync`, `writeActive`).

`src/store.ts`:

1. `knownPeople`:
   ```ts
   export async function knownPeople(): Promise<Set<string>> {
     const people = new Set<string>();
     for (const m of await (await openCatalog()).all()) for (const p of m.people) people.add(p);
     return people;
   }
   ```
2. Retype helpers: `entityMatchesFor(slugs, filtered: Pick<MemoryEntry, "id" | "people">[], maxDf)`, `rareEntityEdges(filtered: Pick<MemoryEntry, "id" | "people" | "teams" | "tags">[], …)`, `explicitEdges(filtered: Pick<MemoryEntry, "id" | "sources">[], …)`.
3. `SearchOptions` gains `slot?: string;` (doc: "Explicit index slot (`--index-slot`); default: env/active.json"). `SearchReport` gains `index: { slot: string; format: 1 | 2 };` and both early-return reports include `index: { slot: catalog.slot, format: catalog.format }` — move `const catalog = await openCatalog({ slot: opts.slot });` ABOVE the `qs.length === 0` early return.
4. Replace lines 589-592 with:
   ```ts
   const filtered = await catalog.filter(filters);
   const metaById = new Map(filtered.map((m) => [m.id, m]));
   const chainIndex = buildChainIndex(await catalog.linked());
   ```
   (`entries`/`byId` no longer exist; `applyFilters` import stays for the re-export.)
5. Line 615: `const db = await lancedb.connect(catalog.dir);`.
6. Lexical lists (661-669):
   ```ts
   for (const q of qs) {
     const hits = await catalog.lexical(q.text, filteredIds, pool);
     rankLists.push({ kind: "lexical", query: q, ids: hits.map((h) => h.id) });
   }
   ```
7. Reranker block (709-712): hydrate the candidates first: `const docsEntries = await catalog.hydrate(candidates.map((h) => metaById.get(h.id)!)); const docs = docsEntries.map((e, i) => \`${e.title}\n${displayChunkText(bestChunk.get(candidates[i]!.id) ?? e.body)}\`.slice(0, tunables.RERANK_MAX_CHARS));`.
8. Hit assembly (720-757): before `digests`, hydrate once: `const hitEntries = await catalog.hydrate(ranked.hits.map((h) => metaById.get(h.id)!)); const byId = new Map(hitEntries.map((e) => [e.id, e]));` then `digestAnnotations(ranked.hits.map(({ id }) => ({ id, sources: metaById.get(id)?.sources })))` and the existing map body works unchanged (`byId.get(id)!`).
9. Report: add `index: { slot: catalog.slot, format: catalog.format },`.
10. `findSimilar`: `const db = await lancedb.connect(indexDir());` is already in place from Task 3 — unchanged.

`src/recall.ts`: `RecallOptions` gains `slot?: string;` passed as `...(opts.slot ? { slot: opts.slot } : {})`; `RecallReport` gains `index: { slot: string; format: 1 | 2 };` set from `search.report.index` (placed after `chunkRows`).

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/slot-search-parity.test.ts src/legacy-golden.test.ts src/store-headers.test.ts src/index-slots.test.ts src/store-slots.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green. `store-headers.test.ts` now runs on a fresh `main` slot (format 2) — the header leg must work there unchanged. The golden fixture must still match EXCEPT the new `index` key: re-record it once with `UPDATE_GOLDEN=1` and confirm with `git diff src/fixtures/legacy-golden.json` that the ONLY change is the added `"index": { "slot": "legacy", "format": 1 }` per report (an additive field). `npm run eval` uses `.cache/eval/corpus-4000-s42`, whose root has a v6 `meta.json` → legacy → delta 0.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/recall.ts src/index-slots.ts src/index-slots.test.ts src/legacy-golden.test.ts src/store-slots.test.ts src/slot-search-parity.test.ts src/fixtures/legacy-golden.json
git commit -m "searchDetailed reads through the Catalog seam; fresh stores build the new format; report.index names the slot"
```

---

### Task 10: `--index-slot` on recall/query, JSON `index.slot`, harness `--index-slot`, the k1 decision

**Files:**
- Modify: `src/cli.ts` (`cmdQuery`, `cmdRecall`, HELP), `scripts/eval-retrieval.ts`, `package.json`, `docs/eval/fts-spike.md`
- Test: `src/cli-index-slot.test.ts`

**Interfaces:**
- Consumes: `resolveIndexSlotDetailed` (Task 1), `buildSlot` (Task 6), `slotExists`.
- Produces:
  ```ts
  // cli.ts (module-private helper used by every slot-aware command)
  function applyIndexSlotFlag(values: Record<string, unknown>): void;  // validates and exports MEMORY_INDEX_SLOT before any store call
  ```
  `recall --format json` reports `index: { slot, format }`. Harness: `npx tsx scripts/eval-retrieval.ts --index-slot next …` builds the slot when missing (reusing the corpus' vectors) and evaluates it; `npm run eval:slot` compares it against `docs/eval/baseline-4k.json`.

- [ ] **Step 1: Write the failing test**

`src/cli-index-slot.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("recall --index-slot: selects the slot, JSON reports it, unknown slot is a clear error", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-slot-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    cli(root, ["index", "--build", "next"]);
    const viaFlag = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json", "--index-slot", "next"]));
    assert.deepEqual(viaFlag.index, { slot: "next", format: 2 });
    const viaEnv = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json"], { MEMORY_INDEX_SLOT: "next" }));
    assert.equal(viaEnv.index.slot, "next");
    const flagWins = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json", "--index-slot", "legacy"], { MEMORY_INDEX_SLOT: "next" }));
    assert.deepEqual(flagWins.index, { slot: "legacy", format: 1 });
    assert.throws(() => cli(root, ["recall", "otter", "--index-slot", "nope"]), /unknown index slot 'nope'/);
    const text = cli(root, ["query", "otter hiring loop", "--index-slot", "next"]);
    assert.match(text, /Otter hiring loop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/cli-index-slot.test.ts`
Expected: FAIL — parseArgs rejects the unknown `--index-slot` option.

- [ ] **Step 3: Implement**

`src/cli.ts` — add near `filtersFrom` (line 45):

```ts
/**
 * `--index-slot <name>` picks the index slot for this command. Resolution in
 * the engine is lazy (index-slots.ts), so exporting the flag as
 * MEMORY_INDEX_SLOT before the first store call is enough; validating here
 * turns a typo into one clear line instead of a stack trace mid-search.
 */
function applyIndexSlotFlag(values: Record<string, unknown>): void {
  const slot = values["index-slot"] as string | undefined;
  if (!slot) return;
  const { resolveIndexSlotDetailed } = require("./index-slots.js") as typeof import("./index-slots.js");
  resolveIndexSlotDetailed({ override: slot }); // throws "unknown index slot" / "invalid index slot name"
  process.env.MEMORY_INDEX_SLOT = slot;
}
```
Use a static import instead of `require` (ESM): add `import { resolveIndexSlotDetailed } from "./index-slots.js";` at the top and call it directly. Add `"index-slot": { type: "string" }` to the `parseArgs` options of `cmdQuery` and `cmdRecall`, and call `applyIndexSlotFlag(values)` as the first statement after `parseArgs` in both. Pass nothing else: `recall()`/`search()` resolve the env lazily. In `cmdRecall`, `recall(...)` gets `...(values["index-slot"] ? { slot: values["index-slot"] as string } : {})` so the JSON `index` field reflects the flag even if the env were later unset.

HELP: append `[--index-slot <name>]` to the `query` and `recall` usage lines and a comment line:
```
            # --index-slot <name>: query another built index slot (A/B before `index --activate`); MEMORY_INDEX_SLOT=<name> does the same
```

`scripts/eval-retrieval.ts`: add option `"index-slot": { type: "string" }`; after the header backfill loop (line 117) insert:

```ts
// Optional: evaluate a new-format slot. Built on first use from the corpus'
// legacy index (vectors reused by (id, hash)); writers above already keep it
// in sync on later runs.
const slotName = values["index-slot"];
if (slotName) {
  const { slotExists } = await import("../src/index-slots.js");
  if (!slotExists(slotName)) {
    const { buildSlot, formatBuildReport } = await import("../src/slot-build.js");
    const r = await buildSlot({ name: slotName });
    console.error(`slot ${slotName}: built — ${formatBuildReport(r)}`);
  }
  process.env.MEMORY_INDEX_SLOT = slotName;
  console.error(`slot: ${slotName} (MEMORY_LEXICAL=${process.env.MEMORY_LEXICAL ?? "fts"})`);
}
```
and record it in `report.meta.corpus` as `slot: slotName ?? "legacy"` (extend `CorpusMeta` in `src/eval.ts:102` with `slot?: string`).

`package.json` scripts: `"eval:slot": "tsx scripts/eval-retrieval.ts --size 4000 --index-slot next --compare docs/eval/baseline-4k.json"`.

- [ ] **Step 4: Run the tests and the harness on the new slot — the k1 decision**

Run: `node --import tsx --test src/cli-index-slot.test.ts && npm run typecheck && npm test && npm run eval && npm run eval:slot`
Expected: unit tests green; `npm run eval` delta 0; `npm run eval:slot` prints the comparison vs the baseline with the FTS leg (Lance BM25 k1 = 1.2 vs our 1.5).

Decision rule (spec: "harness decides whether to align"):
- If recall@10, MRR and nDCG@10 are each within −0.01 and no non-xfail case flips to fail → keep `fts` as the new-format default. Append to `docs/eval/fts-spike.md` a section `## Harness decision (<date>)` with the three deltas and "fts stays the default for new-format slots".
- Otherwise → change `lexicalMode()`'s default in `src/catalog.ts` to `"postings"`, re-run `npm run eval:slot` (must now be delta 0 up to tie order), and record in the same section that `postings` is the default and `MEMORY_LEXICAL=fts` is opt-in until the k1 gap is closed.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli-index-slot.test.ts scripts/eval-retrieval.ts src/eval.ts package.json docs/eval/fts-spike.md
git commit -m "--index-slot for recall/query, index.slot in JSON, harness --index-slot and the lexical default decision"
```
(add `src/catalog.ts` too if the default changed.)

---

### Task 11: `--activate`, `--prune --confirm`, `index slots` (compat test (d))

**Files:**
- Modify: `src/slot-build.ts` (append `activateSlot`, `pruneSlots`, `slotStatus`)
- Modify: `src/cli.ts` (`cmdIndex`, HELP)
- Test: `src/slot-activate.test.ts`

**Interfaces:**
- Consumes: `readActiveSync`, `writeActive`, `listSlots`, `slotExists`, `slotDir`, `DERIVED_ARTIFACTS`, `PRESERVED_SIDECARS`, `LEGACY_SLOT`, `INDEX_ROOT`, `resolveIndexSlotDetailed`, `readIndexMetaSync` (Task 1); `readManifest` (Task 5); `readLexical` (lexical).
- Produces:
  ```ts
  export async function activateSlot(name: string, root?: string): Promise<{ active: ActiveFile; changed: boolean }>;   // "previous" allowed; "legacy" allowed; refuses unbuilt slots
  export interface PruneReport { active: string; removed: { slot: string; paths: string[] }[]; kept: string[]; confirmed: boolean }
  export async function pruneSlots(opts: { confirm: boolean; root?: string }): Promise<PruneReport>;   // plan only unless confirm; never the active slot; never PRESERVED_SIDECARS
  export interface SlotStatusRow { name: string; format: 1 | 2; active: boolean; previous: boolean; built: boolean; building: boolean; entries: number | null; chunks: number | null; lastSync: string | null }
  export async function slotStatus(root?: string): Promise<SlotStatusRow[]>;
  export function formatSlotTable(rows: SlotStatusRow[]): string;
  ```

- [ ] **Step 1: Write the failing test**

`src/slot-activate.test.ts` (in-process over a temp `.index` root; no entries needed):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_ARTIFACTS, LEGACY_SLOT, PRESERVED_SIDECARS, readActiveSync } from "./index-slots.js";
import { activateSlot, pruneSlots, slotStatus } from "./slot-build.js";

const META2 = { format: 2, indexVersion: 6, embedderId: "fake:hashed-bag", dim: 64, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-10-01T00:00:00.000Z" };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-activate-"));
  writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
  for (const d of ["memory.lance", "memory_headers.lance"]) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, "data"), "x");
  }
  writeFileSync(join(root, "lexical.json"), "{}");
  writeFileSync(join(root, "entries-cache.json"), "{}");
  for (const f of PRESERVED_SIDECARS) if (f !== "active.json") writeFileSync(join(root, f), `{"sidecar":"${f}"}`);
  for (const name of ["next", "other"]) {
    mkdirSync(join(root, "slots", name, "entries.lance"), { recursive: true });
    writeFileSync(join(root, "slots", name, "meta.json"), JSON.stringify(META2));
  }
  mkdirSync(join(root, "slots", "stale__building"), { recursive: true });
  return root;
}

test("compat (d): activate next, then previous, round-trips; activation refuses unbuilt slots", async () => {
  const root = fixture();
  try {
    assert.deepEqual(await activateSlot("next", root), { active: { slot: "next", previous: LEGACY_SLOT }, changed: true });
    assert.deepEqual(readActiveSync(root), { slot: "next", previous: LEGACY_SLOT });
    assert.deepEqual((await activateSlot("next", root)).changed, false, "re-activating the active slot is a no-op");
    assert.deepEqual((await activateSlot("previous", root)).active, { slot: LEGACY_SLOT, previous: "next" });
    assert.deepEqual((await activateSlot("previous", root)).active, { slot: "next", previous: LEGACY_SLOT });
    await assert.rejects(activateSlot("missing", root), /unknown index slot 'missing'/);
    await assert.rejects(activateSlot("stale", root), /unknown index slot 'stale'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compat (d): prune plans without --confirm, refuses the active slot, deletes only derived artifacts", async () => {
  const root = fixture();
  try {
    await activateSlot("next", root);
    const plan = await pruneSlots({ confirm: false, root });
    assert.equal(plan.confirmed, false);
    assert.deepEqual(plan.removed.map((r) => r.slot).sort(), [LEGACY_SLOT, "other", "stale"]);
    assert.deepEqual(plan.kept, ["next"]);
    assert.ok(existsSync(join(root, "slots", "other", "meta.json")), "plan deletes nothing");

    const done = await pruneSlots({ confirm: true, root });
    assert.equal(done.confirmed, true);
    assert.equal(existsSync(join(root, "slots", "other")), false);
    assert.equal(existsSync(join(root, "slots", "stale__building")), false);
    for (const f of DERIVED_ARTIFACTS) assert.equal(existsSync(join(root, f)), false, `${f} removed from the legacy root`);
    for (const f of PRESERVED_SIDECARS) if (f !== "active.json") assert.equal(readFileSync(join(root, f), "utf8"), `{"sidecar":"${f}"}`, `${f} untouched`);
    assert.ok(existsSync(join(root, "slots", "next", "meta.json")), "active slot untouched");
    assert.deepEqual(readActiveSync(root), { slot: "next" }, "previous cleared because it was pruned");

    const again = await pruneSlots({ confirm: true, root });
    assert.deepEqual(again.removed, [], "nothing left to prune");
    await assert.rejects(activateSlot("previous", root), /no previous index slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slotStatus lists every slot with its counts where readable", async () => {
  const root = fixture();
  try {
    const rows = await slotStatus(root);
    assert.deepEqual(rows.map((r) => `${r.name}:${r.format}:${r.built ? "built" : "-"}:${r.building ? "building" : "-"}:${r.active ? "active" : "-"}`), ["legacy:1:built:-:active", "next:2:built:-:-", "other:2:built:-:-", "stale:2:-:building:-"]);
    assert.equal(rows[0]!.chunks, null, "an unreadable table reports null rather than throwing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/slot-activate.test.ts`
Expected: FAIL — `activateSlot` is not exported.

- [ ] **Step 3: Implement**

Append to `src/slot-build.ts`:

```ts
import { readActiveSync, writeActive, listSlots, DERIVED_ARTIFACTS, LEGACY_SLOT, type ActiveFile } from "./index-slots.js";
import { readManifest } from "./catalog-sync.js";
import { readLexical } from "./lexical.js";

/** Write active.json; the previously active slot is recorded as `previous`. "previous" swaps back. */
export async function activateSlot(name: string, root: string = INDEX_ROOT): Promise<{ active: ActiveFile; changed: boolean }> {
  const current = resolveIndexSlotDetailed({ root, env: {} });
  const target = resolveIndexSlotDetailed({ root, env: {}, override: name }).slot; // validates existence, resolves "previous"
  if (target === current.slot && readActiveSync(root)?.slot === target) {
    return { active: readActiveSync(root)!, changed: false };
  }
  const active: ActiveFile = { slot: target, ...(current.slot !== target ? { previous: current.slot } : {}) };
  await writeActive(active, root);
  return { active, changed: true };
}

export interface PruneReport {
  active: string;
  removed: { slot: string; paths: string[] }[];
  kept: string[];
  confirmed: boolean;
}

/**
 * Delete every NON-active slot's derived artifacts (and interrupted
 * `__building` dirs). The legacy root loses only DERIVED_ARTIFACTS — the
 * judgment sidecars at the root are never touched. Plan-only without
 * `confirm`; refuses to touch the active slot by construction.
 */
export async function pruneSlots(opts: { confirm: boolean; root?: string }): Promise<PruneReport> {
  const root = opts.root ?? INDEX_ROOT;
  const active = resolveIndexSlotDetailed({ root, env: {} }).slot;
  const removed: PruneReport["removed"] = [];
  const kept: string[] = [];
  for (const s of listSlots(root)) {
    if (s.active) {
      kept.push(s.name);
      continue;
    }
    if (s.name === LEGACY_SLOT) {
      const paths = DERIVED_ARTIFACTS.map((f) => join(root, f)).filter((p) => existsSync(p));
      if (paths.length) removed.push({ slot: LEGACY_SLOT, paths });
      continue;
    }
    removed.push({ slot: s.name, paths: [s.dir] });
  }
  if (opts.confirm) {
    for (const r of removed) for (const p of r.paths) await rm(p, { recursive: true, force: true });
    const current = readActiveSync(root);
    if (current?.previous && removed.some((r) => r.slot === current.previous)) {
      await writeActive({ slot: current.slot }, root);
    }
  }
  return { active, removed, kept, confirmed: opts.confirm };
}

export interface SlotStatusRow {
  name: string;
  format: 1 | 2;
  active: boolean;
  previous: boolean;
  built: boolean;
  building: boolean;
  entries: number | null;
  chunks: number | null;
  lastSync: string | null;
}

async function countRows(dir: string, table: string): Promise<number | null> {
  try {
    const db = await lancedb.connect(dir);
    if (!(await db.tableNames()).includes(table)) return null;
    return await (await db.openTable(table)).countRows();
  } catch {
    return null;
  }
}

export async function slotStatus(root: string = INDEX_ROOT): Promise<SlotStatusRow[]> {
  const rows: SlotStatusRow[] = [];
  for (const s of listSlots(root)) {
    let entries: number | null = null;
    let lastSync: string | null = null;
    if (s.built && s.format === 1) {
      const lex = await readLexical(join(s.dir, "lexical.json"));
      entries = lex ? lex.docs.filter(Boolean).length : null;
      try {
        lastSync = (await import("node:fs/promises")).stat(join(s.dir, META_FILENAME)).then((st) => st.mtime.toISOString()) && (await (await import("node:fs/promises")).stat(join(s.dir, META_FILENAME))).mtime.toISOString();
      } catch {
        lastSync = null;
      }
    } else if (s.built) {
      entries = await countRows(s.dir, "entries");
      lastSync = (await readManifest(s.dir))?.syncedAt ?? null;
    }
    rows.push({ name: s.name, format: s.format, active: s.active, previous: s.previous, built: s.built, building: s.building, entries, chunks: s.built ? await countRows(s.dir, TABLE) : null, lastSync });
  }
  return rows;
}

export function formatSlotTable(rows: SlotStatusRow[]): string {
  const line = (r: SlotStatusRow) =>
    `${r.name.padEnd(12)} ${String(r.format).padEnd(6)} ${(r.active ? "active" : r.previous ? "previous" : r.building ? "building" : r.built ? "built" : "-").padEnd(9)} ${String(r.entries ?? "-").padStart(7)} ${String(r.chunks ?? "-").padStart(7)}  ${r.lastSync ?? "-"}`;
  return [`${"slot".padEnd(12)} ${"format".padEnd(6)} ${"state".padEnd(9)} ${"entries".padStart(7)} ${"chunks".padStart(7)}  last sync`, ...rows.map(line)].join("\n");
}
```
Simplify the legacy `lastSync` branch to a plain `try { lastSync = (await stat(join(s.dir, META_FILENAME))).mtime.toISOString(); } catch { lastSync = null; }` with `stat` imported from `node:fs/promises` at the top (the one-liner above is only to show the intent — write the simple form).

`src/cli.ts` `cmdIndex`: add options `activate: { type: "string" }, prune: { type: "boolean" }, confirm: { type: "boolean" }` and `allowPositionals: true`; before the `--build` branch:

```ts
  if (positionals[0] === "slots") {
    const { slotStatus, formatSlotTable } = await import("./slot-build.js");
    console.log(formatSlotTable(await slotStatus()));
    const r = resolveIndexSlotDetailed();
    if (r.warning) console.log(`⚠ ${r.warning}`);
    return;
  }
  if (values.activate !== undefined) {
    const { activateSlot } = await import("./slot-build.js");
    const r = await activateSlot(values.activate as string);
    console.log(r.changed ? `✓ active slot: ${r.active.slot}${r.active.previous ? ` (previous: ${r.active.previous} — roll back with: index --activate previous)` : ""}` : `✓ '${r.active.slot}' is already the active slot`);
    return;
  }
  if (values.prune) {
    const { pruneSlots } = await import("./slot-build.js");
    const r = await pruneSlots({ confirm: Boolean(values.confirm) });
    if (r.removed.length === 0) {
      console.log(`(nothing to prune — only the active slot '${r.active}' exists)`);
      return;
    }
    for (const x of r.removed) console.log(`${r.confirmed ? "✓ removed" : "would remove"} slot '${x.slot}': ${x.paths.map(rel).join(", ")}`);
    console.log(r.confirmed ? `kept active slot '${r.active}'; sidecars untouched` : `\nre-run with --confirm to delete (the active slot '${r.active}' and the .index/ sidecars are never touched)`);
    return;
  }
```
HELP lines:
```
  memory index --activate <slot|previous>                   # switch the active slot (writes .index/active.json; the old one is kept as 'previous')
  memory index --prune [--confirm]                          # delete non-active slots' derived artifacts (never sidecars; plan only without --confirm)
  memory index slots                                        # status table: name, format, state, entries, chunks, last sync
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/slot-activate.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/slot-build.ts src/slot-activate.test.ts src/cli.ts
git commit -m "memory index --activate/--prune/slots: user-controlled switch with rollback, prune never touches sidecars"
```

### Task 12: `list` / `person` / `digest` / `promote` / `rules` read through the `Catalog`

**Files:**
- Modify: `src/cli.ts:680-729` (`cmdList`, `cmdPerson`), `:779` (`cmdDigest` scope read), `:854` (`cmdPromote candidates`), `:907` (`cmdRules list`)
- Modify: `src/promote.ts:92-96` (`promotionCandidates` parameter type), `src/graph-rules.ts:155` (`applyRules` read)
- Modify: `src/chains.ts:90-93` (`entryStatus` parameter type)
- Test: `src/cli-catalog-reads.test.ts`

**Interfaces:**
- Consumes: `openCatalog`, `type CatalogEntryMeta` (Task 4); `applyIndexSlotFlag` (Task 10).
- Produces:
  ```ts
  // promote.ts
  export function promotionCandidates(entries: Pick<MemoryEntry, "id" | "date" | "type" | "title" | "path" | "graphs" | "follows" | "sources">[] & { hash?: string }[], …)
  // → simplest: type the parameter as CatalogEntryMeta[] and use `e.hash` instead of `hashEntry(e)` (identical value: metaOf sets hash = hashEntry(e)).
  // chains.ts
  export function entryStatus(e: Pick<MemoryEntry, "id" | "type">, index: Map<string, ChainAnnotation>)
  // graph-rules.ts
  export function matchRule(e: Pick<MemoryEntry, "tags" | "type">, r: GraphRule)  // unchanged
  ```
  `list` and `person` gain `--index-slot <name>`. `digest` keeps writing through `writeEntry` + `syncIndex` (unchanged); only its candidate read moves.

- [ ] **Step 1: Write the failing test**

`src/cli-catalog-reads.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("list/person/promote/rules print the same text on the legacy slot and on a built next slot", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-reads-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    cli(root, ["index", "--build", "next"]);
    const commands: string[][] = [
      ["list"],
      ["list", "--person", "boris-cohen", "--limit", "2"],
      ["list", "--graph", "team-x"],
      ["person", "boris-cohen"],
      ["promote", "candidates", "--to", "team-x"],
      ["rules", "list"],
    ];
    for (const args of commands) {
      const legacy = cli(root, [...args], { MEMORY_INDEX_SLOT: "legacy" });
      const next = cli(root, [...args], { MEMORY_INDEX_SLOT: "next" });
      assert.equal(next, legacy, `output of ${args.join(" ")}`);
    }
    assert.match(cli(root, ["list", "--index-slot", "next", "--type", "pending-decision"]), /Budget freeze pending.*\[resolved → 2026-01-05-budget-decided\]/);
    assert.match(cli(root, ["person", "chen-mizrahi", "--index-slot", "next"]), /Otter hiring loop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/cli-catalog-reads.test.ts`
Expected: FAIL — `--index-slot` unknown for `list`; outputs equal only by accident otherwise (both still read Markdown directly).

- [ ] **Step 3: Implement**

`src/chains.ts:90`: `export function entryStatus(e: Pick<MemoryEntry, "id" | "type">, index: Map<string, ChainAnnotation>)`.

`src/promote.ts:92-96`: change the parameter to `entries: CatalogEntryMeta[]` (import the type from `./catalog.js`), replace `hashEntry(e)` (line 105) with `e.hash`, and drop the now-unused `hashEntry`/`loadAllEntries` imports if nothing else in the file uses them (`dismissPromotion` at line 63 loads entries to find the target — switch it to `(await openCatalog()).byIds([id])` and use `meta.hash`).

`src/graph-rules.ts:155`: `let entries = (await openCatalog()).all()` → `let entries: Pick<MemoryEntry, "id" | "tags" | "type" | "graphs">[] = await (await openCatalog()).all();` and retype `planRules(entries: Pick<MemoryEntry, "id" | "tags" | "type" | "graphs">[], rules)`.

`src/cli.ts`:
- `cmdList`: options gain `"index-slot": { type: "string" }`; body:
  ```ts
  applyIndexSlotFlag(values);
  const catalog = await openCatalog();
  const chainIndex = buildChainIndex(await catalog.linked());
  const entries = (await catalog.filter(await filtersFrom(values))).sort((a, b) => b.date.localeCompare(a.date));
  ```
  (the print loop is unchanged: it reads `date`, `type`, `title`, `graphs`, `path`.)
- `cmdPerson`: options gain `"index-slot"`; `applyIndexSlotFlag(values)`; `const catalog = await openCatalog(); const chainIndex = buildChainIndex(await catalog.linked()); const entries = (await catalog.filter({ person: slug, ...(graph ? { graph } : {}) })).sort(...)`.
- `cmdDigest` line 779: `const raw = (await (await openCatalog()).filter(scope)).filter((e) => e.type !== "summary").sort(...)` — the scaffold reads only `date`, `title`, `type`, `people`, `teams`, `tags`, `id` from metas.
- `cmdPromote candidates` line 854: `const entries = await (await openCatalog()).all();`.
- `cmdRules list` line 907: `const entries = await (await openCatalog()).all();`.
- Import `openCatalog` from `./catalog.js` at the top of `cli.ts`; the `loadAllEntries` import stays for `cmdAdd`/`cmdLink` (those are writers and are migrated in Task 13 only where they read).

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/cli-catalog-reads.test.ts src/promote.test.ts src/graph-rules.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/promote.ts src/graph-rules.ts src/chains.ts src/cli-catalog-reads.test.ts
git commit -m "list/person/digest/promote/rules read through the Catalog; --index-slot on list and person"
```

---

### Task 13: `membership.ts` and `graph-maintenance.ts` read through the `Catalog`

**Files:**
- Modify: `src/membership.ts:32-66` (`copyEntry`), `:85-154` (`moveEntry`), `:166-187` (`removeEntry`), `:210-238` (`deleteGraph`)
- Modify: `src/graph-maintenance.ts:79-107` (`countByKind`/`slugUsage` types), `:221` (`analyzeGraphHygiene` type), `:351-368` (`proposeSlugMerge`), `:386-432` (`applyChainLink`), `:447-452` (`refreshGraphMaintenanceAudit`), `:458-475` (`previewSlugMerge`), `:493-535` (`mergeSlugs`)
- Modify: `src/chains.ts:108-139` (`validateFollowsTargets` parameter type), `src/graphs.ts:298-302` (`validateContainment` already takes `Pick<MemoryEntry, "graphs">` — unchanged)
- Modify: `src/cli.ts:170` (`cmdAdd` reads), `:317-340` (`cmdLink`)
- Test: `src/membership-catalog.test.ts`

**Interfaces:**
- Consumes: `openCatalog`, `Catalog.byIds/referrers/filter/all/hydrate` (Task 4).
- Produces:
  ```ts
  // graph-maintenance.ts
  export type SlugSource = Pick<MemoryEntry, "id" | "date" | "people" | "teams" | "tags">;
  export function slugUsage(entries: SlugSource[], kind: SlugKind): SlugUsage[];
  export function analyzeGraphHygiene(entries: SlugSource[], generatedAt?, dismissed?, proposals?): GraphMaintenanceAudit;
  // chains.ts
  export type FollowsSource = Pick<MemoryEntry, "id" | "date" | "follows">;
  export function validateFollowsTargets(entries: FollowsSource[], source: { id: string; date: string }, targets: string[]): void;
  // membership.ts — a shared helper
  export async function requireEntry(catalog: Catalog, id: string): Promise<MemoryEntry>;   // byIds + hydrate, throws `no entry with id`
  ```
  `validateFollowsTargets` needs the ancestry of each target (it walks `follows` transitively, `chains.ts:125-137`): callers pass `await chainAncestry(catalog, targets)` — a new helper in `chains.ts`:
  ```ts
  export async function chainAncestry(lookup: (ids: string[]) => Promise<FollowsSource[]>, ids: string[]): Promise<FollowsSource[]>;  // BFS over follows via byIds, cycle-safe
  ```

- [ ] **Step 1: Write the failing test**

`src/membership-catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainAncestry } from "./chains.js";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

const MEMBERSHIP = JSON.stringify(join(REPO, "src", "membership.ts"));
const GM = JSON.stringify(join(REPO, "src", "graph-maintenance.ts"));

test("chainAncestry: walks follows transitively through the lookup, cycle-safe", async () => {
  const graph: Record<string, string[]> = { d: ["c"], c: ["b", "x"], b: ["a"], a: [], x: ["c"] };
  const lookup = async (ids: string[]) => ids.filter((id) => id in graph).map((id) => ({ id, date: "2026-01-01", follows: graph[id] }));
  const got = await chainAncestry(lookup, ["d"]);
  assert.deepEqual(got.map((e) => e.id).sort(), ["a", "b", "c", "d", "x"]);
});

test("copy/move/remove/link and slug merge work on a format-2 active slot (reads via the catalog, writes keep every slot in sync)", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-membership-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${join(REPO, "src", "slot-build.ts") && JSON.stringify(join(REPO, "src", "slot-build.ts"))}); await b.buildSlot({ name: "next" }); await b.activateSlot("next");`);
    const r = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       const g = await import(${GM});
       const copy = await m.copyEntry({ id: "2026-01-03-otter-hiring", to: "team-x" });
       const blocked = await m.copyEntry({ id: "2026-01-05-budget-decided", to: "team-x" });
       const link = await g.applyChainLink({ laterId: "2026-01-06-rare-codeword", follows: ["2026-01-03-otter-hiring"], refreshAudit: false });
       const removeBlocked = await m.removeEntry("2026-01-02-quokka-budget");
       const merge = await g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "chen-m", createTarget: true, refreshAudit: false });
       const moved = await m.moveEntry({ id: "2026-01-03-otter-hiring", to: "default" });
       console.log(JSON.stringify({ copy, blocked, link, removeBlocked, merge, moved }));`,
    ) as Record<string, any>;
    assert.equal(r.copy.changed, true);
    assert.deepEqual(r.copy.index.slots.map((s: { slot: string }) => s.slot).sort(), ["legacy", "next"], "writers sync both slots");
    assert.deepEqual(r.blocked.blockedBy, ["2026-01-04-budget-pending"], "containment via catalog byIds");
    assert.equal(r.link.changed, true);
    assert.deepEqual(r.removeBlocked.blockedBy, ["summary-tag-budget"], "referrers via catalog");
    assert.equal(r.merge.affectedEntries, 1);
    assert.equal(r.moved.changed, true);
    assert.equal(existsSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", "2026-01-03-otter-hiring.md")), false, "moved back out of team-x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```
(Write the `buildSlot` import plainly as `const BUILD = JSON.stringify(join(REPO, "src", "slot-build.ts"))` at the top and use `${BUILD}` — the inline `&&` above is a typo to avoid.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/membership-catalog.test.ts`
Expected: FAIL — `chainAncestry` is not exported; the second test may pass by accident (writers still parse Markdown) — it must still pass after the switch.

- [ ] **Step 3: Implement**

`src/chains.ts`: retype `validateFollowsTargets(entries: FollowsSource[], …)` with `export type FollowsSource = Pick<MemoryEntry, "id" | "date" | "follows">;` and append:

```ts
/** Transitive `follows` ancestry of `ids` (ids included), fetched in BFS batches through `lookup`; cycle-safe. */
export async function chainAncestry(
  lookup: (ids: string[]) => Promise<FollowsSource[]>,
  ids: string[],
): Promise<FollowsSource[]> {
  const seen = new Map<string, FollowsSource>();
  let frontier = [...new Set(ids)];
  while (frontier.length) {
    const batch = await lookup(frontier.filter((id) => !seen.has(id)));
    for (const e of batch) seen.set(e.id, e);
    frontier = [...new Set(batch.flatMap((e) => e.follows ?? []))].filter((id) => !seen.has(id));
  }
  return [...seen.values()];
}
```

`src/graph-maintenance.ts`: add `export type SlugSource = Pick<MemoryEntry, "id" | "date" | "people" | "teams" | "tags">;` and retype `countByKind`, `slugUsage`, `analyzeGraphHygiene`, `previewSlugMerge(entries: SlugSource & Pick<MemoryEntry, "title" | "path">[] …)` → simplest: `previewSlugMerge(entries: CatalogEntryMeta[] …)`. Then:
- `proposeSlugMerge` (353): `const entries = await (await openCatalog()).all();`
- `applyChainLink` (391-396): 
  ```ts
  const catalog = await openCatalog();
  const entry = await requireEntry(catalog, opts.laterId);
  const ancestry = await chainAncestry((ids) => catalog.byIds(ids), opts.follows);
  validateFollowsTargets([entry, ...ancestry], entry, opts.follows);
  const targets = await catalog.byIds(opts.follows);
  validateContainment(new Map(targets.map((t) => [t.id, t])), entry, opts.follows);
  ```
- `refreshGraphMaintenanceAudit` (448): `const entries = await (await openCatalog()).all();`
- `mergeSlugs` (501-511): `const catalog = await openCatalog(); const field = FIELD_BY_KIND[opts.kind]; const filter = { [opts.kind]: opts.from } as SearchFilters;` — the target-exists check needs the whole vocabulary: `const metas = await catalog.all(); const preview = previewSlugMerge(metas, …)`; `const affected = await catalog.hydrate(metas.filter((m) => affectedIds.has(m.id)));` (bodies are needed by `writeFrontmatterMerge`, which reads the file anyway — it only needs `path`/`paths`; keep hydrate for the `MemoryEntry` type).

`src/membership.ts`: add
```ts
import { openCatalog, type Catalog } from "./catalog.js";
export async function requireEntry(catalog: Catalog, id: string): Promise<MemoryEntry> {
  const [meta] = await catalog.byIds([id]);
  if (!meta) throw new Error(`no entry with id '${id}'`);
  return (await catalog.hydrate([meta]))[0]!;
}
```
- `copyEntry`: `const catalog = await openCatalog(); const entry = await requireEntry(catalog, opts.id); … const targets = await catalog.byIds(refs); const byId = new Map(targets.map((t) => [t.id, t])); const blockedBy = refs.filter((r) => { const t = byId.get(r); return t !== undefined && !t.graphs.includes(to); });`
- `moveEntry`: same for refs; referrers: `const blockingReferrers = (await catalog.referrers(entry.id)).filter((e) => e.graphs.some((g) => g !== DEFAULT_GRAPH && leaving.includes(g)));`
- `removeEntry`: `const target = await requireEntry(catalog, id); const refs = await catalog.referrers(id); const referrers = refs.filter((e) => e.sources?.includes(id)); const followers = refs.filter((e) => e.follows?.includes(id)).map((e) => e.id);`
- `deleteGraph`: `const members = await catalog.filter({ graph });` (metas carry `graphs`).
- `syncGraphs` keeps `loadEntryFiles` + `groupEntries` (whole-corpus drift repair is explicitly O(N)).

`src/cli.ts`:
- `cmdAdd` (170): keep `loadAllEntries()`? No — switch: `const catalog = await openCatalog();` then `target = values.update ? await requireEntry(catalog, values.update) : sourceIds.length ? (await catalog.hydrate(await catalog.bySourceIds(sourceIds)))[0] : undefined` (preserve the `↻ matches existing` line using `target.source_ids`); follows validation: `validateFollowsTargets([...(await chainAncestry((ids) => catalog.byIds(ids), follows))], { id: sourceId, date: sourceDate }, follows)`; id collision: `const collision = (await catalog.byIds([fm.id]))[0]`; containment: `validateContainment(new Map((await catalog.byIds([...(fm.follows ?? []), ...(fm.sources ?? [])])).map((t) => [t.id, t])), { id: fm.id, graphs }, …)`. The unchanged-hash check (279) compares `hashEntry(candidate)` with `hashEntry(target)` on hydrated entries — unchanged.
- `cmdLink` (317-340): it calls `applyChainLink` — no change beyond removing any direct `loadAllEntries` use.
- Keep `loadAllEntries` imported only if `cmdGraphs list` (491) still uses it — switch that too: `const entries = await (await openCatalog()).all();` and drop the import.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/membership-catalog.test.ts src/graph-maintenance.test.ts src/chains.test.ts src/legacy-golden.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green. `scripts/memory-guards.test.sh` is unaffected (no hook change).

- [ ] **Step 5: Commit**

```bash
git add src/membership.ts src/graph-maintenance.ts src/chains.ts src/cli.ts src/membership-catalog.test.ts
git commit -m "Membership and graph maintenance read through the Catalog: byIds, referrers, chain ancestry"
```

---

### Task 14: `maintenance` slot status + hint; optimize folds FTS on every built slot

**Files:**
- Modify: `src/maintenance.ts:1-6` (imports), `:50-81` (entries + index-health block), `:96-110` (dangling + hygiene inputs)
- Modify: `src/store.ts:342-358` (`optimizeIndex`), `:364-404` (`indexStatus` per slot)
- Modify: `src/cli.ts` (`index --optimize` output line)
- Test: `src/maintenance-slots.test.ts`

**Interfaces:**
- Consumes: `slotStatus`, `formatSlotTable` (Task 11); `openCatalog`; `listBuiltSlots`, `slotDir`, `slotFormat` (Task 1); `openCatalogTables` (Task 5).
- Produces:
  ```ts
  export const SLOT_HINT_ENTRIES = 2000;
  export async function optimizeIndex(cleanupOlderThanDays?: number, opts?: { headerBatch?: number }): Promise<OptimizeIndexResult & { slots: { slot: string; format: 1 | 2; fts: { indexed: number; unindexed: number } | null }[] }>;
  export function slotHint(rows: SlotStatusRow[], entries: number): string | null;   // pure: the one-line hint or null
  ```
  `maintenance` prints under `## Index health` the existing line for the active slot, then the slot table, then `hint: …` when `entries > 2000` and no format-2 slot exists, and `⚠ <warning>` when `active.json` points at a missing slot.

- [ ] **Step 1: Write the failing test**

`src/maintenance-slots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotHint } from "./maintenance.js";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

const row = (name: string, format: 1 | 2, active = false) => ({ name, format, active, previous: false, built: true, building: false, entries: 1, chunks: 1, lastSync: null });

test("slotHint: only when the store is large and no new-format slot exists", () => {
  assert.equal(slotHint([row("legacy", 1, true)], 1999), null);
  assert.match(slotHint([row("legacy", 1, true)], 2001) ?? "", /index --build next.*--index-slot next.*--activate next/);
  assert.equal(slotHint([row("legacy", 1, true), row("next", 2)], 50_000), null);
  assert.equal(slotHint([row("main", 2, true)], 50_000), null);
});

test("maintenance prints the slot table and index --optimize folds the FTS index on the next slot", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-maint-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    const cli = (args: string[]) =>
      execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], { cwd: root, env: { ...process.env, MEMORY_EMBEDDINGS: "fake" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    cli(["index", "--build", "next"]);
    const out = cli(["maintenance"]);
    assert.match(out, /## Index health/);
    assert.match(out, /legacy\s+1\s+active/);
    assert.match(out, /next\s+2\s+built/);
    assert.doesNotMatch(out, /hint: /, "7 entries: no hint");
    const opt = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.optimizeIndex(7)));`) as { slots: { slot: string; fts: { unindexed: number } | null }[] };
    assert.deepEqual(opt.slots.map((s) => s.slot), ["legacy", "next"]);
    assert.equal(opt.slots[1]!.fts?.unindexed, 0, "optimize folded every row into the FTS index");
    assert.equal(opt.slots[0]!.fts, null, "legacy slot has no FTS index");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/maintenance-slots.test.ts`
Expected: FAIL — `slotHint` not exported.

- [ ] **Step 3: Implement**

`src/store.ts` `optimizeIndex` becomes slot-aware:

```ts
export interface OptimizeIndexResult {
  tableExists: boolean;
  cleanupOlderThan: string;
  stats: OptimizeStats | null;
  headers: { embedded: number; remaining: number };
  slots: { slot: string; format: 1 | 2; fts: { indexed: number; unindexed: number } | null }[];
}

export async function optimizeIndex(cleanupOlderThanDays = 7, opts: { headerBatch?: number } = {}): Promise<OptimizeIndexResult> {
  const cleanupOlderThan = new Date(Date.now() - cleanupOlderThanDays * 24 * 60 * 60 * 1000);
  const active = currentSlot();
  const names = [active.slot, ...listBuiltSlots().map((s) => s.name).filter((n) => n !== active.slot)];
  let tableExists = false;
  let stats: OptimizeStats | null = null;
  const slots: OptimizeIndexResult["slots"] = [];
  for (const slot of names) {
    const dir = slotDir(slot);
    const format = slotFormat(slot);
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    const table = await openTable(db);
    if (table) {
      const s = await table.optimize({ cleanupOlderThan });
      if (slot === active.slot) {
        tableExists = true;
        stats = s;
      }
    }
    const ht = await openHeaders(db);
    if (ht) await ht.optimize({ cleanupOlderThan });
    let fts: { indexed: number; unindexed: number } | null = null;
    if (format === 2) {
      const { entries, files } = await openCatalogTables(db);
      if (entries) {
        await entries.optimize({ cleanupOlderThan }); // folds un-indexed rows into the FTS index
        const st = await entries.indexStats("lex_idx").catch(() => null);
        fts = st ? { indexed: st.numIndexedRows, unindexed: st.numUnindexedRows } : null;
      }
      if (files) await files.optimize({ cleanupOlderThan });
    }
    slots.push({ slot, format, fts });
  }
  const headers = await backfillHeaders({ batch: opts.headerBatch }); // active slot only
  return { tableExists, cleanupOlderThan: cleanupOlderThan.toISOString(), stats, headers, slots };
}
```
(import `openCatalogTables` from `./catalog-sync.js`). Note `IndexStatistics.numUnindexedRows` is 0 right after `optimize()` (spike: "optimize() folds 100 un-indexed rows in 0.26 s").

`src/maintenance.ts`:
```ts
import { openCatalog } from "./catalog.js";
import { resolveIndexSlotDetailed } from "./index-slots.js";
import { slotStatus, formatSlotTable, type SlotStatusRow } from "./slot-build.js";

export const SLOT_HINT_ENTRIES = 2000;

/** One line when the store is large and nothing but the legacy slot exists. */
export function slotHint(rows: SlotStatusRow[], entries: number): string | null {
  if (entries <= SLOT_HINT_ENTRIES) return null;
  if (rows.some((r) => r.format === 2 && r.built)) return null;
  return `hint: ${entries} entries — build the next-format index: npx tsx src/cli.ts index --build next, try it with --index-slot next, then --activate next`;
}
```
In `runMaintenance`: `const catalog = await openCatalog(); const entries = await catalog.all();` (digest debt reads `type`, `sources`, `people`, `tags`, `date` — all on metas); the index-health block appends after the lexical line:
```ts
  const rows = await slotStatus();
  console.log(formatSlotTable(rows));
  const hint = slotHint(rows, idx.totalEntries);
  if (hint) console.log(hint);
  const resolution = resolveIndexSlotDetailed();
  if (resolution.warning) console.log(`⚠ ${resolution.warning}`);
```
The `lexical: (missing)` line (line 72-75) must only fire for a format-1 active slot: `if (idx.format === 1) { … }` and the `→ fix` condition likewise uses `lex` only when format 1. Dangling links: `buildChainIndex(await catalog.linked())`; hygiene: `analyzeGraphHygiene(entries, …)` (metas satisfy `SlugSource`).

`src/scheduled-maintenance.ts`: unchanged in code (it calls `optimizeIndex(cleanupDays)`), but `ScheduledMaintenanceState.optimize` now carries `slots` — additive JSON in `maintenance-state.json`.

`src/cli.ts` `index --optimize` line: append ` · slots ${r.slots.map((s) => `${s.slot}${s.fts ? ` (fts ${s.fts.indexed}/${s.fts.indexed + s.fts.unindexed})` : ""}`).join(", ")}`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/maintenance-slots.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/maintenance.ts src/store.ts src/cli.ts src/maintenance-slots.test.ts
git commit -m "maintenance shows slot status and the build hint; optimize folds the FTS index on every built slot"
```

### Task 15: `server.ts` reads through the `Catalog` (no UI change)

**Files:**
- Modify: `src/server.ts:7` (import), `:79-92` (`apiData`), `:196-212` (`apiGraphs`), `:246-265` (`apiGraphManifest`), `:594-600` (warmup)
- Test: `src/server-catalog.test.ts`

**Interfaces:**
- Consumes: `openCatalog` (Task 4). `apiSearch` (`server.ts:121`) already goes through `search()` → `searchDetailed` (Task 9) and is untouched. The slot endpoints and the UI toggle are a follow-up plan.
- Produces: unchanged HTTP contract. `/api/data` entries keep every field they have today (`...e` of a hydrated `MemoryEntry` plus `chain`); the response additionally carries `index.slot`/`index.format` through the existing `indexStatus()` payload (additive, Task 3).

- [ ] **Step 1: Write the failing test**

`src/server-catalog.test.ts` (child process starts the server on a free port, no browser):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

async function withServer<T>(cwd: string, env: Record<string, string>, fn: (base: string) => Promise<T>): Promise<T> {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), "ui", "--port", String(port), "--no-open"], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_UI_MAINTENANCE_STARTUP_DELAY_MS: "3600000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${base}/api/data`);
        if (r.ok) break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(base);
  } finally {
    child.kill("SIGTERM");
  }
}

test("UI API reads via the catalog: /api/data, /api/graphs, /api/graphs/<slug>, /api/search agree between slots", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-server-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex();`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${JSON.stringify(join(REPO, "src", "slot-build.ts"))}); await b.buildSlot({ name: "next" });`);
    const grab = async (base: string) => ({
      data: (await (await fetch(`${base}/api/data`)).json()) as { index: { slot: string }; entries: { id: string; chain?: unknown; body: string }[] },
      graphs: await (await fetch(`${base}/api/graphs`)).json(),
      manifest: await (await fetch(`${base}/api/graphs/team-x`)).json(),
      search: await (await fetch(`${base}/api/search?q=otter+hiring+loop&k=3`)).json(),
    });
    const legacy = await withServer(root, { MEMORY_INDEX_SLOT: "legacy" }, grab);
    const next = await withServer(root, { MEMORY_INDEX_SLOT: "next" }, grab);
    assert.equal(legacy.data.index.slot, "legacy");
    assert.equal(next.data.index.slot, "next");
    const strip = (d: typeof legacy.data) => d.entries.map(({ id, chain, body }) => ({ id, chain, body }));
    assert.deepEqual(strip(next.data), strip(legacy.data));
    assert.deepEqual(next.graphs, legacy.graphs);
    assert.deepEqual(next.manifest, legacy.manifest);
    assert.equal((next.search as { hits: { id: string }[] }).hits[0]!.id, (legacy.search as { hits: { id: string }[] }).hits[0]!.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/server-catalog.test.ts`
Expected: the test may already pass for `/api/data` content (it still parses Markdown), but it fails on nothing visible — treat Step 3 as the behaviour change and Step 4 as the regression gate; after Step 3, `index.slot` and the agreement assertions must hold with `loadAllEntries` no longer imported in `server.ts` (grep-free check: `npm run typecheck` fails if the import is removed while a use remains).

- [ ] **Step 3: Implement**

`src/server.ts`:
- line 7: `import { ROOT } from "./ingest.js";` and `import { openCatalog } from "./catalog.js";`
- `apiData`: 
  ```ts
  const catalog = await openCatalog();
  const [index, metas] = await Promise.all([indexStatus(), catalog.all()]);
  const chainIndex = buildChainIndex(await catalog.linked());
  const entries = await catalog.hydrate(metas.sort((a, b) => b.date.localeCompare(a.date)));
  const payload = entries.map((e) => { … unchanged body … });
  ```
- `apiGraphs`: `const catalog = await openCatalog();` and `entryCount: (await catalog.filter({ graph: store.graph })).length`.
- `apiGraphManifest`: `entryCount: (await (await openCatalog()).filter({ graph: slug })).length`.
- Warmup (596): unchanged (`indexStatus()` + `search`).

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/server-catalog.test.ts && npm run typecheck && npm test && npm run eval`
Expected: green. Then start the UI once by hand (`./start.sh`, user rule: verify UI changes in the running app) and confirm the Browse and Graphs screens render as before — do not commit UI behaviour changes until reviewed locally; this task changes no UI code.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/server-catalog.test.ts
git commit -m "UI server reads entries, graph counts and chains through the Catalog"
```

---

### Task 16: `migrate.sh --build-next-index`, durable state list, compat test (e), and docs

**Files:**
- Modify: `scripts/migration_lib.sh:6-12`, `:65-69`
- Modify: `scripts/migrate.sh:5-21` (usage), `:45-68` (options), `:169-179` (final steps)
- Modify: `scripts/migration-scripts.test.sh` (new case + plan count)
- Modify: `README.md:227-228`, `:275-280`, `:282-339` (new subsection), `AGENTS.md:49`, `:145-162`, `MEMORY-GUARDRAILS.md:85`, `skills/recall-memory/SKILL.md:171-176`

**Interfaces:**
- Consumes: `memory index --build next` (Task 6).
- Produces: `./scripts/migrate.sh --build-next-index` runs `npx tsx src/cli.ts index --build next` after `graphs list`, never `--activate`. `DURABLE_INDEX_STATE_FILES` += `maintenance-state.json`, `graph-maintenance.json`, `active.json` (the archive allow-list is derived from the array, not duplicated). `restore_backup.sh` needs no change: it moves `.index/` aside wholesale and restores only the durable files; a restored `active.json` naming a slot that no longer exists falls back to the legacy root with the warning from Task 1, and `memory index --build <slot>` rebuilds it.

- [ ] **Step 1: Write the failing shell test**

Append to `scripts/migration-scripts.test.sh` before the `printf '1..13\n'` block:

```bash
test_migrate_build_next_index_builds_without_activating() {
  local fixture="$TEST_ROOT/migrate-build-next"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  write_file "$repo/memory/record.txt" "default graph"
  write_file "$repo/.index/active.json" '{"slot":"legacy"}'
  write_file "$repo/.index/maintenance-state.json" '{"status":"success"}'

  MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install --build-next-index --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1

  assert_file_contains "$fixture/npx.log" "tsx src/cli.ts index --build next"
  case "$(<"$fixture/npx.log")" in
    *"--activate"*) fail "migration must never activate a slot" ;;
  esac
  assert_file_contains "$fixture/output" "Building the next-format index slot"
  local archives
  archives=("$fixture"/backups/personal-memory-*.tgz)
  local contents
  contents="$(tar -tzf "${archives[0]}")"
  case "$contents" in *".index/active.json"*) ;; *) fail "active.json missing from the durable backup" ;; esac
  case "$contents" in *".index/maintenance-state.json"*) ;; *) fail "maintenance-state.json missing from the durable backup" ;; esac
  pass "migration --build-next-index builds the next slot, never activates, and backs up the new durable files"
}

test_migrate_without_flag_does_not_build() {
  local fixture="$TEST_ROOT/migrate-no-build"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  write_file "$repo/memory/record.txt" "default graph"
  MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1
  case "$(<"$fixture/npx.log")" in
    *"index --build"*) fail "migration built a slot without --build-next-index" ;;
  esac
  pass "migration without --build-next-index leaves the index alone"
}
```
Change `printf '1..13\n'` to `printf '1..15\n'` and append the two function calls at the end of the file.

- [ ] **Step 2: Run the shell test to verify it fails**

Run: `bash scripts/migration-scripts.test.sh`
Expected: `not ok - … unknown option: --build-next-index` (the script dies on the flag).

- [ ] **Step 3: Implement**

`scripts/migration_lib.sh`:

```bash
DURABLE_INDEX_STATE_FILES=(
  connector-state.json
  promotion-dismissals.json
  chain-dismissals.json
  slug-dismissals.json
  slug-proposals.json
  maintenance-state.json
  graph-maintenance.json
  active.json
)

migration_is_durable_index_path() {
  local candidate="$1" state_file
  [[ "$candidate" == ".index" ]] && return 0
  for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
    [[ "$candidate" == ".index/$state_file" ]] && return 0
  done
  return 1
}
```
and in `migration_validate_archive` replace the hard-coded `.index` case (lines 65-69) with:
```bash
      .index)
        migration_is_durable_index_path "$archive_entry" || die "archive contains a non-durable .index path: $archive_entry"
        ;;
```

`scripts/migrate.sh`: usage gains `  --build-next-index   After migrating, build the next-format search index slot (never activated; try it with --index-slot next).`; option parsing gains
```bash
    --build-next-index)
      BUILD_NEXT_INDEX=1
      shift
      ;;
```
with `BUILD_NEXT_INDEX=0` initialised next to `INSTALL_DEPS=1`; after `npx tsx src/cli.ts graphs list` (line 173) add:
```bash
if (( BUILD_NEXT_INDEX )); then
  log "Building the next-format index slot (not activated)"
  npx tsx src/cli.ts index --build next
  printf 'Try it with: npx tsx src/cli.ts recall "…" --index-slot next\nActivate when satisfied: npx tsx src/cli.ts index --activate next\n'
fi
```

Docs (same commit):

- `README.md:227-228` → "`.index/` stores rebuildable local search artifacts: the legacy index at the root plus optional new-format slots under `.index/slots/<name>/` (`memory index slots`); user judgment such as connector timestamps and dismissals lives in root sidecars that every slot shares."
- `README.md:275-280` (rebuild block) → keep `rm -rf .index` + `npm run index -- --force` as the full reset; add `npm run memory -- index --rebuild` ("rebuild the active slot's catalog/lexical tables, vectors reused").
- `README.md` after line 339: new subsection:
  ```markdown
  ### Switching to the next-format index (optional)

  Stores above ~2,000 entries benefit from the new-format index (catalog
  tables + a full-text index instead of re-parsing every file per command).
  It is never built in place and never forced:

  ```bash
  npx tsx src/cli.ts index --build next            # complete second index beside the current one; existing vectors reused, nothing re-embedded
  npx tsx src/cli.ts recall "…" --index-slot next  # try it (MEMORY_INDEX_SLOT=next does the same for every command)
  npx tsx src/cli.ts index --activate next         # switch; the old index stays as 'previous'
  npx tsx src/cli.ts index --activate previous     # roll back any time (or delete .index/active.json)
  npx tsx src/cli.ts index --prune --confirm       # once satisfied: drop the non-active slots' derived artifacts
  ```

  Writers keep every built slot in sync, so `next` never goes stale while you
  compare. `./scripts/migrate.sh --build-next-index` builds it as part of a
  backup-first upgrade (never activates). `memory maintenance` lists the
  slots and prints a one-line hint when the store is large and only the
  legacy index exists. Fresh stores (no `.index/` yet) build the new format
  directly as slot `main`.
  ```
- `README.md:320-324` backup sentence: add `maintenance-state.json`, `graph-maintenance.json` and `active.json` to the preserved list; note that a restored `active.json` pointing at a slot that was not in the archive falls back to the legacy root until `index --build <slot>` is run again.
- `AGENTS.md:49` table row for `index` → "`index [--force\|--reembed] [--rebuild] [--optimize]` / `index --build <slot> [--dry-run]` / `index --activate <slot\|previous>` / `index --prune [--confirm]` / `index slots` | Re-sync every built slot with Markdown (incremental; `--reembed` re-embeds, `--rebuild` rebuilds tables reusing vectors) / build a complete new-format slot beside the current index / switch the active slot (rollback via `previous`) / drop non-active derived artifacts (sidecars never) / slot status". Add `--index-slot <name>` to the `query`, `recall`, `list`, `person` rows.
- `AGENTS.md:145-162` "Index" bullet → describe root = legacy slot (unchanged shape), `slots/<name>/` = `memory` + `memory_headers` + `entries` + `files` tables + `meta.json {format: 2}` + `catalog-manifest.json`, `active.json`, the shared sidecars, `MEMORY_INDEX_SLOT`/`--index-slot`, `MEMORY_LEXICAL=fts|postings` (new-format slots only), `MEMORY_SYNC=strict`, and replace the revisit note "(b) the corpus nears ~10k+ entries … (fix: page `loadAllEntries()`, still no new DB)" with "(b) above ~2k entries build the new-format slot (`index --build next`): reads go through the catalog tables and the FTS index, bodies are read only for hits; hand edits of existing files are picked up by writer syncs, `index`, or `MEMORY_SYNC=strict` (directory mtimes alone don't see in-place edits)".
- `MEMORY-GUARDRAILS.md:85` row → "`.index/**` | ❌ never | rebuildable derivative; `cli.ts index` regenerates; slots are managed only by `cli.ts index --build\|--activate\|--prune`".
- `skills/recall-memory/SKILL.md:171-176` "Filters available" → append `--index-slot <name>` with the note "(A/B a built slot before `index --activate`; the JSON report's `index.slot` says which one answered)".

- [ ] **Step 4: Run everything**

Run: `bash scripts/migration-scripts.test.sh && npm run typecheck && npm test && npm run eval && npm run eval:slot`
Expected: `1..15`, all ok; unit tests, guards, eval and eval:slot green.

- [ ] **Step 5: Commit**

The commit message mentions store paths, so write it to a file first:

```bash
printf 'migrate.sh --build-next-index, durable sidecar list, and docs for index slots\n' > <scratch>/commit-16.txt
git add scripts/migration_lib.sh scripts/migrate.sh scripts/migration-scripts.test.sh README.md AGENTS.md MEMORY-GUARDRAILS.md skills/recall-memory/SKILL.md
git commit -F <scratch>/commit-16.txt
```

---

## Self-review

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| Phase 3 item 1 — `files` + `entries` tables, pipe-packed frontmatter, `lex`, `len`, `chunks`, btree on id/date/type | 5 |
| `Catalog` API: `filter` (SQL + JS re-check), `byIds`, `linked()` → `buildChainIndex` retyped, `bySourceIds` (metachar-safe), `count`, `all` (explicit O(N)), `hydrate` (readFile + matter for hits) | 3 (retype), 4 (interface, Legacy), 5 (Lance) |
| Reject `\|` in `normalizeSourceId` | 4 |
| Index slots layout, `active.json {slot}`, sidecars at root, `resolveIndexDir` override order flag → env → active.json → root | 1, 3 |
| `index --build <slot>` (default `next`, vectors copied by `(id, hash)`, headers, catalog + FTS, manifest, `__building` rename, idempotent, printed line, `--dry-run`) | 6 |
| `--activate` (`previous` recorded), `--prune` (confirmation; refuses active; never sidecars), `index slots` table | 11 |
| Recall/query/list/person `--index-slot`; `--format json` reports `index.slot` | 9, 10, 12 |
| Writers sync every built slot; `add` prints `↻ synced slot next` | 7 |
| One read seam, shadow mode tested before callers switch; caller order `searchDetailed → cli list/person/digest/promote/rules → membership/graph-maintenance → maintenance → server` | 5 (shadow), 9, 12, 13, 14, 15 |
| Freshness on the read path: manifest `{catalogVersion, generation, dirs, N, avgdl}`, dir-mtime compare, `↻ catalog refreshed`, `MEMORY_SYNC=strict` | 8 |
| `maintenance` slot status + hint > 2000 entries | 14 |
| `migrate.sh --build-next-index` (never activates) | 16 |
| Item 2 — FTS on `entries.lex` with the exact tokenizer options, query `tokenize(q).join(" ")`, `where` + `fullTextSearch().limit(pool)`, un-indexed rows searched, `optimize()` folds (scheduler + `index --optimize`), `bm25Scores` kept as reference behind `MEMORY_LEXICAL=postings\|fts`, `lexical.json` never written for new-format slots, k1 decided by the harness | 5, 7, 10, 14 |
| Item 5 — legacy root keeps `INDEX_VERSION` 6 and its `meta.json` shape; new slots `meta.json {format: 2, embedderId, dim, catalogVersion, vectorIndex, headerTable}`; root `lexical.json`/`entries-cache.json` removed only by `--prune` once a new slot is active; `PRESERVED_SIDECARS`/`DERIVED_ARTIFACTS`; `DURABLE_INDEX_STATE_FILES` += `maintenance-state.json`, `graph-maintenance.json`, `active.json`; `index --rebuild` / `--reembed`; AGENTS.md scale note, README migration section, `.gitignore` (already covers) | 1, 7, 11, 16 |
| Compat (a) v6 fixture, no `active.json` → legacy root, byte-identical | 2 (pinned), 3, 9 (re-asserted) |
| Compat (b) build: zero embed calls, root files hashed before/after, sidecars preserved, re-run no-op, kill mid-build leaves only `__building` | 6 |
| Compat (c) `--index-slot next` same hit set; identical with `MEMORY_RANK_PROFILE=legacy` | 9 |
| Compat (d) activate next → previous round-trip; prune refuses active | 11 |
| Compat (e) `migration-scripts.test.sh` case for `--build-next-index` | 16 |
| Compat (f) `MEMORY_RANK_PROFILE=legacy` reproduces the golden ordering | 2 (end-to-end golden under the legacy profile) + existing `src/ranking.test.ts:133,255` |
| Fresh stores build the new format directly | 9 |
| Compatibility policy: source never rewritten, no schema change, nothing into `memory-graphs/`, `.index/` additive, vectors reused, behaviour pinnable | Global Constraints; every task's tests |

### 2. Spec gaps and places where the code contradicted the spec

1. **`src/graphs.ts` has no `INDEX_DIR`** (the brief said "INDEX_DIR usage at ~line 20"); line 20 is `ROOT = process.cwd()`. Nothing in `graphs.ts` changes.
2. **`linked()` as "rows with `follows <> ''`" is insufficient**: `buildChainIndex` needs the link *targets* too (otherwise every link looks dangling). The plan's `linked()` returns linkers ∪ their valid targets (Task 4/5), which is exactly the chain-member set.
3. **`files` table does not fully replace `entries-cache.json` on the write path yet.** `syncIndex` still loads entries through `loadAllEntries()` (and therefore the root `entries-cache.json`) because the legacy slot, when present, needs full entries anyway. After `--prune` removes `entries-cache.json`, the next write regenerates it. A write-path loader that parses only files whose `(mtimeMs, size)` differ from the `files` table rows (and detects drift from the per-copy hashes there) is the follow-up that makes `add` independent of the JSON cache at 100k. `syncIndex({scope:{paths}})` from the spec is likewise deferred (writers currently stat every file; ~0.5 s at 100k).
4. **Freshness blind spot** (spec accepted implicitly, now explicit): directory mtimes do not change on in-place edits of an existing file. Covered by writer syncs, `memory index`, and `MEMORY_SYNC=strict`; documented in AGENTS.md (Task 16) and asserted in Task 8's test. The legacy slot does not have this gap.
5. **`--prune` asks for confirmation via `--confirm`**, matching the repo's existing non-interactive convention (`graphs delete --confirm`), not an interactive prompt.
6. **Spec says `--build` "embeds … the header rows"**; Phase 2 made the header table dormant (`HEADER_LEG_WEIGHT` 0 by default, table built only when enabled). The build honours `headerLegEnabled()` and reports `headers 0` when dormant — otherwise a build would download/run a model pass that the ranking never uses.
7. **Fresh-store default slot name is `main`** (the spec names none). `--build` still defaults to `next` for existing stores.
8. **Unfiltered reads on the new format still materialize every entry's metadata** (`catalog.filter({})` is a full meta column scan — no bodies). The spec's 100k latency target is item 4's (`--show-timings`) to measure; a lazy candidate set (`byIds` of retrieved ids ∪ their chain neighbours) is the obvious follow-up once timings exist.
9. **The k1 = 1.2 vs 1.5 question** is settled by the harness in Task 10 with both outcomes spelled out; the default is `fts` unless `npm run eval:slot` regresses.
10. **Excluded as instructed, to be separate plans:** IVF vector index (`MEMORY_VECTOR_INDEX`, `VECTOR_INDEX_MIN_ROWS`), `report.timings` / `--show-timings`, `GET /api/index/slots` + `POST /api/index/activate` + the `app.js` toggle/Activate button.

### 3. Placeholder scan

No "TBD/TODO/similar to Task N". Every step carries the code it needs. One self-correction left in place deliberately: Task 11 Step 3 shows the simplified `lastSync` form to write (the inline one-liner is marked as intent only), and Task 13 Step 1 flags the `BUILD` constant to use instead of the inline expression.

### 4. Type consistency

- `resolveIndexSlotDetailed` / `SlotResolution` (Task 1) are what `store.ts` (3, 7, 9), `cli.ts` (10, 11), `slot-build.ts` (6, 11) and `maintenance.ts` (14) consume.
- `Catalog` methods named in Task 4 (`filter`, `byIds`, `linked`, `referrers`, `bySourceIds`, `count`, `all`, `hydrate`, `lexical`, `refresh`) are the only ones used in 5, 9, 12, 13, 14, 15.
- `SyncIndexResult.slots[]` (Task 7) is what Task 13's test and `cmdAdd` read; `SyncStats` in `membership.ts` stays structurally compatible.
- `buildChainIndex(ChainSource[])` (Task 3) accepts both `MemoryEntry[]` and `Catalog.linked()` output.
- `OptimizeIndexResult.slots` (Task 14) is what `cmdIndex --optimize` prints and what `maintenance-state.json` stores (additive).

