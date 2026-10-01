import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { getEmbedder, type Embedder } from "./embed.js";
import { ROOT, chunkEntry, hashEntry, loadAllEntries } from "./ingest.js";
import { listGraphStores } from "./graphs.js";
import {
  BUILDING_SUFFIX,
  CATALOG_VERSION,
  DERIVED_ARTIFACTS,
  FRESH_SLOT,
  INDEX_ROOT,
  LEGACY_SLOT,
  META_FILENAME,
  SlotMetaSchema,
  buildingDir,
  isSlotName,
  listBuiltSlots,
  listSlots,
  readActiveSync,
  readIndexMetaSync,
  resolveIndexSlotDetailed,
  slotDir,
  slotExists,
  writeActive,
  type ActiveFile,
  type SlotMeta,
} from "./index-slots.js";
import { ENTRIES_TABLE, ensureCatalogIndices, manifestFor, readManifest, scanDirMtimes, syncCatalogTables, writeManifest } from "./catalog-sync.js";
import { readLexical } from "./lexical.js";
import type { MemoryEntry } from "./schema.js";
import {
  HEADERS_TABLE,
  INDEX_VERSION,
  TABLE,
  chunkRowId,
  headerLegEnabled,
  headerRecordsFor,
  recordsFor,
  type VectorSource,
} from "./store.js";

/**
 * Build a complete new-format index slot beside the active one, never in
 * place: into `slots/<name>__building/`, renamed to `slots/<name>/` only once
 * every table, meta.json and the manifest are written. A build that dies
 * part-way therefore leaves only the `__building` directory, which the next
 * build discards wholesale — an interrupted build is never resumed.
 *
 * Vectors are reused, never recomputed: a chunk (or header) whose entry still
 * carries the same content hash keeps the vector the active slot already
 * holds, so a rebuild of an unchanged store embeds nothing at all. The build
 * never writes to the active slot and never activates the new one.
 */
export interface BuildReport {
  slot: string;
  dir: string;
  entries: number;
  /** Chunk rows in the new slot. */
  chunks: number;
  /** Chunk vectors copied from the active slot. */
  vectorsReused: number;
  /** Chunk texts embedded — always `chunks - vectorsReused`. */
  embedded: number;
  /** Header rows written; 0 while the header leg is dormant. Their vectors are reused by the same rule. */
  headers: number;
  ms: number;
  dryRun: boolean;
  skipped?: "already-built";
}

export function formatBuildReport(r: BuildReport): string {
  return `entries ${r.entries} · vectors reused ${r.vectorsReused} · embedded ${r.embedded} · headers ${r.headers} · ms ${r.ms}`;
}

/** The slot a build goes to when the caller names none, beside whatever is already in use. */
export const NEXT_SLOT = "next";

/**
 * `next` once the store has an index to sit beside (the legacy root, or any
 * built slot); `main` only on a fresh store with no index at all, where the
 * new format is not "the next one" but the first.
 */
export function defaultBuildName(root: string = INDEX_ROOT): string {
  return listBuiltSlots(root).length > 0 ? NEXT_SLOT : FRESH_SLOT;
}

function requireBuildName(name: string): string {
  if (!isSlotName(name)) {
    throw new Error(
      `invalid index slot name '${name}' — lower-kebab (a-z, 0-9, -), not 'legacy'/'previous', not ending in ${BUILDING_SUFFIX}`,
    );
  }
  return name;
}

/**
 * Vectors in `<dir>/<table>.lance` whose entry still carries the hash the row
 * was embedded at, keyed by the row's natural key (`rowId` for chunks, `id`
 * for headers). Empty when that table does not exist.
 */
async function reusableVectors(
  dir: string,
  table: string,
  wanted: Map<string, string>,
  keyColumn: "rowId" | "id",
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!existsSync(join(dir, `${table}.lance`))) return out;
  const db = await lancedb.connect(dir);
  const t = await db.openTable(table);
  const columns = [...new Set([keyColumn, "id", "hash", "vector"])];
  const rows = (await t.query().select(columns).toArray()) as Record<string, unknown>[];
  for (const r of rows) {
    if (wanted.get(r.id as string) !== (r.hash as string)) continue;
    // Lance hands back a typed array / Arrow vector; the new table wants plain numbers.
    out.set(r[keyColumn] as string, Array.from(r.vector as ArrayLike<number>));
  }
  return out;
}

