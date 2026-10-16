import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { CATALOG_VERSION, CatalogManifestSchema, MANIFEST_FILENAME, type CatalogManifest } from "./index-slots.js";
import { chunkEntry, entrySearchText, groupEntries, hashEntry, parseEntry } from "./ingest.js";
import { tokenize } from "./lexical.js";
import { MemoryTypeSchema, packList, packSlugs, unpackList, type CatalogEntryRow, type CatalogFileRow, type MemoryEntry, type MemoryType } from "./schema.js";
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

/** Every `CatalogEntryRow` column except `lex` — what a meta read selects. */
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

/**
 * The `type` column is written from a zod-validated entry, so a value outside
 * the enum means the table was written by something else or is corrupt —
 * louder as an error naming the row than as a silent cast.
 */
export function memoryTypeOf(type: string, id: string): MemoryType {
  const parsed = MemoryTypeSchema.safeParse(type);
  if (!parsed.success) throw new Error(`catalog: entry '${id}' has unknown type '${type}'`);
  return parsed.data;
}

/**
 * Row → meta. Optional list fields are omitted when empty so a meta is
 * field-identical to `metaOf()` over the same entry (the shadow test compares
 * them with `deepEqual`).
 */
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
    type: memoryTypeOf(row.type, row.id),
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

/** Quoted, comma-separated SQL literal list for an `IN (…)` predicate. */
export function sqlList(ids: string[]): string {
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

/**
 * FTS on `lex` + btree on id/date/type (entries) and relpath (files).
 * Idempotent; a no-op on missing/empty tables. Rows appended after the index
 * was built stay searchable without `optimize()` (spike gate 2).
 */
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

/**
 * mtimeMs of every entries/, entries/YYYY, entries/YYYY/MM and summaries/ dir
 * per store, keyed ROOT-relative (relative(root, dir), not store-relative).
 * Only entries/ is recursed two levels deep; summaries/ subdirectories (none
 * exist today) are not walked.
 *
 * Rounded to the nearest whole millisecond: `readManifest`/`writeManifest`
 * round-trip these values through JSON (exact for any double), but a value
 * that itself came from resetting a directory's mtime (a hand-synced clone,
 * a test) can lose a fraction of a millisecond in the OS's own mtime-set
 * path. Rounding keeps both sides of the read-path freshness comparison
 * (`LanceCatalog.refresh`) exact without weakening it — genuine directory
 * mutations differ by whole milliseconds at minimum.
 */
export async function scanDirMtimes(stores: Pick<Store, "entriesDir" | "summariesDir">[], root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const record = async (dir: string) => {
    if (!existsSync(dir)) return;
    out[relative(root, dir)] = Math.round((await stat(dir)).mtimeMs);
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
