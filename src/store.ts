import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { OptimizeStats } from "@lancedb/lancedb";
import { getEmbedder, type Embedder } from "./embed.js";
import { ROOT, chunkEntry, displayChunkText, entrySearchText, hashEntry, headerText, loadAllEntries } from "./ingest.js";
import { listGraphStores } from "./graphs.js";
import {
  CATALOG_VERSION,
  META_FILENAME,
  SlotMetaSchema,
  listBuiltSlots,
  readActiveSync,
  readIndexMetaSync,
  resolveIndexSlotDetailed,
  slotDir,
  slotFormat,
  writeActive,
  type IndexMeta,
  type SlotMeta,
  type SlotResolution,
} from "./index-slots.js";
import {
  dropCatalogTables,
  ensureCatalogIndices,
  manifestFor,
  readManifest,
  scanDirMtimes,
  syncCatalogTables,
  writeManifest,
} from "./catalog-sync.js";
import { openCatalog } from "./catalog.js";
import { packSlugs, type GraphId, type MemoryEntry, type MemoryRecord } from "./schema.js";
import { LEXICAL_PATH, syncLexical, tokenize } from "./lexical.js";
import { buildChainIndex, type ChainAnnotation } from "./chains.js";
import {
  applyFilters,
  bestRank,
  candidatePool,
  digestAnnotations,
  EXHAUSTIVE_LIMIT,
  rankCandidates,
  shouldExhaustivelyAppend,
  SLUG_RE,
  whereClause,
  type QueryOrigin,
  type QuerySpec,
  type RankList,
  type SearchCompleteness,
  type SearchFilters,
  type TimelineState,
} from "./ranking.js";
import { resolveTunables, type RankingTunables } from "./ranking-tunables.js";
import { detectPeople, getAliasIndex, type Detection } from "./people.js";

/**
 * Person slugs used by any entry — the alias index's implicit vocabulary.
 *
 * `slot` is the slot the caller already resolved (`--index-slot`): without it
 * a slot-pinned read would still take this list from the DEFAULT slot, paying
 * a full Markdown parse through `LegacyCatalog` on every alias lookup.
 */
export async function knownPeople(slot?: string): Promise<Set<string>> {
  const people = new Set<string>();
  for (const m of await (await openCatalog(slot ? { slot } : {})).all()) for (const p of m.people) people.add(p);
  return people;
}

/**
 * Entity leg input: how many question people each candidate carries, with
 * ubiquitous slugs (present in more than ENTITY_MAX_DF of candidates) ignored
 * so an omnipresent manager or tag never dominates.
 */
function entityMatchesFor(slugs: string[], filtered: Pick<MemoryEntry, "id" | "people">[], maxDf: number): Map<string, number> {
  const matches = new Map<string, number>();
  if (slugs.length === 0 || filtered.length === 0) return matches;
  const df = new Map<string, number>();
  for (const e of filtered) for (const p of e.people) if (slugs.includes(p)) df.set(p, (df.get(p) ?? 0) + 1);
  const counted = slugs.filter((s) => (df.get(s) ?? 0) / filtered.length <= maxDf);
  if (counted.length === 0) return matches;
  for (const e of filtered) {
    const n = e.people.filter((p) => counted.includes(p)).length;
    if (n > 0) matches.set(e.id, n);
  }
  return matches;
}

// The pure ranking layer lives in ranking.ts; re-exported so existing
// importers (cli, server, recall, membership) keep working unchanged.
export { applyFilters, type QueryOrigin, type QuerySpec, type SearchCompleteness, type SearchFilters };

export const TABLE = "memory";
/**
 * One row per entry: the embedding of title + metadata alone (the header
 * leg). Lives BESIDE the chunk table so adding it never touches existing
 * vectors: changed entries get their row at sync time, the rest are
 * backfilled in bounded batches by `optimizeIndex` / `index --optimize`.
 */
export const HEADERS_TABLE = "memory_headers";
export const HEADER_BACKFILL_BATCH = 500;

/**
 * Supplies an already-computed vector for a row, keyed by that row's natural
 * key (`rowId` for chunks, `id` for headers), so a row whose text is
 * unchanged is copied instead of re-embedded — `index --build` reuses the
 * active slot's vectors this way. `undefined` means "embed this text".
 */
export type VectorSource = (rowKey: string) => number[] | undefined;

/** Same filter columns as the chunk table so `whereClause` prefilters apply. */
export interface HeaderRecord {
  id: string;
  hash: string;
  date: string;
  type: string;
  people: string;
  teams: string;
  tags: string;
  graphs: string;
  text: string;
  vector: number[];
}

export async function headerRecordsFor(
  entries: MemoryEntry[],
  embedder: Embedder,
  reuse?: VectorSource,
): Promise<HeaderRecord[]> {
  const texts = entries.map(headerText);
  const vectors: (number[] | undefined)[] = entries.map((e) => reuse?.(e.id));
  const missing = vectors.flatMap((v, i) => (v ? [] : [i]));
  if (missing.length > 0) {
    const fresh = await embedder.embed(missing.map((i) => texts[i]!));
    missing.forEach((i, j) => {
      vectors[i] = fresh[j]!;
    });
  }
  return entries.map((e, i) => ({
    id: e.id,
    hash: hashEntry(e),
    date: e.date,
    type: e.type,
    people: packSlugs(e.people),
    teams: packSlugs(e.teams),
    tags: packSlugs(e.tags),
    graphs: packSlugs(e.graphs),
    text: texts[i]!,
    vector: vectors[i]!,
  }));
}

