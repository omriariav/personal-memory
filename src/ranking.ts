import type { GraphId } from "./schema.js";
import { DEFAULT_TUNABLES, type RankingTunables } from "./ranking-tunables.js";

/**
 * Pure ranking pipeline: everything between "here are the per-phrasing
 * retrieval lists" and "here is the ordered result". No I/O, no LanceDB, no
 * model — so it is unit-testable and the evaluation harness can sweep it
 * in-process. `store.ts` owns the I/O and calls `rankCandidates`.
 */

export interface SearchFilters {
  person?: string;
  type?: string;
  team?: string;
  tag?: string;
  since?: string; // ISO date inclusive
  until?: string; // ISO date inclusive
  /** Scope to entries that are MEMBERS of this graph; undefined = all graphs. */
  graph?: GraphId;
}

export type QueryOrigin = "primary" | "agent" | "cli";

export interface QuerySpec {
  text: string;
  origin: QueryOrigin;
  weight: number;
}

export type SearchCompleteness = "auto" | "complete" | "complete-if-small" | "none";

export interface RankList {
  kind: "semantic" | "lexical";
  query: QuerySpec;
  ids: string[];
}

/** The slice of an entry the pipeline needs. */
export interface Rankable {
  id: string;
  date: string;
  updated?: string;
}

export interface Filterable extends Rankable {
  type: string;
  people: string[];
  teams: string[];
  tags: string[];
  graphs: string[];
}

// --- filters -----------------------------------------------------------------

export function matchesFilters(e: Filterable, f: SearchFilters): boolean {
  if (f.person && !e.people.includes(f.person)) return false;
  if (f.team && !e.teams.includes(f.team)) return false;
  if (f.tag && !e.tags.includes(f.tag)) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.since && e.date < f.since) return false;
  if (f.until && e.date > f.until) return false;
  if (f.graph && !e.graphs.includes(f.graph)) return false;
  return true;
}

/** Shared metadata filter — the single JS authority over the source of truth. */
export function applyFilters<T extends Filterable>(entries: T[], f: SearchFilters): T[] {
  return entries.filter((e) => matchesFilters(e, f));
}

export function hasAnyFilter(f: SearchFilters): boolean {
  return Boolean(f.person || f.team || f.tag || f.type || f.since || f.until || f.graph);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SQL prefilter mirroring `matchesFilters`, so vector-search truncation
 * happens INSIDE the filtered candidate space. Values failing validation are
 * skipped here (never interpolated); `matchesFilters` still enforces them.
 */
export function whereClause(f: SearchFilters): string | undefined {
  const parts: string[] = [];
  if (f.type && SLUG_RE.test(f.type)) parts.push(`type = '${f.type}'`);
  if (f.since && DATE_RE.test(f.since)) parts.push(`date >= '${f.since}'`);
  if (f.until && DATE_RE.test(f.until)) parts.push(`date <= '${f.until}'`);
  if (f.person && SLUG_RE.test(f.person)) parts.push(`people LIKE '%|${f.person}|%'`);
  if (f.team && SLUG_RE.test(f.team)) parts.push(`teams LIKE '%|${f.team}|%'`);
  if (f.tag && SLUG_RE.test(f.tag)) parts.push(`tags LIKE '%|${f.tag}|%'`);
  if (f.graph && SLUG_RE.test(f.graph)) parts.push(`graphs LIKE '%|${f.graph}|%'`);
  return parts.length ? parts.join(" AND ") : undefined;
}

// --- completeness + candidate pool ------------------------------------------

/**
 * Filtered result sets at or below this size take the exhaustive path: every
 * matching entry enters the ranking, so a filtered query cannot miss — only
 * order (and `k`) limits what is printed.
 */
export const EXHAUSTIVE_LIMIT = 200;

export function shouldExhaustivelyAppend(
  filters: SearchFilters,
  candidateCount: number,
  completeness: SearchCompleteness,
  completeLimit: number,
): boolean {
  if (candidateCount === 0) return false;
  if (completeness === "complete") return true;
  if (completeness === "complete-if-small") return candidateCount <= completeLimit;
  if (completeness === "auto") return hasAnyFilter(filters) && candidateCount <= completeLimit;
  return false;
}

/**
 * Vector-leg truncation horizon. Scales with the corpus so the old fixed 40
 * is no longer a recall ceiling; exhaustive runs widen it to cover the whole
 * filtered set.
 */
export function candidatePool(o: {
  exhaustive: boolean;
  filteredCount: number;
  k: number;
  deep: boolean;
  chunkRows: number;
}): number {
  const mult = o.deep ? 12 : 8;
  return o.exhaustive
    ? Math.min(4096, Math.max(o.filteredCount * 8, 40))
    : Math.min(512, Math.max(o.k * mult, 40, Math.ceil(o.chunkRows / 20)));
}

// --- scoring primitives ------------------------------------------------------

export function rankToRRF(ids: string[], k0 = DEFAULT_TUNABLES.RRF_K0): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, 1 / (k0 + i + 1)));
  return m;
}

