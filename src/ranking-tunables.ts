/**
 * Every knob of the ranking pipeline lives here, with a default that
 * reproduces the established ordering. Override per run via
 * `SearchOptions.tunables` (used by the evaluation harness for sweeps) or
 * per process via `MEMORY_RANK_<NAME>` environment variables.
 */
export interface RankingTunables {
  /** Reciprocal-rank-fusion constant: rank i contributes 1/(k0 + i). */
  RRF_K0: number;
  /** Max recency multiplier bonus (0.02 = +2% for a brand-new entry). */
  RECENCY_EPS: number;
  /** E-folding age, in days, of the recency bonus. */
  RECENCY_DECAY_DAYS: number;
}

export const DEFAULT_TUNABLES: Readonly<RankingTunables> = Object.freeze({
  RRF_K0: 60,
  RECENCY_EPS: 0.02,
  RECENCY_DECAY_DAYS: 90,
});

export const ENV_PREFIX = "MEMORY_RANK_";

/** defaults ← env ← explicit overrides; unparsable env values are ignored. */
export function resolveTunables(
  overrides: Partial<RankingTunables> = {},
  env: Record<string, string | undefined> = process.env,
): RankingTunables {
  const out: RankingTunables = { ...DEFAULT_TUNABLES };
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