/**
 * Entries per batch of rows handed to LanceDB. A chunked entry yields a few
 * rows, so this is ~1–2k rows per write: enough for the Arrow conversion to
 * stay amortized, small enough that a 100k-entry build never holds the whole
 * corpus' vectors in JS memory at once.
 */
export const BUILD_BATCH_ENTRIES = 500;

/**
 * Write `entries` into `<table>` a batch at a time: the first non-empty batch
 * creates the table (LanceDB infers the schema from it), the rest are appended.
 * Returns the total rows written. Nothing is created for an empty corpus.
 */
async function writeInBatches(
  db: lancedb.Connection,
  table: string,
  entries: MemoryEntry[],
  rowsFor: (batch: MemoryEntry[]) => Promise<unknown[]>,
): Promise<number> {
  let written = 0;
  let handle: lancedb.Table | null = null;
  for (let i = 0; i < entries.length; i += BUILD_BATCH_ENTRIES) {
    const rows = (await rowsFor(entries.slice(i, i + BUILD_BATCH_ENTRIES))) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    if (!handle) handle = await db.createTable(table, rows);
    else await handle.add(rows);
    written += rows.length;
  }
  return written;
}

export async function buildSlot(
  opts: { name?: string; dryRun?: boolean; force?: boolean; embedder?: Embedder; root?: string } = {},
): Promise<BuildReport> {
  const t0 = performance.now();
  const root = opts.root ?? INDEX_ROOT;
  const name = requireBuildName(opts.name ?? defaultBuildName(root));
  const dir = slotDir(name, root);
  const building = buildingDir(name, root);
  const embedder = opts.embedder ?? getEmbedder();
  const dryRun = Boolean(opts.dryRun);
  const done = (r: Omit<BuildReport, "ms">): BuildReport => ({ ...r, ms: Math.round(performance.now() - t0) });

  if (!opts.force && slotExists(name, root)) {
    return done({ slot: name, dir, entries: 0, chunks: 0, vectorsReused: 0, embedded: 0, headers: 0, dryRun, skipped: "already-built" });
  }

  const entries = await loadAllEntries();
  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));

  // The vector source is the ACTIVE slot (ignoring any --index-slot override),
  // which under --force may be the slot being rebuilt — it is only read, and
  // only before the finished build replaces it.
  const source = resolveIndexSlotDetailed({ root, env: {} });
  const sourceMeta = readIndexMetaSync(source.dir);
  // A different model, dimension or row schema makes the stored vectors
  // unusable: everything is embedded afresh rather than mixed.
  const compatible =
    sourceMeta?.embedderId === embedder.id && sourceMeta?.dim === embedder.dim && sourceMeta?.indexVersion === INDEX_VERSION;
  const headersWanted = headerLegEnabled();
  const chunkVectors = compatible ? await reusableVectors(source.dir, TABLE, wanted, "rowId") : new Map<string, number[]>();
  const headerVectors =
    compatible && headersWanted ? await reusableVectors(source.dir, HEADERS_TABLE, wanted, "id") : new Map<string, number[]>();

  if (dryRun) {
    // The only place a count is predicted rather than measured: the keys come
    // from `chunkRowId`, the same helper `recordsFor` builds its rows with.
    const keys = entries.flatMap((e) => chunkEntry(e).map((_text, i) => chunkRowId(e.id, i)));
    const reused = keys.filter((k) => chunkVectors.has(k)).length;
    return done({
      slot: name,
      dir,
      entries: entries.length,
      chunks: keys.length,
      vectorsReused: reused,
      embedded: keys.length - reused,
      headers: headersWanted ? entries.length : 0,
      dryRun: true,
    });
  }

  // A previous interrupted build is discarded wholesale — never resumed.
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true });
  const db = await lancedb.connect(building);

  // Counted inside the callback `recordsFor` actually calls, so the reported
  // `embedded` can never disagree with what the embedder was asked for.
  // Each row key is asked for exactly once, so a consumed vector is dropped
  // from the reuse map: without that the whole corpus' vectors would be held
  // twice over, once in the map and once in the rows about to be written.
  let vectorsReused = 0;
  const reuseChunk: VectorSource = (rowId) => {
    const vector = chunkVectors.get(rowId);
    if (vector) {
      vectorsReused++;
      chunkVectors.delete(rowId);
    }
    return vector;
  };
  const chunks = await writeInBatches(db, TABLE, entries, (batch) => recordsFor(batch, embedder, reuseChunk));

  let headers = 0;
  if (headersWanted && entries.length > 0) {
    const reuseHeader: VectorSource = (id) => {
      const vector = headerVectors.get(id);
      if (vector) headerVectors.delete(id);
      return vector;
    };
    headers = await writeInBatches(db, HEADERS_TABLE, entries, (batch) => headerRecordsFor(batch, embedder, reuseHeader));
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
  } satisfies SlotMeta);
  await writeFile(join(building, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  if (opts.force) await rm(dir, { recursive: true, force: true });
  await rename(building, dir);
  return done({
    slot: name,
    dir,
    entries: entries.length,
    chunks,
    vectorsReused,
    embedded: chunks - vectorsReused,
    headers,
    dryRun: false,
  });
}

/** Whether a slot currently holds a complete index (`legacy` included — it is a slot that can be empty). */
function isBuiltSlot(slot: string, root: string): boolean {
  return listSlots(root).some((s) => s.name === slot && s.built);
}

/**
 * `slotExists` answers true for `legacy` unconditionally — the root is always
 * a legal name — so activation needs the stronger question: is there an index
 * there to switch to? Pinning an emptied root would leave every later read
 * silently answering from nothing.
 */
function requireBuiltSlot(slot: string, root: string, viaPrevious: boolean): void {
  if (isBuiltSlot(slot, root)) return;
  const what = viaPrevious ? `previous index slot '${slot}' is no longer built` : `index slot '${slot}' is not built`;
  // The legacy root is rebuilt by a sync pinned to it: a plain sync only
  // touches the active slot and the slots that are already built.
  const remedy =
    slot === LEGACY_SLOT
      ? `MEMORY_INDEX_SLOT=${LEGACY_SLOT} npx tsx src/cli.ts index`
      : `npx tsx src/cli.ts index --build ${slot}`;
  throw new Error(`${what} — build it with: ${remedy}   (index slots lists what exists)`);
}

/**
 * Write `active.json`, recording the slot that was active as `previous` so
 * the switch is one command to undo. `"previous"` names that recorded slot,
 * which makes activate / activate-previous a round trip. `"legacy"` is a slot
 * like any other here: it pins the legacy root explicitly instead of leaving
 * the choice to the default. A slot that holds no index is refused, naming
 * the command that would build it, and never becomes a `previous` pointer
 * that the rollback would land on.
 */
export async function activateSlot(name: string, root: string = INDEX_ROOT): Promise<{ active: ActiveFile; changed: boolean }> {
  const current = resolveIndexSlotDetailed({ root, env: {} });
  // Validates the name and resolves "previous"; throws for unknown names.
  const target = resolveIndexSlotDetailed({ root, env: {}, override: name }).slot;
  requireBuiltSlot(target, root, name === "previous");
  const pinned = readActiveSync(root);
  if (target === current.slot && pinned?.slot === target) return { active: pinned, changed: false };
  const rollbackable = current.slot !== target && isBuiltSlot(current.slot, root);
  const active: ActiveFile = { slot: target, ...(rollbackable ? { previous: current.slot } : {}) };
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
 * Delete every NON-active slot's directory (interrupted `__building` builds
 * included). The legacy root is a slot too, but it holds more than an index:
 * it loses only its DERIVED_ARTIFACTS, and only while a new-format slot is
 * what the store actually reads — the judgment sidecars at the root are
 * shared by every slot and are never a candidate. Without `confirm` this
 * plans and deletes nothing.
 */
export async function pruneSlots(opts: { confirm: boolean; root?: string }): Promise<PruneReport> {
  const root = opts.root ?? INDEX_ROOT;
  const slots = listSlots(root);
  // The same resolution listSlots marked its rows with; the fallback covers
  // an index-less store, where the resolved default has no row yet.
  const active = slots.find((s) => s.active)?.name ?? resolveIndexSlotDetailed({ root, env: {} }).slot;
  const removed: PruneReport["removed"] = [];
  const kept: string[] = [];
  for (const s of slots) {
    if (s.active) {
      kept.push(s.name);
      continue;
    }
    if (s.name === LEGACY_SLOT) {
      // The legacy root holds more than an index. Its rebuildable artifacts
      // go only once a new-format slot is what the store actually reads, and
      // only if a legacy index is there at all — whatever else sits at the
      // root (the sidecars, the shared parse cache of an index-less store)
      // belongs to every slot.
      if (!s.built || active === LEGACY_SLOT) {
        if (s.built) kept.push(LEGACY_SLOT);
        continue;
      }
      const paths = DERIVED_ARTIFACTS.map((f) => join(root, f)).filter((p) => existsSync(p));
      if (paths.length > 0) removed.push({ slot: LEGACY_SLOT, paths });
      continue;
    }
    removed.push({ slot: s.name, paths: [s.dir] });
  }
  if (opts.confirm) {
    for (const r of removed) for (const p of r.paths) await rm(p, { recursive: true, force: true });
    const pinned = readActiveSync(root);
    // A `previous` that no longer exists would make `--activate previous`
    // fail at the worst moment; drop it instead.
    if (pinned?.previous && removed.some((r) => r.slot === pinned.previous)) {
      await writeActive({ slot: pinned.slot }, root);
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

/** Row count of one table, or null when the table is absent or unreadable. */
export async function countSlotRows(dir: string, table: string): Promise<number | null> {
  try {
    const db = await lancedb.connect(dir);
    if (!(await db.tableNames()).includes(table)) return null;
    return await (await db.openTable(table)).countRows();
  } catch {
    return null;
  }
}

/**
 * Every slot on disk with what it holds. Purely a read: an unbuilt slot is
 * reported, never materialized, and a table that cannot be opened counts as
 * null rather than failing the whole listing.
 */
export async function slotStatus(root: string = INDEX_ROOT): Promise<SlotStatusRow[]> {
  const rows: SlotStatusRow[] = [];
  for (const s of listSlots(root)) {
    let entries: number | null = null;
    let lastSync: string | null = null;
    if (s.built && s.format === 1) {
      const lex = await readLexical(join(s.dir, "lexical.json"));
      entries = lex ? lex.docs.filter(Boolean).length : null;
      try {
        lastSync = (await stat(join(s.dir, META_FILENAME))).mtime.toISOString();
      } catch {
        lastSync = null;
      }
    } else if (s.built) {
      entries = await countSlotRows(s.dir, ENTRIES_TABLE);
      lastSync = (await readManifest(s.dir))?.syncedAt ?? null;
    }
    rows.push({
      name: s.name,
      format: s.format,
      active: s.active,
      previous: s.previous,
      built: s.built,
      building: s.building,
      entries,
      chunks: s.built ? await countSlotRows(s.dir, TABLE) : null,
      lastSync,
    });
  }
  // A store with no index at all resolves to a slot nothing has built yet;
  // show it rather than leave the table without the slot every command uses.
  const resolved = resolveIndexSlotDetailed({ root, env: {} });
  if (!rows.some((r) => r.name === resolved.slot)) {
    rows.push({
      name: resolved.slot,
      format: resolved.format,
      active: true,
      previous: false,
      built: false,
      building: false,
      entries: null,
      chunks: null,
      lastSync: null,
    });
  }
  return rows;
}

function slotState(r: SlotStatusRow): string {
  if (r.active) return "active";
  if (r.building) return "building";
  if (r.previous) return "previous";
  return r.built ? "built" : "-";
}

export function formatSlotTable(rows: SlotStatusRow[]): string {
  const line = (r: SlotStatusRow) =>
    `${r.name.padEnd(12)} ${String(r.format).padEnd(6)} ${slotState(r).padEnd(9)} ${String(r.entries ?? "-").padStart(7)} ${String(r.chunks ?? "-").padStart(7)}  ${r.lastSync ?? "-"}`;
  const header = `${"slot".padEnd(12)} ${"format".padEnd(6)} ${"state".padEnd(9)} ${"entries".padStart(7)} ${"chunks".padStart(7)}  last sync`;
  return [header, ...rows.map(line)].join("\n");
}