/** The header leg is opt-in (HEADER_LEG_WEIGHT > 0); its table is not built otherwise. */
export function headerLegEnabled(): boolean {
  return resolveTunables().HEADER_LEG_WEIGHT > 0;
}

async function openHeaders(db: lancedb.Connection) {
  const names = await db.tableNames();
  return names.includes(HEADERS_TABLE) ? db.openTable(HEADERS_TABLE) : null;
}

async function upsertHeaders(db: lancedb.Connection, records: HeaderRecord[]): Promise<void> {
  if (records.length === 0) return;
  const rows = records as unknown as Record<string, unknown>[];
  const table = await openHeaders(db);
  if (!table) {
    await db.createTable(HEADERS_TABLE, rows);
    return;
  }
  await table.delete(`id IN (${sqlList(records.map((r) => r.id))})`);
  await table.add(rows);
}

/**
 * Bump when the row schema or indexing semantics change: a mismatch (including
 * a meta.json written before versioning existed) forces one clean rebuild of
 * the table from the Markdown source of truth. v2: people/teams/tags columns.
 * v3: semantic chunks include compact metadata headers. v4: graph column
 * (private/public store split). v5: pipe-delimited `graphs` membership column
 * (N named graphs, synced-copy model). v6: the home graph renamed
 * `private` → `default` (persisted membership strings must rewrite).
 */
export const INDEX_VERSION = 6;

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

async function openTable(db: lancedb.Connection) {
  const names = await db.tableNames();
  return names.includes(TABLE) ? db.openTable(TABLE) : null;
}

function sqlList(ids: string[]): string {
  // ids are validated slugs (safe charset), so simple quoting is sufficient.
  return ids.map((i) => `'${i}'`).join(", ");
}

/** The chunk table's primary key. The one place this string is built. */
export function chunkRowId(id: string, chunkIndex: number): string {
  return `${id}#${chunkIndex}`;
}

/** Build the chunk-level records (with vectors) for a set of entries. */
export async function recordsFor(
  entries: MemoryEntry[],
  embedder: Embedder,
  reuse?: VectorSource,
): Promise<MemoryRecord[]> {
  const pending: { entry: MemoryEntry; rowId: string; chunkIndex: number; text: string; hash: string; vector?: number[] }[] = [];
  for (const e of entries) {
    const hash = hashEntry(e);
    chunkEntry(e).forEach((text, chunkIndex) => {
      const rowId = chunkRowId(e.id, chunkIndex);
      pending.push({ entry: e, rowId, chunkIndex, text, hash, vector: reuse?.(rowId) });
    });
  }
  const missing = pending.filter((p) => !p.vector);
  if (missing.length > 0) {
    const vectors = await embedder.embed(missing.map((p) => p.text));
    missing.forEach((p, i) => {
      p.vector = vectors[i]!;
    });
  }
  return pending.map((p) => ({
    rowId: p.rowId,
    id: p.entry.id,
    chunkIndex: p.chunkIndex,
    date: p.entry.date,
    type: p.entry.type,
    title: p.entry.title,
    path: p.entry.path,
    people: packSlugs(p.entry.people),
    teams: packSlugs(p.entry.teams),
    tags: packSlugs(p.entry.tags),
    graphs: packSlugs(p.entry.graphs),
    hash: p.hash,
    text: p.text,
    vector: p.vector!,
  }));
}

export interface SlotSyncStats {
  slot: string;
  format: 1 | 2;
  added: number;
  removed: number;
  unchanged: number;
  /** Why this slot was skipped. Only ever set for a NON-active slot. */
  error?: string;
}

export interface SyncIndexResult {
  /** The active slot's numbers (what existing callers print). */
  added: number;
  removed: number;
  unchanged: number;
  slots: SlotSyncStats[];
}

/**
 * Supplies the rows for a set of changed entries. Shared across slots by
 * `syncIndex` so a changed chunk is embedded exactly once no matter how many
 * slots hold it; rows are keyed by entry id, never reused wholesale, because
 * graph membership is not covered by the content hash.
 */
type RecordSource = (changed: MemoryEntry[]) => Promise<MemoryRecord[]>;
type HeaderSource = (changed: MemoryEntry[]) => Promise<HeaderRecord[]>;

/**
 * A format-2 slot whose persisted catalog version is not the current one. Its
 * entries/files tables and their FTS index are not comparable to today's, so
 * they are dropped and rebuilt from the Markdown — the hash-based incremental
 * diff is version-blind and would see nothing to do. Vectors are untouched: a
 * catalog layout change never invalidates an embedding.
 */
async function catalogVersionStale(dir: string, meta: IndexMeta | null): Promise<boolean> {
  if (meta?.format !== 2 || meta.catalogVersion !== CATALOG_VERSION) return true;
  const manifest = await readManifest(dir);
  return manifest === null || manifest.catalogVersion !== CATALOG_VERSION;
}

