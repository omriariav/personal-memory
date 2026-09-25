/**
 * Every knob of the ranking pipeline lives here, with a default that
 * reproduces the established ordering. Override per run via
 * `SearchOptions.tunables` (used by the evaluation harness for sweeps) or
 * per process via `MEMORY_RANK_<NAME>` environment variables.
 */
export interface RankingTunables {
  /** Reciprocal-rank-fusion constant: rank i contributes 1/(k0 + i). */
  RRF_K0: number;
  /** Multiplier on every semantic (vector) list's RRF contribution. */
  SEMANTIC_WEIGHT: number;
  /** Multiplier on every lexical (BM25) list's RRF contribution. */
  LEXICAL_WEIGHT: number;
  /**
   * 1 = lists of one kind with identical id order are fused once, at the
   * strongest phrasing weight (the cli keyword phrasing usually reproduces the
   * primary phrasing's lexical order, double-counting that leg). 0 = off.
   */
  DEDUPE_IDENTICAL_LISTS: number;
  /** Max recency multiplier bonus (0.02 = +2% for a brand-new entry). */
  RECENCY_EPS: number;
  /** E-folding age, in days, of the recency bonus. */
  RECENCY_DECAY_DAYS: number;
  /** Score multiplier (1 − x) for chain members that were superseded or resolved. */
  SUPERSEDED_PENALTY: number;
  /** Score multiplier (1 + x) for the latest member of a chain. */
  LATEST_BONUS: number;
  /**
   * When a stale chain member is retrieved, its successor (the chain's
   * `current`, or the resolver of an open item) is lifted to at least this
   * fraction of the stale member's score. ≥ 1 puts the current state above
   * the stale one; nothing is demoted. 0 = off.
   */
  CURRENT_LIFT: number;
  /**
   * One-hop spread over EXPLICIT edges only (follows, reverse follows,
   * sources, reverse sources): each of the top SPREAD_TOP_N hits lends this
   * fraction of its score to up to SPREAD_FANOUT neighbours (max, not sum).
   * 0 = off.
   */
  SPREAD_EDGE_FRACTION: number;
  SPREAD_TOP_N: number;
  SPREAD_FANOUT: number;
  /**
   * Spread over IMPLICIT neighbours: entries sharing ≥ SPREAD_MIN_SHARED
   * rare slugs (people/teams/tags with df/N ≤ SPREAD_RARE_DF) with a top
   * hit. Nothing is persisted or inferred as a link. 0 = off.
   */
  SPREAD_ENTITY_FRACTION: number;
  SPREAD_MIN_SHARED: number;
  SPREAD_RARE_DF: number;
  /**
   * Relative cutoff: once CUTOFF_MIN_RESULTS are kept, drop results scoring
   * below CUTOFF_TAU × the top score. Never applied on an exhaustive run.
   * 0 = off.
   */
  CUTOFF_TAU: number;
  CUTOFF_MIN_RESULTS: number;
  /**
   * Entity leg: entries whose people match a NICKNAME or DISPLAY NAME found
   * in the question (resolved through memory/people/; a typed slug already
   * matches lexically and is deliberately excluded) form one more RRF list,
   * ordered by match count, prior score, date, fused at this weight. 0 = off.
   */
  ENTITY_LEG_WEIGHT: number;
  ENTITY_LIST_MAX: number;
  /** Slugs present in more than this fraction of candidates are too common to count. */
  ENTITY_MAX_DF: number;
  /**
   * Header leg: each phrasing is also matched against a per-entry embedding
   * of the title + metadata alone (table `memory_headers`, backfilled
   * incrementally), fused at this weight so short title-like questions are
   * not diluted by long bodies. 0 = off.
   */
  HEADER_LEG_WEIGHT: number;
  /**
   * Reranker (opt-in via --rerank / MEMORY_RERANK=1): the top RERANK_N
   * signal-bearing candidates are re-scored by a local cross-encoder and
   * blended as RERANK_ALPHA × minmax(rerank) + (1 − α) × minmax(fused).
   * Timeline and cutoff apply after. RERANK_MAX_CHARS bounds the document text.
   */
  RERANK_N: number;
  RERANK_ALPHA: number;
  RERANK_MAX_CHARS: number;
}

