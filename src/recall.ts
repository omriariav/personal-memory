import { relative } from "node:path";
import { ROOT } from "./ingest.js";
import {
  DEFAULT_COMPLETE_LIMIT,
  searchDetailed,
  type QuerySpec,
  type SearchCompleteness,
  type SearchFilters,
  type SearchOptions,
} from "./store.js";
import type { MemoryEntry } from "./schema.js";
import type { ChainAnnotation } from "./chains.js";
import { buildRecallQueries } from "./recall-queries.js";
import { knownPeople } from "./store.js";
import { detectPeople, getAliasIndex } from "./people.js";

export { buildRecallQueries };

export interface RecallOptions {
  filters?: SearchFilters;
  k?: number;
  deep?: boolean;
  noExpand?: boolean;
  /** Disable the relative score cutoff (`--no-cutoff`). */
  noCutoff?: boolean;
  /** Second pass through the local cross-encoder (`--rerank`). */
  rerank?: boolean;
  completeness?: SearchCompleteness;
  completeLimit?: number;
  requireComplete?: boolean;
  /** Clock for the recency bonus (default: wall clock). Fixed by the eval harness. */
  now?: number;
  tunables?: SearchOptions["tunables"];
  /** Explicit index slot (`--index-slot`); default: env/active.json. */
  slot?: string;
}

export interface RecallHit {
  id: string;
  title: string;
  type: MemoryEntry["type"];
  /** Sorted graph membership (default graph first), e.g. `["default","team-x"]`. */
  graphs: string[];
  date: string;
  updated?: string;
  people: string[];
  teams: string[];
  tags: string[];
  sources?: string[];
  follows?: string[];
  source_ids?: string[];
  path: string;
  relPath: string;
  score: number;
  bestChunk: string;
  /** Timeline context when the entry belongs to a `follows` chain. */
  chain?: ChainAnnotation;
  /** Retrieved hits whose explicit links lent this entry part of their score. */
  spreadFrom?: string[];
  /** On a summary: its cited sources that were also returned. */
  digestOf?: string[];
  /** On a raw entry: returned summaries that cite it. */
  coveredBy?: string[];
  /** Raw cross-encoder score when the hit was in the reranked block. */
  rerankScore?: number;
  reasons?: {
    semanticRank?: number;
    lexicalRank?: number;
    entityRank?: number;
    matchedTerms: string[];
    retrievalSignals: string[];
  };
}

export interface RecallReport {
  queries: QuerySpec[];
  filters: SearchFilters;
  mode: SearchCompleteness;
  exhaustive: boolean;
  requireComplete: boolean;
  candidateCount: number;
  consideredCount: number;
  retrievalSignalCount: number;
  returnedCount: number;
  limitedByK: boolean;
  k: number;
  pool: number;
  chunkRows: number;
  /** The index slot this recall read, and its format. */
  index: { slot: string; format: 1 | 2 };
  /** Relative score cutoff outcome (never applied on exhaustive runs). */
  cutoff?: { tau: number; applied: boolean; dropped: number };
  /** People named in the question, resolved through memory/people/ aliases. */
  entities?: { people: string[]; ambiguous: string[] };
  /** Reranker pass, when requested. */
  rerank?: { model: string; n: number; ms: number };
  warnings: string[];
  hits: RecallHit[];
}

export async function recall(positionals: string[], opts: RecallOptions = {}): Promise<RecallReport> {
  const filters = opts.filters ?? {};
  const mode = opts.completeness ?? "complete-if-small";
  const k = opts.k ?? 40;
  const completeLimit = opts.completeLimit ?? DEFAULT_COMPLETE_LIMIT;
  // Nicknames/display names in the question resolve through memory/people/
  // aliases so "Zhenya" reaches entries filed under her slug. A typed slug (or
  // its humanized form) already matches lexically and is left alone —
  // augmenting it boosted every entry about that person and cost exact-title
  // lookups their first place.
  const primaryText = positionals[0] ?? "";
  const people = primaryText.trim() ? detectPeople(primaryText, await getAliasIndex(knownPeople)).aliased : [];
  const queries = buildRecallQueries(positionals, filters, Boolean(opts.noExpand), people);
  const search = await searchDetailed(queries, filters, k, {
    deep: opts.deep ?? true,
    completeness: mode,
    completeLimit,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.tunables ? { tunables: opts.tunables } : {}),
    ...(opts.noCutoff ? { noCutoff: true } : {}),
    ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
    ...(opts.slot ? { slot: opts.slot } : {}),
  });

  const warnings: string[] = [];
  if (queries.length === 0) warnings.push("No query text was provided.");
  if (opts.requireComplete && !search.report.exhaustive) {
    if (mode === "complete-if-small" && search.report.candidateCount > completeLimit) {
      warnings.push(
        `Completeness was required but not guaranteed; ${search.report.candidateCount} candidates exceed the complete limit ${completeLimit}.`,
      );
    } else {
      warnings.push(`Completeness was required but mode '${mode}' did not produce an exhaustive scan; use --complete.`);
    }
  }
  if (!search.report.exhaustive) {
    warnings.push("Recall is hybrid-ranked, not exhaustive. Add filters, use --complete, or raise --complete-limit for a stronger guarantee.");
  }
  if (search.report.limitedByK) {
    warnings.push(`Only ${search.report.returnedCount} of ${search.report.consideredCount} considered candidates are returned by -k ${k}.`);
  }

  return {
    queries: search.queries,
    filters,
    mode,
    exhaustive: search.report.exhaustive,
    requireComplete: Boolean(opts.requireComplete),
    candidateCount: search.report.candidateCount,
    consideredCount: search.report.consideredCount,
    retrievalSignalCount: search.report.retrievalSignalCount,
    returnedCount: search.report.returnedCount,
    limitedByK: search.report.limitedByK,
    k: search.report.k,
    pool: search.report.pool,
    chunkRows: search.report.chunkRows,
    index: search.report.index,
    ...(search.report.cutoff ? { cutoff: search.report.cutoff } : {}),
    ...(search.report.entities ? { entities: search.report.entities } : {}),
    ...(search.report.rerank ? { rerank: search.report.rerank } : {}),
    warnings,
    hits: search.hits.map((h) => ({
      id: h.entry.id,
      title: h.entry.title,
      type: h.entry.type,
      graphs: h.entry.graphs,
      date: h.entry.date,
      ...(h.entry.updated ? { updated: h.entry.updated } : {}),
      people: h.entry.people,
      teams: h.entry.teams,
      tags: h.entry.tags,
      ...(h.entry.sources?.length ? { sources: h.entry.sources } : {}),
      ...(h.entry.follows?.length ? { follows: h.entry.follows } : {}),
      ...(h.entry.source_ids?.length ? { source_ids: h.entry.source_ids } : {}),
      path: h.entry.path,
      relPath: relative(ROOT, h.entry.path),
      score: h.score,
      bestChunk: h.bestChunk,
      ...(h.chain ? { chain: h.chain } : {}),
      ...(h.spreadFrom ? { spreadFrom: h.spreadFrom } : {}),
      ...(h.digestOf ? { digestOf: h.digestOf } : {}),
      ...(h.coveredBy ? { coveredBy: h.coveredBy } : {}),
      ...(h.rerankScore !== undefined ? { rerankScore: h.rerankScore } : {}),
      ...(h.reasons ? { reasons: h.reasons } : {}),
    })),
  };
}