/**
 * Sync ONE slot's chunk (and header) tables against the Markdown source of
 * truth: re-embed only entries whose content hash or graph membership
 * changed, drop deleted ones, rebuild from scratch when the embedder or the
 * row schema moved on. Writes that slot's meta.json in its own format.
 */
async function syncSlotVectors(
  db: lancedb.Connection,
  dir: string,
  format: 1 | 2,
  entries: MemoryEntry[],
  embedder: Embedder,
  opts: { force: boolean; records: RecordSource; headers: HeaderSource },
): Promise<{ added: number; removed: number; unchanged: number }> {
  const meta = await readMeta(dir);
  const embedderChanged = !meta || meta.embedderId !== embedder.id || meta.dim !== embedder.dim;
  const versionChanged = meta?.indexVersion !== INDEX_VERSION;
  // Only these discard vectors. A catalog version change does NOT: it is the
  // derived tables it invalidates, and they are rebuilt by the caller.
  const force = opts.force || embedderChanged || versionChanged;

  if (force) {
    const names = await db.tableNames();
    if (names.includes(TABLE)) await db.dropTable(TABLE);
    if (names.includes(HEADERS_TABLE)) await db.dropTable(HEADERS_TABLE);
  }

  let table = await openTable(db);

  // Current per-entry hash + membership from the index. copy/move change
  // membership but NOT the content hash, so the graphs string must
  // participate in change detection or relocated entries keep a stale scope.
  const existing = new Map<string, { hash: string; graphs: string }>();
  if (table && !force) {
    const rows = (await table.query().select(["id", "hash", "graphs"]).toArray()) as {
      id: string;
      hash: string;
      graphs: string;
    }[];
    for (const r of rows) existing.set(r.id, { hash: r.hash, graphs: r.graphs });
  }

  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));

  const changed = entries.filter((e) => {
    const cur = existing.get(e.id);
    return cur?.hash !== wanted.get(e.id) || cur?.graphs !== packSlugs(e.graphs);
  });
  const removedIds = [...existing.keys()].filter((id) => !wanted.has(id));
  const unchanged = entries.length - changed.length;

  // Remove stale + changed rows before re-adding changed ones.
  const toDelete = [...new Set([...removedIds, ...changed.map((e) => e.id)])];
  if (table && toDelete.length > 0) {
    await table.delete(`id IN (${sqlList(toDelete)})`);
  }

  const newRecords = changed.length ? await opts.records(changed) : [];
  if (newRecords.length > 0) {
    const rows = newRecords as unknown as Record<string, unknown>[];
    if (!table) {
      table = await db.createTable(TABLE, rows);
    } else {
      await table.add(rows);
    }
  }

  // Header rows (only while the header leg is enabled — measured as a
  // trade-off, off by default): refreshed for exactly the entries re-embedded
  // above; removed entries drop out; untouched entries keep whatever they had
  // (or nothing, until the backfill reaches them).
  const headers = await openHeaders(db);
  if (headers && removedIds.length > 0) await headers.delete(`id IN (${sqlList(removedIds)})`);
  if (changed.length > 0 && headerLegEnabled()) await upsertHeaders(db, await opts.headers(changed));

  if (format === 1) {
    await writeLegacyMeta(dir, { embedderId: embedder.id, dim: embedder.dim, indexVersion: INDEX_VERSION });
  } else {
    // `builtAt` and the header-table flag belong to the build that created the
    // slot; a sync refreshes the rest without re-dating it.
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
    } satisfies SlotMeta);
    await mkdir(dir, { recursive: true });
    await writeFile(metaPath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return { added: changed.length, removed: removedIds.length, unchanged };
}

/**
 * Incrementally sync the index with the Markdown source of truth — for the
 * active slot AND every other built slot, so a `next` slot under evaluation
 * never goes stale behind the one in use. Entries are embedded once and the
 * resulting rows are shared across the slots that need them.
 *
 * `rebuild` drops and rebuilds the derived catalog/lexical tables of every
 * slot it touches, keeping their vectors; `force` drops the vectors too.
 */
