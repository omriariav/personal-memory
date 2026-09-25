import type { GraphId } from "./schema.js";
import { DEFAULT_TUNABLES, IDENTITY_TUNABLES, type RankingTunables } from "./ranking-tunables.js";

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
  kind: "semantic" | "lexical" | "entity" | "header";
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

export function rankToRRF(ids: string[], k0 = IDENTITY_TUNABLES.RRF_K0): Map<string, number> {
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
  eps = IDENTITY_TUNABLES.RECENCY_EPS,
  decayDays = IDENTITY_TUNABLES.RECENCY_DECAY_DAYS,
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

/** What the ranking needs to know about an entry's place in a `follows` chain. */
export interface TimelineState {
  /** A later same-type or closing entry replaced this one's state. */
  superseded: boolean;
  /** An open item (pending-decision / todo) that has been settled. */
  resolved: boolean;
  /** This entry is the newest member of its chain. */
  latest: boolean;
  /** The entry holding the state now (chain `current`), or the resolver of an open item. */
  successor?: string;
}

export interface RankInput {
  rankLists: RankList[];
  /** The filter-matching candidate space; ids outside it are dropped. */
  filtered: Rankable[];
  /** When true, candidates with no retrieval signal are appended at score 0. */
  exhaustive: boolean;
  k: number;
  /** Chain state per id (only chain members need an entry). */
  timeline?: Map<string, TimelineState>;
  /**
   * Explicit neighbours per id (follows both ways, sources both ways),
   * already restricted to the candidate space by the caller.
   */
  edges?: Map<string, string[]>;
  /** id → number of question entities (people/teams/tags) the entry carries. */
  entityMatches?: Map<string, number>;
  /** Cross-encoder scores for the reranked block (second pass); absent = no rerank. */
  rerankScores?: Map<string, number>;
}

export interface RankedHit {
  id: string;
  score: number;
  breakdown: {
    /** Weighted RRF sum before any multiplier. */
    fused: number;
    /** Recency multiplier applied (1 for complete-scan appends). */
    recency: number;
    /** Additive gain lent by explicit neighbours (0 when off). */
    spread: number;
    /** Floor applied because a stale predecessor was retrieved (0 when not raised). */
    lift: number;
    /** Timeline multiplier applied (1 when not a chain member or at identity). */
    timeline: number;
    /** Raw cross-encoder score when this hit was in the reranked block. */
    rerank?: number;
  };
  /** Seeds whose spread or lift reached this entry (strongest first). */
  spreadFrom?: string[];
}

/**
 * One hop over explicit edges: the top-N base hits each lend a fraction of
 * their score to a bounded number of neighbours. Gains take the max across
 * seeds so hubs never compound. Neighbours with no prior signal enter the
 * ranking with fused = 0 (they carry no retrieval signal of their own).
 */
function spreadExplicit(
  base: RankedHit[],
  input: RankInput,
  t: RankingTunables,
  byId: Map<string, Rankable>,
): RankedHit[] {
  const spread = t.SPREAD_EDGE_FRACTION > 0 && input.edges;
  if (!spread) return base;
  const byScore = new Map(base.map((h) => [h.id, h.score]));
  const gain = new Map<string, { value: number; from: string }>();
  const lend = (to: string, value: number, from: string) => {
    const cur = gain.get(to);
    if (!cur || value > cur.value) gain.set(to, { value, from });
  };
  if (spread) {
    const seeds = [...base].sort((a, b) => b.score - a.score).slice(0, t.SPREAD_TOP_N);
    for (const seed of seeds) {
      const neighbours = (input.edges!.get(seed.id) ?? [])
        .filter((n) => n !== seed.id && byId.has(n))
        .sort((a, b) => (byScore.get(b) ?? 0) - (byScore.get(a) ?? 0) || byId.get(b)!.date.localeCompare(byId.get(a)!.date))
        .slice(0, t.SPREAD_FANOUT);
      for (const n of neighbours) lend(n, t.SPREAD_EDGE_FRACTION * seed.score, seed.id);
    }
  }
  const out = base.map((h) => ({ ...h, breakdown: { ...h.breakdown } }));
  const present = new Map(out.map((h) => [h.id, h]));
  const blank = (id: string): RankedHit => ({ id, score: 0, breakdown: { fused: 0, recency: 1, spread: 0, lift: 0, timeline: 1 } });
  for (const [id, g] of gain) {
    let h = present.get(id);
    if (!h) {
      h = blank(id);
      out.push(h);
      present.set(id, h);
    }
    h.breakdown.spread = g.value;
    h.spreadFrom = [g.from];
  }

  return out;
}

export interface DigestAnnotation {
  /** On a summary hit: its `sources` that were also returned. */
  digestOf?: string[];
  /** On a raw hit: returned summaries that cite it. */
  coveredBy?: string[];
}

/**
 * Digest awareness without reordering: a rollup and the raw entries it
 * cites point at each other when both are in the result, so the reader can
 * pick the synthesis or the specifics. Summaries augment, never replace.
 */
export function digestAnnotations(hits: { id: string; sources?: string[] }[]): Map<string, DigestAnnotation> {
  const present = new Set(hits.map((h) => h.id));
  const out = new Map<string, DigestAnnotation>();
  for (const h of hits) {
    const cited = (h.sources ?? []).filter((s) => present.has(s) && s !== h.id);
    if (cited.length === 0) continue;
    out.set(h.id, { ...out.get(h.id), digestOf: cited });
    for (const s of cited) {
      const prev = out.get(s) ?? {};
      out.set(s, { ...prev, coveredBy: [...(prev.coveredBy ?? []), h.id] });
    }
  }
  return out;
}

/**
 * Second-pass blend for the reranked block: final = α·minmax(rerank) +
 * (1−α)·minmax(fused), on the pre-timeline score. Candidates outside the
 * block keep their relative order below the block (scaled under its minimum)
 * so a reranker never promotes what it did not see. In place.
 */
function applyRerank(scored: RankedHit[], scores: Map<string, number> | undefined, alpha: number): void {
  if (!scores || scores.size === 0) return;
  const block = scored.filter((h) => scores.has(h.id));
  if (block.length === 0) return;
  const minmax = (xs: number[]) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1));
  };
  const fusedN = minmax(block.map((h) => h.score));
  const rerankN = minmax(block.map((h) => scores.get(h.id)!));
  const blockMinBefore = Math.min(...block.map((h) => h.score));
  block.forEach((h, i) => {
    h.breakdown.rerank = scores.get(h.id)!;
    // Keep the block's magnitude comparable to raw fused scores: scale the
    // blend into [blockMin, blockMax] of the original scores.
    const blockMax = Math.max(...block.map((x) => x.breakdown.fused * x.breakdown.recency + x.breakdown.spread), blockMinBefore);
    const blended = alpha * rerankN[i]! + (1 - alpha) * fusedN[i]!;
    h.score = blockMinBefore + blended * Math.max(blockMax - blockMinBefore, 1e-9);
  });
  const blockMinAfter = Math.min(...block.map((h) => h.score));
  const rest = scored.filter((h) => !scores.has(h.id) && h.score > 0);
  if (rest.length === 0) return;
  const restMax = Math.max(...rest.map((h) => h.score));
  if (restMax >= blockMinAfter) {
    const scale = (blockMinAfter * 0.999) / restMax;
    for (const h of rest) h.score *= scale;
  }
}