/** The date an entry last "spoke": `updated` when newer than `date`. */
export function refDate(e: Pick<Rankable, "date" | "updated">): string {
  return e.updated && e.updated > e.date ? e.updated : e.date;
}

/**
 * Mild recency boost: at most +eps, decaying over `decayDays` of age (by
 * max(date, updated)). At the default 2% it can swap two entries that sit on
 * immediately adjacent ranks of a single list (~1.6% apart) when one is brand
 * new and the other old, but never entries two or more ranks apart — so a
 * real relevance lead is untouchable.
 */
export function recencyMultiplier(
  ref: string,
  now: number,
  eps = DEFAULT_TUNABLES.RECENCY_EPS,
  decayDays = DEFAULT_TUNABLES.RECENCY_DECAY_DAYS,
): number {
  const ageDays = Math.max(0, (now - Date.parse(ref)) / 86_400_000);
  return 1 + eps * Math.exp(-ageDays / decayDays);
}

export function bestRank(lists: RankList[], id: string, kind: RankList["kind"]): number | undefined {
  let best: number | undefined;
  for (const list of lists) {
    if (list.kind !== kind) continue;
    const rank = list.ids.indexOf(id);
    if (rank === -1) continue;
    const oneBased = rank + 1;
    if (best === undefined || oneBased < best) best = oneBased;
  }
  return best;
}

// --- the pipeline ------------------------------------------------------------

export interface RankInput {
  rankLists: RankList[];
  /** The filter-matching candidate space; ids outside it are dropped. */
  filtered: Rankable[];
  /** When true, candidates with no retrieval signal are appended at score 0. */
  exhaustive: boolean;
  k: number;
}

export interface RankedHit {
  id: string;
  score: number;
  breakdown: {
    /** Weighted RRF sum before any multiplier. */
    fused: number;
    /** Recency multiplier applied (1 for complete-scan appends). */
    recency: number;
  };
}

export interface RankOutput {
  hits: RankedHit[];
  /** Candidates carrying at least one retrieval signal. */
  retrievalSignalCount: number;
  /** True when more ranked candidates existed than `k` allowed. */
  limitedByK: boolean;
}

function fuse(lists: RankList[], k0: number): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (const [id, s] of rankToRRF(list.ids, k0)) {
      fused.set(id, (fused.get(id) ?? 0) + s * list.query.weight);
    }
  }
  return fused;
}

export function rankCandidates(
  input: RankInput,
  tunables: RankingTunables = DEFAULT_TUNABLES,
  now: number = Date.now(),
): RankOutput {
  const byId = new Map(input.filtered.map((e) => [e.id, e]));
  const fused = fuse(input.rankLists, tunables.RRF_K0);

  const scored: RankedHit[] = [];
  for (const [id, f] of fused) {
    const e = byId.get(id);
    if (!e) continue;
    const recency = recencyMultiplier(refDate(e), now, tunables.RECENCY_EPS, tunables.RECENCY_DECAY_DAYS);
    scored.push({ id, score: f * recency, breakdown: { fused: f, recency } });
  }
  // Stable sort: exact ties keep first-seen (list) order.
  scored.sort((a, b) => b.score - a.score);
  const retrievalSignalCount = scored.length;

  let ranked = scored;
  if (input.exhaustive) {
    // Recall guarantee: append filter-matching entries with no retrieval
    // signal (newest first) so nothing is droppable before the k-cut.
    const present = new Set(scored.map((r) => r.id));
    const rest = input.filtered
      .filter((e) => !present.has(e.id))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => ({ id: e.id, score: 0, breakdown: { fused: 0, recency: 1 } }));
    ranked = [...scored, ...rest];
  }

  return {
    hits: ranked.slice(0, input.k),
    retrievalSignalCount,
    limitedByK: ranked.length > input.k,
  };
}