export async function syncIndex(
  opts: { force?: boolean; rebuild?: boolean; slots?: "active" | "all" } = {},
): Promise<SyncIndexResult> {
  const embedder = getEmbedder();
  const entries = await loadAllEntries();
  const active = currentSlot();
  const names =
    opts.slots === "active"
      ? [active.slot]
      : [active.slot, ...listBuiltSlots().map((s) => s.name).filter((n) => n !== active.slot)];

  // One embedding pass for all slots: rows are computed on first demand and
  // replayed per entry id afterwards.
  const chunkMemo = new Map<string, MemoryRecord[]>();
  const records: RecordSource = async (changed) => {
    const missing = changed.filter((e) => !chunkMemo.has(e.id));
    if (missing.length > 0) {
      for (const e of missing) chunkMemo.set(e.id, []);
      for (const r of await recordsFor(missing, embedder)) chunkMemo.get(r.id)!.push(r);
    }
    return changed.flatMap((e) => chunkMemo.get(e.id) ?? []);
  };
  const headerMemo = new Map<string, HeaderRecord>();
  const headers: HeaderSource = async (changed) => {
    const missing = changed.filter((e) => !headerMemo.has(e.id));
    if (missing.length > 0) for (const r of await headerRecordsFor(missing, embedder)) headerMemo.set(r.id, r);
    return changed.flatMap((e) => {
      const r = headerMemo.get(e.id);
      return r ? [r] : [];
    });
  };

  const syncOne = async (slot: string): Promise<SlotSyncStats> => {
    const dir = slotDir(slot);
    const format = slotFormat(slot);
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    // Read BEFORE the sync rewrites meta.json, or the bump is invisible.
    const catalogStale = format === 2 && (await catalogVersionStale(dir, await readMeta(dir)));
    const r = await syncSlotVectors(db, dir, format, entries, embedder, { force: Boolean(opts.force), records, headers });
    if (format === 1) {
      // The legacy slot's lexical leg: `.index/lexical.json`, shape frozen.
      if (opts.rebuild) await rm(LEXICAL_PATH, { force: true });
      await syncLexical(entries);
    } else {
      if (opts.rebuild || catalogStale) await dropCatalogTables(db);
      await syncCatalogTables(db, entries, { root: ROOT });
      await ensureCatalogIndices(db);
      await writeManifest(dir, await manifestFor(db, await scanDirMtimes(listGraphStores(), ROOT), await readManifest(dir)));
    }
    return { slot, format, added: r.added, removed: r.removed, unchanged: r.unchanged };
  };

  // The active slot is the one the caller is about to read from, so its
  // failure still propagates. A corrupt slot BESIDE it must never fail the
  // write that triggered the sync — the Markdown is already on disk.
  const slots: SlotSyncStats[] = [await syncOne(active.slot)];
  for (const slot of names.slice(1)) {
    try {
      slots.push(await syncOne(slot));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      slots.push({ slot, format: slotFormat(slot), added: 0, removed: 0, unchanged: 0, error });
    }
  }
  // A fresh store took the new-format default implicitly. Now that the slot
  // exists on disk, record it: from here on the choice is written down rather
  // than re-derived from "the root looks empty".
  if (active.source === "default" && active.format === 2 && !readActiveSync()) await writeActive({ slot: active.slot });

  const first = slots[0]!;
  return { added: first.added, removed: first.removed, unchanged: first.unchanged, slots };
}

export interface IndexStatus {
  embedderId: string | null;
  dim: number | null;
  totalEntries: number;
  indexedEntries: number;
  staleEntries: number;
  missingEntries: number;
  chunkRows: number;
  slot: string;
  format: 1 | 2;
}

export interface HeaderStatus {
  entries: number;
  /** Entries whose header row matches their current content hash. */
  headers: number;
  /** Entries still awaiting a header row (backfill). */
  missing: number;
}

/** Which entries lack a current header row: (id, hash) not present in the headers table. */
async function headerGaps(db: lancedb.Connection, entries: MemoryEntry[]): Promise<MemoryEntry[]> {
  const headers = await openHeaders(db);
  const have = new Map<string, string>();
  if (headers) {
    const rows = (await headers.query().select(["id", "hash"]).toArray()) as { id: string; hash: string }[];
    for (const r of rows) have.set(r.id, r.hash);
  }
  return entries.filter((e) => have.get(e.id) !== hashEntry(e));
}

/** Read-only header coverage for `maintenance`. Never loads the embedder. */
export async function headerStatus(): Promise<HeaderStatus> {
  const entries = await loadAllEntries();
  let missing = entries.length;
  try {
    const db = await lancedb.connect(indexDir());
    missing = (await headerGaps(db, entries)).length;
  } catch {
    // no index yet
  }
  return { entries: entries.length, headers: entries.length - missing, missing };
}

/**
 * Embed header rows for up to `batch` entries that lack one. Bounded so the
 * weekly job and `index --optimize` never block for a whole corpus; existing
 * chunk vectors are never touched.
 */
export async function backfillHeaders(opts: { batch?: number } = {}): Promise<{ embedded: number; remaining: number }> {
  if (!headerLegEnabled()) return { embedded: 0, remaining: 0 };
  const batch = opts.batch ?? HEADER_BACKFILL_BATCH;
  const entries = await loadAllEntries();
  const dir = indexDir();
  await mkdir(dir, { recursive: true });
  const db = await lancedb.connect(dir);
  const gaps = await headerGaps(db, entries);
  const todo = gaps.slice(0, batch);
  if (todo.length > 0) await upsertHeaders(db, await headerRecordsFor(todo, getEmbedder()));
  return { embedded: todo.length, remaining: gaps.length - todo.length };
}

/** Test seam: forget every header row (simulates an index built before the header leg existed). */
export async function dropHeadersForTest(): Promise<void> {
  const db = await lancedb.connect(indexDir());
  if ((await db.tableNames()).includes(HEADERS_TABLE)) await db.dropTable(HEADERS_TABLE);
}

export interface OptimizeIndexResult {
  tableExists: boolean;
  cleanupOlderThan: string;
  stats: OptimizeStats | null;
  /** Header backfill progress made by this call. */
  headers: { embedded: number; remaining: number };
}

