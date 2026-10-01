import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasAnyEntryFile, loadAllEntries, hashEntry } from "./ingest.js";
import { ensureLexical, bm25Scores, type LexicalIndex } from "./lexical.js";
import { applyFilters, type Filterable, type SearchFilters } from "./ranking.js";
import type { ChainSource } from "./chains.js";
import type { MemoryEntry, MemoryType } from "./schema.js";
import { META_FILENAME, resolveIndexSlotDetailed, warnResolution } from "./index-slots.js";

/**
 * The one read seam over an index slot. `LegacyCatalog` wraps today's
 * loaders (parse everything, BM25 from lexical.json) so the legacy root slot
 * behaves byte-for-byte as before; `LanceCatalog` (catalog-lance.ts) reads the
 * `entries` / `files` tables of a new-format slot. Callers never branch on
 * the format — `openCatalog()` picks the adapter from the slot's meta.json.
 */

export type LexicalMode = "postings" | "fts";

/**
 * MEMORY_LEXICAL: `fts` (LanceDB full-text index, new-format slots) or
 * `postings` (the reference BM25 scorer).
 *
 * `postings` is the default by measurement, not preference: the 4k harness
 * (docs/eval/fts-spike.md, "Harness decision") has FTS ahead on MRR and
 * nDCG@10 and far faster, but Lance's BM25 k1 = 1.2 against our 1.5 shifts
 * enough rankings to flip a gated case (paraphrase-09) to failing. The
 * reference scorer keeps new-format slots bit-compatible with the legacy
 * slot; `MEMORY_LEXICAL=fts` opts in until the k1 gap is closed.
 */
export function lexicalMode(env: Record<string, string | undefined> = process.env): LexicalMode {
  const raw = env.MEMORY_LEXICAL ?? "postings";
  if (raw === "fts" || raw === "postings") return raw;
  throw new Error(`MEMORY_LEXICAL must be one of fts|postings, got '${raw}'`);
}

/** Everything a read needs about an entry short of its body. */
export interface CatalogEntryMeta extends Filterable {
  /**
   * Narrower than `Filterable.type`: every adapter validates the value, so
   * callers that need a `MemoryType` (chain status, rule matching) never cast.
   */
  type: MemoryType;
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
  readonly kind: "legacy" | "lance" | "empty";
  readonly slot: string;
  readonly dir: string;
  readonly format: 1 | 2;
  /** Filter-matching entries (SQL prefilter where available; `matchesFilters` is always the authority). */
  filter(f: SearchFilters): Promise<CatalogEntryMeta[]>;
  /**
   * Metas for `ids`, in REQUEST order: duplicates collapse to their first
   * occurrence, unknown ids are skipped (never thrown). Callers rank → call
   * this → `hydrate` the result, so the ranked order must round-trip intact.
   */
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
   *
   * `filters` is an optional SQL PREFILTER, never the authority: passing the
   * same filters that produced `allowed` lets an FTS backend spend `limit`
   * inside the filtered space instead of on rows `allowed` would discard.
   * The `allowed` check still runs afterwards, so results are identical
   * either way — only recall under a narrow filter differs.
   */
  lexical(query: string, allowed: Set<string>, limit: number, filters?: SearchFilters): Promise<LexicalHit[]>;
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
  private postings: Promise<LexicalIndex> | null = null;

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

  /**
   * `ensureLexical` re-reads and re-parses lexical.json on every call, so the
   * index is memoized per catalog: one search asks for several phrasings and
   * must pay that once, as it did before the seam existed.
   */
  private lexicalIndex(): Promise<LexicalIndex> {
    if (!this.postings) this.postings = (async () => ensureLexical(await this.entries(), this.opts.lexicalPath))();
    return this.postings;
  }

  /** The postings scorer already sees every doc, so `_filters` buys it nothing. */
  async lexical(query: string, allowed: Set<string>, _limit: number, _filters?: SearchFilters): Promise<LexicalHit[]> {
    const idx = await this.lexicalIndex();
    return [...bm25Scores(query, idx).entries()]
      .filter(([id]) => allowed.has(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({ id, score }));
  }

  async refresh(): Promise<{ refreshed: boolean }> {
    return { refreshed: false };
  }
}

/** The one wording for "this slot holds no index yet" — thrown here, printed by the CLI unchanged. */
export function missingIndexMessage(slot: string): string {
  return `no index built for slot "${slot}" — run \`npx tsx src/cli.ts index\``;
}

/**
 * Thrown by `openCatalog` for the one failure mode it documents: a
 * format-2 slot with entries on disk but no index built yet. A typed
 * subclass (rather than a bare `Error`) lets a caller that must answer
 * SOMETHING on this specific failure (the UI server, with a 503) tell it
 * apart from an unrelated throw it should not swallow.
 */
export class MissingIndexError extends Error {
  constructor(readonly slot: string) {
    super(missingIndexMessage(slot));
    this.name = "MissingIndexError";
  }
}

/**
 * A store with no entries and no index: every read is legitimately empty.
 * Answers from nothing and touches no file, so asking an empty store a
 * question never creates the slot it would eventually be indexed into.
 */
export class EmptyCatalog implements Catalog {
  readonly kind = "empty" as const;
  readonly format = 2 as const;

  constructor(
    readonly slot: string,
    readonly dir: string,
  ) {}

  async filter(_f: SearchFilters): Promise<CatalogEntryMeta[]> {
    return [];
  }
  async byIds(_ids: string[]): Promise<CatalogEntryMeta[]> {
    return [];
  }
  async linked(): Promise<ChainSource[]> {
    return [];
  }
  async referrers(_id: string): Promise<CatalogEntryMeta[]> {
    return [];
  }
  async bySourceIds(_ids: string[]): Promise<CatalogEntryMeta[]> {
    return [];
  }
  async count(): Promise<number> {
    return 0;
  }
  async all(): Promise<CatalogEntryMeta[]> {
    return [];
  }
  async hydrate(metas: CatalogEntryMeta[]): Promise<MemoryEntry[]> {
    if (metas.length > 0) throw new Error(`catalog: no entry with id '${metas[0]!.id}'`);
    return [];
  }
  async lexical(_query: string, _allowed: Set<string>, _limit: number, _filters?: SearchFilters): Promise<LexicalHit[]> {
    return [];
  }
  async refresh(): Promise<{ refreshed: boolean }> {
    return { refreshed: false };
  }
}

/**
 * Open the catalog of the resolved slot (`--index-slot` → env → active.json →
 * legacy root → the fresh new-format slot).
 *
 * A READ NEVER BUILDS A SLOT. `syncIndex` (the write path) is the only thing
 * that creates one, so a new-format slot with no meta.json is refused here
 * with the command that builds it — rather than silently materialized and
 * then answered from, which would return lexical-only hits with no vectors
 * and no warning. The exception is a store with no entries at all: there is
 * nothing to index, so the empty answer is the correct one.
 */
export async function openCatalog(opts: { slot?: string } = {}): Promise<Catalog> {
  const r = resolveIndexSlotDetailed(opts.slot ? { override: opts.slot } : {});
  warnResolution(r);
  if (r.format === 1) return new LegacyCatalog(r.slot, r.dir);
  if (!existsSync(join(r.dir, META_FILENAME))) {
    if (await hasAnyEntryFile()) throw new MissingIndexError(r.slot);
    return new EmptyCatalog(r.slot, r.dir);
  }
  const { LanceCatalog } = await import("./catalog-lance.js");
  return LanceCatalog.open({ slot: r.slot, dir: r.dir });
}