/**
 * A retrieved stale member (superseded, or a resolved open item) raises the
 * entry that holds the matter's state now to AT LEAST CURRENT_LIFT × the
 * stale member's current score — a floor, never a bonus: a successor already
 * ranked higher is left alone, nothing is demoted below unrelated entries.
 * Runs after spread and rerank (both can move the stale member) and before
 * the timeline multiplier. In place; may append the successor.
 */
function liftStage(scored: RankedHit[], input: RankInput, t: RankingTunables, byId: Map<string, Rankable>): void {
  if (!(t.CURRENT_LIFT > 0) || !input.timeline) return;
  const present = new Map(scored.map((h) => [h.id, h]));
  const floor = new Map<string, { value: number; from: string }>();
  for (const h of scored) {
    const succ = input.timeline.get(h.id)?.successor;
    if (!succ || succ === h.id || !byId.has(succ)) continue;
    const value = t.CURRENT_LIFT * h.score;
    const cur = floor.get(succ);
    if (!cur || value > cur.value) floor.set(succ, { value, from: h.id });
  }
  for (const [id, f] of floor) {
    let h = present.get(id);
    if (!h) {
      h = { id, score: 0, breakdown: { fused: 0, recency: 1, spread: 0, lift: 0, timeline: 1 } };
      scored.push(h);
      present.set(id, h);
    }
    if (f.value > h.score) {
      h.breakdown.lift = f.value;
      h.score = f.value;
      h.spreadFrom = [f.from, ...(h.spreadFrom ?? []).filter((x) => x !== f.from)];
    }
  }
}

function timelineMultiplier(state: TimelineState | undefined, t: RankingTunables): number {
  if (!state) return 1;
  if (state.superseded || state.resolved) return 1 - t.SUPERSEDED_PENALTY;
  if (state.latest) return 1 + t.LATEST_BONUS;
  return 1;
}

export interface RankOutput {
  hits: RankedHit[];
  /** Candidates carrying at least one retrieval signal (measured before the cutoff). */
  retrievalSignalCount: number;
  /** True when more ranked candidates existed than `k` allowed. */
  limitedByK: boolean;
  /** Relative score cutoff outcome. */
  cutoff: { applied: boolean; dropped: number };
  /** The entity list that was fused, when the entity leg is on and matched anything. */
  entityList?: RankList;
}

