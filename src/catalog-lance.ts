import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import * as lancedb from "@lancedb/lancedb";
import { lexicalMode, type Catalog, type CatalogEntryMeta, type LexicalHit, type LexicalMode } from "./catalog.js";
import { META_COLUMNS, likeLiteral, metaFromRow, openCatalogTables, readManifest, scanDirMtimes, sqlList, syncCatalogFromDisk } from "./catalog-sync.js";
import { ROOT } from "./ingest.js";
import { listGraphStores, type Store } from "./graphs.js";
import { bm25Scores, buildLexicalFromTokens, tokenize, type LexicalIndex } from "./lexical.js";
import { applyFilters, SLUG_RE, whereClause, type SearchFilters } from "./ranking.js";
import type { ChainSource } from "./chains.js";
import { FrontmatterSchema, type CatalogEntryRow, type MemoryEntry } from "./schema.js";

type MetaRow = Omit<CatalogEntryRow, "lex">;

/** See refresh(): sub-ms mtime noise (filesystem clock, a Date round-trip) never counts as a change. */
const MTIME_EPSILON_MS = 5;

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
    const found = new Map<string, CatalogEntryMeta>();
    for (let i = 0; i < valid.length; i += 500) {
      for (const m of this.metas(await this.rows(`id IN (${sqlList(valid.slice(i, i + 500))})`))) found.set(m.id, m);
    }
    // REQUEST order, duplicates collapsed to the first occurrence, unknown ids skipped.
    const out: CatalogEntryMeta[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = found.get(id);
      if (m) out.push(m);
    }
    return out;
  }

  async linked(): Promise<ChainSource[]> {
    const linkers = this.metas(await this.rows("follows <> ''"));
    const targets = [...new Set(linkers.flatMap((m) => m.follows ?? []))];
    const byId = new Map(linkers.map((m) => [m.id, m]));
    for (const t of await this.byIds(targets)) byId.set(t.id, t);
    // `CatalogEntryMeta.type` widens to string (Filterable); the column only ever
    // holds a MemoryType, written from a zod-validated entry by `entryRowFor`.
    return [...byId.values()].map(({ id, type, date, updated, follows }) => ({
      id,
      type: type as MemoryEntry["type"],
      date,
      ...(updated ? { updated } : {}),
      ...(follows ? { follows } : {}),
    }));
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

  async lexical(query: string, allowed: Set<string>, limit: number, filters?: SearchFilters): Promise<LexicalHit[]> {
    if (this.mode === "postings") {
      return [...bm25Scores(query, await this.referenceIndex()).entries()]
        .filter(([id]) => allowed.has(id))
        .sort((a, b) => b[1] - a[1])
        .map(([id, score]) => ({ id, score }));
    }
    const terms = tokenize(query).join(" ");
    if (!terms || !this.table) return [];
    // The prefilter goes on the query BEFORE fullTextSearch, so `limit` is
    // spent inside the filtered space (the spike-validated shape). `allowed`
    // stays the authority below — the SQL clause is only ever a superset.
    const where = filters ? whereClause(filters) : undefined;
    let q = this.table.query();
    if (where) q = q.where(where);
    const rows = (await q
      .fullTextSearch(terms, { columns: "lex" })
      .select(["id", "_score"])
      .limit(limit)
      .toArray()) as { id: string; _score: number }[];
    return rows.filter((r) => allowed.has(r.id)).map((r) => ({ id: r.id, score: r._score }));
  }

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
        const a = dirs[k];
        const b = manifest.dirs[k];
        // A dir appearing/disappearing (key only on one side) is always
        // stale. Otherwise tolerate MTIME_EPSILON_MS: `Date` has no
        // sub-millisecond resolution, so anything that round-trips a stored
        // mtime through one (a hand-reset mtime, a coarser filesystem clock)
        // can read back a few tenths of a ms off with no real change —
        // negligible next to a genuine mutation's multi-ms-or-more gap.
        if (a === undefined || b === undefined || Math.abs(a - b) > MTIME_EPSILON_MS) {
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
}