export async function optimizeIndex(
  cleanupOlderThanDays = 7,
  opts: { headerBatch?: number } = {},
): Promise<OptimizeIndexResult> {
  const dir = indexDir();
  await mkdir(dir, { recursive: true });
  const db = await lancedb.connect(dir);
  const table = await openTable(db);
  const cleanupOlderThan = new Date(Date.now() - cleanupOlderThanDays * 24 * 60 * 60 * 1000);
  if (!table) {
    return { tableExists: false, cleanupOlderThan: cleanupOlderThan.toISOString(), stats: null, headers: { embedded: 0, remaining: 0 } };
  }
  const stats = await table.optimize({ cleanupOlderThan });
  const headers = await backfillHeaders({ batch: opts.headerBatch });
  const ht = await openHeaders(db);
  if (ht) await ht.optimize({ cleanupOlderThan });
  return { tableExists: true, cleanupOlderThan: cleanupOlderThan.toISOString(), stats, headers };
}

/**
 * Read-only index health check: compares the Markdown source of truth against
 * the LanceDB index by content hash. Never loads the embedder.
 */
export async function indexStatus(): Promise<IndexStatus> {
  const entries = await loadAllEntries();
  const slot = currentSlot();
  const dir = slot.dir;
  const meta = await readMeta(dir);
  const base: IndexStatus = {
    embedderId: meta?.embedderId ?? null,
    dim: meta?.dim ?? null,
    totalEntries: entries.length,
    indexedEntries: 0,
    staleEntries: 0,
    missingEntries: entries.length,
    chunkRows: 0,
    slot: slot.slot,
    format: slot.format,
  };

  let table: lancedb.Table | null = null;
  try {
    const db = await lancedb.connect(dir);
    table = await openTable(db);
  } catch {
    return base;
  }
  if (!table) return base;

  const rows = (await table.query().select(["id", "hash"]).toArray()) as {
    id: string;
    hash: string;
  }[];
  const indexed = new Map<string, string>();
  for (const r of rows) indexed.set(r.id, r.hash);

  let indexedEntries = 0;
  let staleEntries = 0;
  let missingEntries = 0;
  for (const e of entries) {
    const hash = indexed.get(e.id);
    if (hash === undefined) missingEntries++;
    else if (hash === hashEntry(e)) indexedEntries++;
    else staleEntries++;
  }

  return { ...base, indexedEntries, staleEntries, missingEntries, chunkRows: rows.length };
}

export interface SearchHitReason {
  semanticRank?: number;
  lexicalRank?: number;
  /** Rank in the entity list (entries carrying people named in the question). */
  entityRank?: number;
  /** Best rank in the header (title + metadata vector) lists. */
  headerRank?: number;
  matchedTerms: string[];
  retrievalSignals: string[];
}

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  bestChunk: string;
  /** Timeline context when the entry belongs to a `follows` chain. */
  chain?: ChainAnnotation;
  /** Retrieved hits whose explicit links lent this entry part of their score. */
  spreadFrom?: string[];
  /** On a summary: its cited sources that were also returned. */
  digestOf?: string[];
  /** On a raw entry: returned summaries that cite it. */
  coveredBy?: string[];
  /** Raw cross-encoder score when the hit was in the reranked block. */
  rerankScore?: number;
  reasons?: SearchHitReason;
}

/**
 * Implicit neighbours: entries sharing at least `minShared` RARE slugs
 * (people/teams/tags present in ≤ `maxDf` of the candidates — ubiquitous
 * slugs carry no signal). A ranking-time view only; nothing is persisted.
 */