/**
 * Build the entity RRF list: entries carrying entities named in the question,
 * strongest first — most entities matched, then prior fused score (topic +
 * entity beats entity alone), then newest.
 */
function entityList(
  matches: Map<string, number>,
  base: Map<string, number>,
  byId: Map<string, Rankable>,
  t: RankingTunables,
): RankList | undefined {
  const ids = [...matches.keys()].filter((id) => byId.has(id));
  if (ids.length === 0) return undefined;
  ids.sort(
    (a, b) =>
      matches.get(b)! - matches.get(a)! ||
      (base.get(b) ?? 0) - (base.get(a) ?? 0) ||
      byId.get(b)!.date.localeCompare(byId.get(a)!.date),
  );
  return {
    kind: "entity",
    query: { text: "entities", origin: "cli", weight: 1 },
    ids: ids.slice(0, t.ENTITY_LIST_MAX),
  };
}

/** Drop lists whose (kind, id order) repeats an earlier one, keeping the max weight on the survivor. */
function dedupeLists(lists: RankList[]): RankList[] {
  const seen = new Map<string, RankList>();
  const out: RankList[] = [];
  for (const list of lists) {
    const key = `${list.kind} ${list.ids.join(" ")}`;
    const prev = seen.get(key);
    if (prev) {
      if (list.query.weight > prev.query.weight) prev.query = list.query;
      continue;
    }
    const copy = { ...list };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

function fuse(lists: RankList[], t: RankingTunables): Map<string, number> {
  const legWeight = { semantic: t.SEMANTIC_WEIGHT, lexical: t.LEXICAL_WEIGHT, entity: t.ENTITY_LEG_WEIGHT, header: t.HEADER_LEG_WEIGHT };
  const fused = new Map<string, number>();
  for (const list of t.DEDUPE_IDENTICAL_LISTS ? dedupeLists(lists) : lists) {
    const w = legWeight[list.kind] * list.query.weight;
    if (w === 0) continue;
    for (const [id, s] of rankToRRF(list.ids, t.RRF_K0)) {
      fused.set(id, (fused.get(id) ?? 0) + s * w);
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
  let lists = input.rankLists;
  let entities: RankList | undefined;
  if (tunables.ENTITY_LEG_WEIGHT > 0 && input.entityMatches?.size) {
    entities = entityList(input.entityMatches, fuse(lists, tunables), byId, tunables);
    if (entities) lists = [...lists, entities];
  }
  const fused = fuse(lists, tunables);

  // Base score: fusion × recency, in first-seen (list) order.
  const base: RankedHit[] = [];
  for (const [id, f] of fused) {
    const e = byId.get(id);
    if (!e) continue;
    const recency = recencyMultiplier(refDate(e), now, tunables.RECENCY_EPS, tunables.RECENCY_DECAY_DAYS);
    base.push({ id, score: f * recency, breakdown: { fused: f, recency, spread: 0, lift: 0, timeline: 1 } });
  }
  const retrievalSignalCount = base.length;

  const scored = spreadExplicit(base, input, tunables, byId);

  for (const h of scored) h.score = h.breakdown.fused * h.breakdown.recency + h.breakdown.spread;
  applyRerank(scored, input.rerankScores, tunables.RERANK_ALPHA);
  liftStage(scored, input, tunables, byId);
  for (const h of scored) {
    const timeline = timelineMultiplier(input.timeline?.get(h.id), tunables);
    h.breakdown.timeline = timeline;
    h.score *= timeline;
  }
  // Stable sort: exact ties keep first-seen (list) order.
  scored.sort((a, b) => b.score - a.score);

  // Relative cutoff trims the long tail — but never on an exhaustive run,
  // whose contract is that every candidate is ranked and only k limits output.
  let ranked = scored;
  const cutoff = { applied: false, dropped: 0 };
  if (!input.exhaustive && tunables.CUTOFF_TAU > 0 && scored.length > 0) {
    const floor = tunables.CUTOFF_TAU * scored[0]!.score;
    ranked = scored.filter((h, i) => i < tunables.CUTOFF_MIN_RESULTS || h.score >= floor);
    cutoff.dropped = scored.length - ranked.length;
    cutoff.applied = cutoff.dropped > 0;
  }
  if (input.exhaustive) {
    // Recall guarantee: append filter-matching entries with no retrieval
    // signal (newest first) so nothing is droppable before the k-cut.
    const present = new Set(scored.map((r) => r.id));
    const rest = input.filtered
      .filter((e) => !present.has(e.id))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => ({ id: e.id, score: 0, breakdown: { fused: 0, recency: 1, spread: 0, lift: 0, timeline: 1 } }));
    ranked = [...scored, ...rest];
  }

  return {
    hits: ranked.slice(0, input.k),
    retrievalSignalCount,
    limitedByK: ranked.length > input.k,
    cutoff,
    ...(entities ? { entityList: entities } : {}),
  };
}
