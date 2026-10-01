import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { getEmbedder, type Embedder } from "./embed.js";
import { ROOT, chunkEntry, hashEntry, loadAllEntries } from "./ingest.js";
import { listGraphStores } from "./graphs.js";
import {
  BUILDING_SUFFIX,
  CATALOG_VERSION,
  FRESH_SLOT,
  INDEX_ROOT,
  META_FILENAME,
  SlotMetaSchema,
  buildingDir,
  isSlotName,
  readIndexMetaSync,
  resolveIndexSlotDetailed,
  slotDir,
  slotExists,
  type SlotMeta,
} from "./index-slots.js";
import { ensureCatalogIndices, manifestFor, scanDirMtimes, syncCatalogTables, writeManifest } from "./catalog-sync.js";
import {
  HEADERS_TABLE,
  INDEX_VERSION,
  TABLE,
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

export async function buildSlot(
  opts: { name?: string; dryRun?: boolean; force?: boolean; embedder?: Embedder; root?: string } = {},
): Promise<BuildReport> {
  const t0 = performance.now();
  const name = requireBuildName(opts.name ?? FRESH_SLOT);
  const root = opts.root ?? INDEX_ROOT;
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

  const chunkKeys = entries.flatMap((e) => chunkEntry(e).map((_text, i) => `${e.id}#${i}`));
  const vectorsReused = chunkKeys.filter((k) => chunkVectors.has(k)).length;
  const counts = {
    slot: name,
    dir,
    entries: entries.length,
    chunks: chunkKeys.length,
    vectorsReused,
    embedded: chunkKeys.length - vectorsReused,
    headers: headersWanted ? entries.length : 0,
  };
  if (dryRun) return done({ ...counts, dryRun: true });

  // A previous interrupted build is discarded wholesale — never resumed.
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true });
  const db = await lancedb.connect(building);

  const reuseChunk: VectorSource = (rowId) => chunkVectors.get(rowId);
  const chunkRows = entries.length ? ((await recordsFor(entries, embedder, reuseChunk)) as unknown as Record<string, unknown>[]) : [];
  if (chunkRows.length > 0) await db.createTable(TABLE, chunkRows);

  if (headersWanted && entries.length > 0) {
    const reuseHeader: VectorSource = (id) => headerVectors.get(id);
    const headerRows = (await headerRecordsFor(entries, embedder, reuseHeader)) as unknown as Record<string, unknown>[];
    if (headerRows.length > 0) await db.createTable(HEADERS_TABLE, headerRows);
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
  return done({ ...counts, dryRun: false });
}