function rareEntityEdges(
  filtered: Pick<MemoryEntry, "id" | "people" | "teams" | "tags">[],
  minShared: number,
  maxDf: number,
): Map<string, string[]> {
  const n = filtered.length;
  const holders = new Map<string, string[]>();
  for (const e of filtered) {
    for (const slug of [...e.people, ...e.teams, ...e.tags]) (holders.get(slug) ?? holders.set(slug, []).get(slug)!).push(e.id);
  }
  const shared = new Map<string, Map<string, number>>();
  for (const ids of holders.values()) {
    if (ids.length < 2 || ids.length / n > maxDf) continue;
    for (const a of ids) {
      const row = shared.get(a) ?? shared.set(a, new Map()).get(a)!;
      for (const b of ids) if (b !== a) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  const edges = new Map<string, string[]>();
  for (const [a, row] of shared) {
    const ns = [...row].filter(([, c]) => c >= minShared).map(([b]) => b);
    if (ns.length) edges.set(a, ns);
  }
  return edges;
}

/**
 * Explicit neighbours within the candidate space: `follows` both ways (via
 * the chain index) and `sources` both ways (a digest and the raw entries it
 * cites). Nothing inferred — only links a human or agent asserted.
 */
function explicitEdges(
  filtered: Pick<MemoryEntry, "id" | "sources">[],
  filteredIds: Set<string>,
  chainIndex: Map<string, ChainAnnotation>,
): Map<string, string[]> {
  const edges = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b || !filteredIds.has(a) || !filteredIds.has(b)) return;
    (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b);
    (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of filtered) {
    for (const s of e.sources ?? []) link(e.id, s);
    const chain = chainIndex.get(e.id);
    for (const p of chain?.prev ?? []) link(e.id, p);
    for (const n of chain?.next ?? []) link(e.id, n);
  }
  return new Map([...edges].map(([id, set]) => [id, [...set]]));
}

export interface SearchReport {
  filters: SearchFilters;
  completeness: SearchCompleteness;
  exhaustive: boolean;
  candidateCount: number;
  consideredCount: number;
  retrievalSignalCount: number;
  returnedCount: number;
  limitedByK: boolean;
  k: number;
  pool: number;
  chunkRows: number;
  /** The index slot this search read, and its format. */
  index: { slot: string; format: 1 | 2 };
  /** Relative score cutoff outcome (never applied on exhaustive runs). */
  cutoff?: { tau: number; applied: boolean; dropped: number };
  /** People named in the question (resolved through memory/people/ aliases). */
  entities?: { people: string[]; ambiguous: string[] };
  /** Reranker pass, when requested. */
  rerank?: { model: string; n: number; ms: number };
}

export interface SearchResult {
  queries: QuerySpec[];
  hits: SearchHit[];
  report: SearchReport;
}

export interface SearchOptions {
  /** Recall-over-precision preset: wider candidate pools (callers also raise k). */
  deep?: boolean;
  completeness?: SearchCompleteness;
  completeLimit?: number;
  /** Clock for the recency bonus (default: wall clock). Fixed by the eval harness. */
  now?: number;
  /** Per-run ranking overrides (harness sweeps); env MEMORY_RANK_* still applies. */
  tunables?: Partial<RankingTunables>;
  /** Disable the relative score cutoff for this run (`--no-cutoff`). */
  noCutoff?: boolean;
  /** Re-score the top RERANK_N candidates with the local cross-encoder (`--rerank`, MEMORY_RERANK=1). */
  rerank?: boolean;
  /** Explicit index slot (`--index-slot`); default: env/active.json. */
  slot?: string;
}

export const DEFAULT_COMPLETE_LIMIT = EXHAUSTIVE_LIMIT;

function querySpecs(queries: string[] | QuerySpec[]): QuerySpec[] {
  return queries
    .map((q, i) =>
      typeof q === "string"
        ? { text: q, origin: (i === 0 ? "primary" : "agent") as QueryOrigin, weight: 1 }
        : q,
    )
    .map((q) => ({ ...q, text: q.text.trim(), weight: Number.isFinite(q.weight) ? q.weight : 1 }))
    .filter((q) => q.text && q.weight > 0);
}

function matchedTerms(entry: MemoryEntry, qs: QuerySpec[]): string[] {
  const entryTerms = new Set(tokenize(entrySearchText(entry)));
  const terms = new Set<string>();
  for (const q of qs) {
    for (const term of tokenize(q.text)) {
      if (entryTerms.has(term)) terms.add(term);
    }
  }
  return [...terms].sort();
}

/**
 * Hybrid search: semantic (vector) + lexical (BM25), fused via Reciprocal Rank
 * Fusion. Accepts multiple query phrasings — every phrasing contributes a
 * semantic and a lexical ranking list and all lists are fused. Metadata
 * filters constrain candidates BEFORE truncation (SQL prefilter + exhaustive
 * path), so filtered queries don't silently drop matches.
 */
export async function searchDetailed(
  queries: string[] | QuerySpec[],
  filters: SearchFilters = {},
  k = 8,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const qs = querySpecs(queries);
  const completeness = opts.completeness ?? "auto";
  const completeLimit = opts.completeLimit ?? DEFAULT_COMPLETE_LIMIT;
  const tunables = resolveTunables({ ...opts.tunables, ...(opts.noCutoff ? { CUTOFF_TAU: 0 } : {}) });
  const now = opts.now ?? Date.now();
  // Opened before the early returns: every report names the slot it read.
  const catalog = await openCatalog(opts.slot ? { slot: opts.slot } : {});
  const index = { slot: catalog.slot, format: catalog.format };
  if (qs.length === 0) {
    return {
      queries: [],
      hits: [],
      report: {
        filters,
        completeness,
        exhaustive: false,
        candidateCount: 0,
        consideredCount: 0,
        retrievalSignalCount: 0,
        returnedCount: 0,
        limitedByK: false,
        k,
        pool: 0,
        chunkRows: 0,
        index,
      },
    };
  }

  const filtered = await catalog.filter(filters);
  const metaById = new Map(filtered.map((m) => [m.id, m]));
  const chainIndex = buildChainIndex(await catalog.linked());
  if (filtered.length === 0) {
    return {
      queries: qs,
      hits: [],
      report: {
        filters,
        completeness,
        exhaustive: false,
        candidateCount: 0,
        consideredCount: 0,
        retrievalSignalCount: 0,
        returnedCount: 0,
        limitedByK: false,
        k,
        pool: 0,
        chunkRows: 0,
        index,
      },
    };
  }
  const filteredIds = new Set(filtered.map((e) => e.id));
  const exhaustive = shouldExhaustivelyAppend(filters, filtered.length, completeness, completeLimit);

  const db = await lancedb.connect(catalog.dir);
  const table = await openTable(db);

  const chunkRows = table ? await table.countRows() : 0;
  const pool = candidatePool({ exhaustive, filteredCount: filtered.length, k, deep: Boolean(opts.deep), chunkRows });
  const where = whereClause(filters);

  // --- semantic ranking lists, one per phrasing (best chunk per entry) ---
  const bestChunk = new Map<string, string>();
  const rankLists: RankList[] = [];
  if (table && chunkRows > 0) {
    const embedder = getEmbedder();
    const vecs = await embedder.embed(qs.map((q) => q.text));
    for (const [i, qvec] of vecs.entries()) {
      const query = qs[i]!;
      let vq = table.search(qvec) as lancedb.VectorQuery;
      if (where) vq = vq.where(where) as lancedb.VectorQuery;
      const rows = (await vq.limit(pool).toArray()) as { id: string; text: string }[];
      const ids: string[] = [];
      for (const r of rows) {
        if (!filteredIds.has(r.id)) continue; // JS filter is the authority
        if (!ids.includes(r.id)) {
          ids.push(r.id);
          if (!bestChunk.has(r.id)) bestChunk.set(r.id, r.text);
        }
      }
      rankLists.push({ kind: "semantic", query, ids });
    }

    // Header leg: the same phrasings against title+metadata vectors. Entries
    // without a header row yet simply don't appear here (graceful backfill).
    if (tunables.HEADER_LEG_WEIGHT > 0) {
      const headers = await openHeaders(db);
      if (headers && (await headers.countRows()) > 0) {
        for (const [i, qvec] of vecs.entries()) {
          let hq = headers.search(qvec) as lancedb.VectorQuery;
          if (where) hq = hq.where(where) as lancedb.VectorQuery;
          const rows = (await hq.select(["id"]).limit(pool).toArray()) as { id: string }[];
          const ids = rows.map((r) => r.id).filter((id) => filteredIds.has(id));
          rankLists.push({ kind: "header", query: qs[i]!, ids: [...new Set(ids)] });
        }
      }
    }
  }

  // --- lexical ranking lists, one per phrasing, within the filtered set ---
  // `filters` is handed over as a SQL prefilter so an FTS backend spends its
  // limit inside the filtered space; `filteredIds` remains the authority.
  for (const q of qs) {
    const hits = await catalog.lexical(q.text, filteredIds, pool, filters);
    rankLists.push({ kind: "lexical", query: q, ids: hits.map((h) => h.id) });
  }

  // --- fusion, recency, timeline, completeness append, k-cut: the pure pipeline ---
  const timeline = new Map<string, TimelineState>();
  for (const [id, ann] of chainIndex) {
    const resolved = ann.status === "resolved";
    const successor = ann.superseded ? ann.current.id : resolved ? ann.resolvedBy : undefined;
    timeline.set(id, {
      superseded: ann.superseded,
      resolved,
      latest: ann.latest.id === id,
      ...(successor ? { successor } : {}),
    });
  }
  const edges = tunables.SPREAD_EDGE_FRACTION > 0 ? explicitEdges(filtered, filteredIds, chainIndex) : undefined;
  const entityEdges =
    tunables.SPREAD_ENTITY_FRACTION > 0 ? rareEntityEdges(filtered, tunables.SPREAD_MIN_SHARED, tunables.SPREAD_RARE_DF) : undefined;
  let detection: Detection | undefined;
  let entityMatches: Map<string, number> | undefined;
  if (tunables.ENTITY_LEG_WEIGHT > 0) {
    detection = detectPeople(qs[0]!.text, await getAliasIndex(() => knownPeople(index.slot)));
    // Only names that needed an alias to resolve: a typed slug already
    // matches lexically, and boosting its every entry cost exact-title lookups.
    entityMatches = entityMatchesFor(detection.aliased, filtered, tunables.ENTITY_MAX_DF);
  }
  const rankInput = { rankLists, filtered, exhaustive, k, timeline, edges, entityEdges, entityMatches };
  let ranked = rankCandidates(rankInput, tunables, now);
  if (ranked.entityList) rankLists.push(ranked.entityList);

  // Opt-in second pass: a local cross-encoder re-scores the top signal-bearing
  // candidates; the pure pipeline blends them, then lift/timeline/cutoff apply.
  let rerankReport: SearchReport["rerank"];
  if (opts.rerank ?? process.env.MEMORY_RERANK === "1") {
    const { getReranker } = await import("./rerank.js");
    const reranker = getReranker();
    const block = ranked.hits.filter((h) => h.score > 0).slice(0, tunables.RERANK_N);
    // The k-cut may have hidden part of the block: rank once more without a cut.
    const wide = block.length < tunables.RERANK_N ? rankCandidates({ ...rankInput, k: tunables.RERANK_N }, tunables, now) : ranked;
    const candidates = wide.hits.filter((h) => h.score > 0).slice(0, tunables.RERANK_N);
    const t0 = performance.now();
    const docsEntries = await catalog.hydrate(candidates.map((h) => metaById.get(h.id)!));
    const docs = docsEntries.map((e, i) =>
      `${e.title}\n${displayChunkText(bestChunk.get(candidates[i]!.id) ?? e.body)}`.slice(0, tunables.RERANK_MAX_CHARS),
    );
    const scores = await reranker.score(qs[0]!.text, docs);
    const rerankScores = new Map(candidates.map((h, i) => [h.id, scores[i]!]));
    ranked = rankCandidates({ ...rankInput, rerankScores }, tunables, now);
    rerankReport = { model: reranker.id, n: candidates.length, ms: Math.round(performance.now() - t0) };
  }
  const { retrievalSignalCount, limitedByK } = ranked;
  const consideredCount = exhaustive ? filtered.length : retrievalSignalCount;
  // Bodies are read once, for exactly the hits that are returned.
  const hitEntries = await catalog.hydrate(ranked.hits.map((h) => metaById.get(h.id)!));
  const byId = new Map(hitEntries.map((e) => [e.id, e]));
  const digests = digestAnnotations(ranked.hits.map(({ id }) => ({ id, sources: metaById.get(id)?.sources })));
  const hits = ranked.hits.map(({ id, score, breakdown, spreadFrom }) => {
    const rerankScore = breakdown.rerank;
    const entry = byId.get(id)!;
    const chain = chainIndex.get(id);
    const digest = digests.get(id);
    const semanticRank = bestRank(rankLists, id, "semantic");
    const lexicalRank = bestRank(rankLists, id, "lexical");
    const entityRank = bestRank(rankLists, id, "entity");
    const headerRank = bestRank(rankLists, id, "header");
    const retrievalSignals = [
      ...(semanticRank !== undefined ? ["semantic"] : []),
      ...(lexicalRank !== undefined ? ["lexical"] : []),
      ...(headerRank !== undefined ? ["header"] : []),
      ...(entityRank !== undefined ? ["entity"] : []),
      ...(breakdown.rerank !== undefined ? ["rerank"] : []),
      ...(breakdown.spread > 0 ? ["spread"] : []),
      ...(score === 0 && exhaustive ? ["complete-scan"] : []),
    ];
    return {
      entry,
      score,
      bestChunk: displayChunkText(bestChunk.get(id) ?? entry.body.slice(0, 300)),
      ...(chain ? { chain } : {}),
      ...(spreadFrom ? { spreadFrom } : {}),
      ...(digest?.digestOf ? { digestOf: digest.digestOf } : {}),
      ...(digest?.coveredBy ? { coveredBy: digest.coveredBy } : {}),
      ...(rerankScore !== undefined ? { rerankScore } : {}),
      reasons: {
        ...(semanticRank !== undefined ? { semanticRank } : {}),
        ...(lexicalRank !== undefined ? { lexicalRank } : {}),
        ...(headerRank !== undefined ? { headerRank } : {}),
        ...(entityRank !== undefined ? { entityRank } : {}),
        matchedTerms: matchedTerms(entry, qs),
        retrievalSignals,
      },
    };
  });
  return {
    queries: qs,
    hits,
    report: {
      filters,
      completeness,
      exhaustive,
      candidateCount: filtered.length,
      consideredCount,
      retrievalSignalCount,
      returnedCount: hits.length,
      limitedByK,
      k,
      pool,
      chunkRows,
      index,
      cutoff: { tau: tunables.CUTOFF_TAU, ...ranked.cutoff },
      ...(detection ? { entities: { people: detection.slugs, ambiguous: detection.ambiguous } } : {}),
      ...(rerankReport ? { rerank: rerankReport } : {}),
    },
  };
}

export async function search(
  queries: string[],
  filters: SearchFilters = {},
  k = 8,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  return (await searchDetailed(queries, filters, k, opts)).hits;
}

export interface SimilarHit {
  id: string;
  title: string;
  /** Cosine similarity in [0,1]; 1 = identical direction. */
  sim: number;
}

/**
 * Pure semantic near-duplicate lookup: embed `text`, cosine-search the index,
 * and return entries whose best chunk scores `>= minSim`. Used by the add path
 * to guard against silently re-capturing an entry that has no source id.
 * Unlike `search`, this exposes an absolute (thresholdable) similarity.
 */
export async function findSimilar(
  text: string,
  opts: { limit?: number; minSim?: number; graph?: GraphId } = {},
): Promise<SimilarHit[]> {
  const { limit = 5, minSim = 0.92 } = opts;
  const db = await lancedb.connect(indexDir());
  const table = await openTable(db);
  if (!table) return [];

  const embedder = getEmbedder();
  const [qvec] = await embedder.embed([text]);
  // `search(vector)` is typed as Query | VectorQuery; a vector arg yields a
  // VectorQuery at runtime, which is what exposes distanceType().
  let vq = table.search(qvec!) as lancedb.VectorQuery;
  if (opts.graph && SLUG_RE.test(opts.graph)) {
    vq = vq.where(`graphs LIKE '%|${opts.graph}|%'`) as lancedb.VectorQuery;
  }
  // Generous pool: near-duplicates rank at the very top by construction, but
  // multi-chunk entries crowding the head must not push a real dup past the cap.
  const rows = (await vq
    .distanceType("cosine")
    .limit(Math.max(limit * 20, 100))
    .toArray()) as { id: string; title: string; _distance: number }[];

  // Best (smallest-distance) chunk per entry, then threshold + cap.
  const best = new Map<string, SimilarHit>();
  for (const r of rows) {
    const sim = 1 - r._distance;
    const prev = best.get(r.id);
    if (!prev || sim > prev.sim) best.set(r.id, { id: r.id, title: r.title, sim });
  }
  return [...best.values()]
    .filter((h) => h.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}
