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
    // Preserves the caller's request order (dedup, skip unknown ids) — callers
    // use this after ranking and expect `hydrate` to come back in that order.
    const byId = await this.byId();
    const seen = new Set<string>();
    const out: CatalogEntryMeta[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = byId.get(id);
      if (e) out.push(metaOf(e));
    }
    return out;
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
    return entries
      .filter((e) => members.has(e.id))
      .map(({ id, type, date, updated, follows }) => ({
        id,
        type,
        date,
        ...(updated ? { updated } : {}),
        ...(follows ? { follows } : {}),
      }));
  }

  async referrers(id: string): Promise<CatalogEntryMeta[]> {
    return (await this.entries())
      .filter((e) => (e.follows?.includes(id) ?? false) || (e.sources?.includes(id) ?? false))
      .map(metaOf);
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