/**
 * The pre-change ordering: every knob at its identity value. Selected by
 * `MEMORY_RANK_PROFILE=legacy`; also what every harness comparison against a
 * legacy baseline reproduces bit-for-bit.
 */
export const IDENTITY_TUNABLES: Readonly<RankingTunables> = Object.freeze({
  RRF_K0: 60,
  SEMANTIC_WEIGHT: 1,
  LEXICAL_WEIGHT: 1,
  DEDUPE_IDENTICAL_LISTS: 0,
  RECENCY_EPS: 0.02,
  RECENCY_DECAY_DAYS: 90,
  SUPERSEDED_PENALTY: 0,
  LATEST_BONUS: 0,
  CURRENT_LIFT: 0,
  SPREAD_EDGE_FRACTION: 0,
  SPREAD_TOP_N: 20,
  SPREAD_FANOUT: 10,
  SPREAD_ENTITY_FRACTION: 0,
  SPREAD_MIN_SHARED: 2,
  SPREAD_RARE_DF: 0.05,
  CUTOFF_TAU: 0,
  CUTOFF_MIN_RESULTS: 8,
  ENTITY_LEG_WEIGHT: 0,
  ENTITY_LIST_MAX: 512,
  ENTITY_MAX_DF: 0.1,
  HEADER_LEG_WEIGHT: 0,
  RERANK_N: 60,
  RERANK_ALPHA: 0.7,
  RERANK_MAX_CHARS: 1000,
});

/**
 * The `current` profile — what ships. Each departure from identity was kept
 * only after the evaluation harness showed a gain with no case regressing
 * (docs/eval/baseline.md records the numbers):
 *  - RRF_K0 20: sharper fusion (+0.7 pt recall@10, paraphrase gains).
 *  - CURRENT_LIFT 1.02: when a stale chain member is retrieved, the entry
 *    holding the state now ranks just above it (all stale-wording cases).
 *  - SPREAD_EDGE_FRACTION 0.3: one hop over explicit links (+MRR, +nDCG).
 *  - CUTOFF_TAU 0.5: halves the returned tail at −0.7 pt recall@40;
 *    `--no-cutoff` restores it. Never applied on exhaustive runs.
 *  - ENTITY_LEG_WEIGHT 2: entries about a person named by NICKNAME in the
 *    question get their own fused list (all alias cases; typed slugs are
 *    excluded — boosting them cost exact-title lookups).
 * A blanket SUPERSEDED_PENALTY was measured and rejected: it drops stale
 * members below unrelated entries instead of below their successor.
 */
export const DEFAULT_TUNABLES: Readonly<RankingTunables> = Object.freeze({
  ...IDENTITY_TUNABLES,
  RRF_K0: 20,
  CURRENT_LIFT: 1.02,
  SPREAD_EDGE_FRACTION: 0.3,
  CUTOFF_TAU: 0.5,
  ENTITY_LEG_WEIGHT: 2,
});

export const ENV_PREFIX = "MEMORY_RANK_";
export const PROFILES = { current: DEFAULT_TUNABLES, legacy: IDENTITY_TUNABLES } as const;
export type RankingProfile = keyof typeof PROFILES;

/** profile (MEMORY_RANK_PROFILE, default current) ← env MEMORY_RANK_<NAME> ← explicit overrides. */
export function resolveTunables(
  overrides: Partial<RankingTunables> = {},
  env: Record<string, string | undefined> = process.env,
): RankingTunables {
  const profile = (env[ENV_PREFIX + "PROFILE"] ?? "current") as RankingProfile;
  if (!(profile in PROFILES)) {
    throw new Error(`MEMORY_RANK_PROFILE must be one of ${Object.keys(PROFILES).join("|")}, got '${profile}'`);
  }
  const out: RankingTunables = { ...PROFILES[profile] };
  for (const key of Object.keys(out) as (keyof RankingTunables)[]) {
    const raw = env[ENV_PREFIX + key];
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    }
    const o = overrides[key];
    if (o !== undefined && Number.isFinite(o)) out[key] = o;
  }
  return out;
}
