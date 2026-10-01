import type { SearchFilters } from "./ranking.js";
import type { RecallOptions, RecallReport } from "./recall.js";
import type { SearchOptions, SearchResult } from "./store.js";

/**
 * Retrieval-quality evaluation: a case format shared by the synthetic harness
 * (`scripts/eval-retrieval.ts`) and the private golden set (`memory eval`),
 * pure metrics, a pure per-case scorer, aggregation, and baseline comparison.
 * Only `runCases` touches the search engine — through injected functions, so
 * callers control cwd and module initialisation.
 */

export const CASE_KINDS = ["needle", "dup", "paraphrase", "alias", "chain", "filter", "title", "golden"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export interface EvalCase {
  id: string;
  kind: CaseKind;
  query: string;
  /** Extra agent phrasings (origin "agent"). */
  phrasings?: string[];
  filters?: SearchFilters;
  /** Relevant ids (binary) or id → gain (graded, for nDCG). */
  expect: string[] | Record<string, number>;
  /** [loser, winner]: the winner must be retrieved and rank above the loser. */
  mustNotOutrank?: [string, string][];
  /** Ids that must not appear at all. */
  expectAbsent?: string[];
  expectChain?: { id: string; status?: "open" | "resolved"; latest?: string };
  expectExhaustive?: boolean;
  /** Result count requested (default 40). */
  k?: number;
  /** The case passes only when every expected id ranks within this (default 10). */
  passAtK?: number;
  noExpand?: boolean;
  /** Known gap: reported, never gates. */
  xfail?: boolean;
  notes?: string;
}

export interface CaseHit {
  id: string;
  score: number;
  semanticRank?: number;
  lexicalRank?: number;
  chain?: { status?: "open" | "resolved"; latest?: string };
}

export interface CaseRun {
  hits: CaseHit[];
  exhaustive: boolean;
}

export const RECALL_KS = [1, 5, 10, 40] as const;
export type RecallK = (typeof RECALL_KS)[number];

export interface CaseResult {
  id: string;
  kind: CaseKind;
  xfail: boolean;
  /** expected id → 1-based rank, or null when not retrieved. */
  ranks: Record<string, number | null>;
  firstRelevantRank: number | null;
  recallAt: Record<RecallK, number>;
  reciprocalRank: number;
  ndcg10: number;
  pairs: { loser: string; winner: string; ok: boolean }[];
  absentOk?: boolean;
  chainOk?: boolean;
  exhaustiveOk?: boolean;
  /** Paraphrase diagnostic: the expected hit carried no lexical signal. */
  lexicalBlind?: boolean;
  ms: number;
  pass: boolean;
  /** Number of hits the engine returned (before the harness looks at ranks). */
  returned: number;
  top: { id: string; score: number }[];
}

export interface KindSummary {
  n: number;
  pass: number;
  recall10: number;
  mrr: number;
}

export interface EvalSummary {
  cases: number;
  passed: number;
  xfailed: number;
  recallAt: Record<RecallK, number>;
  mrr: number;
  ndcg10: number;
  pairPassRate: number;
  /** Mean hits returned per case — what a cutoff trims. */
  meanReturned: number;
  byKind: Record<string, KindSummary>;
  latency: { p50: number; p95: number; mean: number; n: number };
  failures: CaseResult[];
}

export interface CorpusMeta {
  size: number;
  seed: number;
  generator: number;
  chunkRows: number;
  buildMs?: number;
  /** The index slot the run read (`--index-slot`); absent on reports recorded before slots existed. */
  slot?: string;
}

export interface EvalReport {
  meta: {
    at: string;
    commit: string;
    node: string;
    embedderId: string;
    corpus: CorpusMeta | "real-store";
    mode: "recall" | "search";
    now: string;
  };
  summary: EvalSummary;
  results: CaseResult[];
}

// --- metrics -----------------------------------------------------------------

export function recallAtK(ranks: (number | null)[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.filter((r) => r !== null && r <= k).length / ranks.length;
}

export function reciprocalRank(ranks: (number | null)[]): number {
  const present = ranks.filter((r): r is number => r !== null);
  return present.length ? 1 / Math.min(...present) : 0;
}

export function ndcgAtK(rankedIds: string[], gains: Record<string, number>, k: number): number {
  const dcg = rankedIds.slice(0, k).reduce((s, id, i) => s + (gains[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(gains)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
}

/** Nearest-rank percentile (p in 0..100) of the sample. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[idx - 1]!;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// --- per-case scoring --------------------------------------------------------

function gainsOf(c: EvalCase): Record<string, number> {
  return Array.isArray(c.expect) ? Object.fromEntries(c.expect.map((id) => [id, 1])) : c.expect;
}

export function evaluateCase(c: EvalCase, run: CaseRun, ms: number): CaseResult {
  const position = new Map(run.hits.map((h, i) => [h.id, i + 1]));
  const gains = gainsOf(c);
  const expected = Object.keys(gains);
  const ranks: Record<string, number | null> = {};
  for (const id of expected) ranks[id] = position.get(id) ?? null;
  const rankList = Object.values(ranks);
  const present = rankList.filter((r): r is number => r !== null);

  const recallAt = Object.fromEntries(RECALL_KS.map((k) => [k, recallAtK(rankList, k)])) as Record<RecallK, number>;
  const pairs = (c.mustNotOutrank ?? []).map(([loser, winner]) => {
    const w = position.get(winner);
    const l = position.get(loser);
    return { loser, winner, ok: w !== undefined && (l === undefined || w < l) };
  });
  const absentOk = c.expectAbsent ? c.expectAbsent.every((id) => !position.has(id)) : undefined;
  let chainOk: boolean | undefined;
  if (c.expectChain) {
    const h = run.hits.find((x) => x.id === c.expectChain!.id);
    chainOk =
      Boolean(h) &&
      (c.expectChain.status === undefined || h!.chain?.status === c.expectChain.status) &&
      (c.expectChain.latest === undefined || h!.chain?.latest === c.expectChain.latest);
  }
  const exhaustiveOk = c.expectExhaustive === undefined ? undefined : run.exhaustive === c.expectExhaustive;
  let lexicalBlind: boolean | undefined;
  if (c.kind === "paraphrase") {
    const found = run.hits.filter((h) => gains[h.id] !== undefined);
    lexicalBlind = found.length > 0 && found.every((h) => h.lexicalRank === undefined);
  }

  const passAtK = c.passAtK ?? 10;
  const otherAssertions = pairs.length > 0 || c.expectAbsent !== undefined || c.expectChain !== undefined;
  // An empty expectation with no other assertion means "this must return nothing".
  const expectedOk =
    expected.length === 0 ? otherAssertions || run.hits.length === 0 : recallAtK(rankList, passAtK) === 1;
  const pass =
    expectedOk &&
    pairs.every((p) => p.ok) &&
    absentOk !== false &&
    chainOk !== false &&
    exhaustiveOk !== false;

  return {
    id: c.id,
    kind: c.kind,
    xfail: Boolean(c.xfail),
    ranks,
    firstRelevantRank: present.length ? Math.min(...present) : null,
    recallAt,
    reciprocalRank: reciprocalRank(rankList),
    ndcg10: ndcgAtK(
      run.hits.map((h) => h.id),
      gains,
      10,
    ),
    pairs,
    ...(absentOk !== undefined ? { absentOk } : {}),
    ...(chainOk !== undefined ? { chainOk } : {}),
    ...(exhaustiveOk !== undefined ? { exhaustiveOk } : {}),
    ...(lexicalBlind !== undefined ? { lexicalBlind } : {}),
    ms,
    pass,
    returned: run.hits.length,
    top: run.hits.slice(0, 10).map((h) => ({ id: h.id, score: h.score })),
  };
}

// --- aggregation -------------------------------------------------------------

export function summarize(results: CaseResult[]): EvalSummary {
  const gated = results.filter((r) => !r.xfail);
  const byKind: Record<string, KindSummary> = {};
  for (const r of results) {
    const k = (byKind[r.kind] ??= { n: 0, pass: 0, recall10: 0, mrr: 0 });
    k.n++;
    if (r.pass) k.pass++;
    k.recall10 += r.recallAt[10];
    k.mrr += r.reciprocalRank;
  }
  for (const k of Object.values(byKind)) {
    k.recall10 /= k.n;
    k.mrr /= k.n;
  }
  const allPairs = gated.flatMap((r) => r.pairs);
  const ms = results.map((r) => r.ms);
  return {
    cases: results.length,
    passed: gated.filter((r) => r.pass).length,
    xfailed: results.length - gated.length,
    recallAt: Object.fromEntries(RECALL_KS.map((k) => [k, mean(gated.map((r) => r.recallAt[k]))])) as Record<
      RecallK,
      number
    >,
    mrr: mean(gated.map((r) => r.reciprocalRank)),
    ndcg10: mean(gated.map((r) => r.ndcg10)),
    pairPassRate: allPairs.length ? allPairs.filter((p) => p.ok).length / allPairs.length : 1,
    meanReturned: mean(results.map((r) => r.returned ?? 0)),
    byKind,
    latency: { p50: percentile(ms, 50), p95: percentile(ms, 95), mean: mean(ms), n: ms.length },
    failures: gated.filter((r) => !r.pass),
  };
}

export interface Comparison {
  deltas: Record<string, number>;
  newlyFailing: string[];
  newlyPassing: string[];
  regressed: boolean;
  text: string;
}

const GATED_METRICS = ["recall@10", "mrr", "ndcg10"] as const;

function metricsOf(s: EvalSummary): Record<string, number> {
  return {
    "recall@1": s.recallAt[1],
    "recall@5": s.recallAt[5],
    "recall@10": s.recallAt[10],
    "recall@40": s.recallAt[40],
    mrr: s.mrr,
    ndcg10: s.ndcg10,
    pairPassRate: s.pairPassRate,
    meanReturned: s.meanReturned ?? 0,
    p50ms: s.latency.p50,
    p95ms: s.latency.p95,
  };
}

export function compareReports(base: EvalReport, cur: EvalReport, opts: { abs?: number } = {}): Comparison {
  const abs = opts.abs ?? 0.01;
  const b = metricsOf(base.summary);
  const c = metricsOf(cur.summary);
  const deltas: Record<string, number> = {};
  for (const k of Object.keys(c)) deltas[k] = c[k]! - (b[k] ?? 0);

  const basePass = new Map(base.results.map((r) => [r.id, r]));
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  for (const r of cur.results) {
    if (r.xfail) continue;
    const prev = basePass.get(r.id);
    if (!prev || prev.xfail) continue;
    if (prev.pass && !r.pass) newlyFailing.push(r.id);
    if (!prev.pass && r.pass) newlyPassing.push(r.id);
  }
  const regressed = newlyFailing.length > 0 || GATED_METRICS.some((k) => deltas[k]! < -abs);

  const lines = [
    `metric          base      current   delta`,
    ...Object.keys(c).map((k) => `${k.padEnd(15)} ${fmt(b[k] ?? 0)}  ${fmt(c[k]!)}  ${signed(deltas[k]!)}`),
    `newly failing: ${newlyFailing.length ? newlyFailing.join(", ") : "none"}`,
    `newly passing: ${newlyPassing.length ? newlyPassing.join(", ") : "none"}`,
    regressed ? `REGRESSION (threshold ${abs})` : "no regression",
  ];
  return { deltas, newlyFailing, newlyPassing, regressed, text: lines.join("\n") };
}

function fmt(x: number): string {
  return (Number.isInteger(x) ? String(x) : x.toFixed(4)).padStart(8);
}
function signed(x: number): string {
  const s = Number.isInteger(x) ? String(x) : x.toFixed(4);
  return x > 0 ? `+${s}` : s;
}

// --- runner ------------------------------------------------------------------

export interface RunDeps {
  recall: (positionals: string[], opts?: RecallOptions) => Promise<RecallReport>;
  searchDetailed: (queries: string[], filters?: SearchFilters, k?: number, opts?: SearchOptions) => Promise<SearchResult>;
}

export interface RunOptions {
  mode: "recall" | "search";
  /** Fixed clock for the recency bonus. */
  now: number;
  tunables?: SearchOptions["tunables"];
  onCase?: (r: CaseResult, i: number, n: number) => void;
}

function hitsFromRecall(r: RecallReport): CaseRun {
  return {
    hits: r.hits.map((h) => ({
      id: h.id,
      score: h.score,
      ...(h.reasons?.semanticRank !== undefined ? { semanticRank: h.reasons.semanticRank } : {}),
      ...(h.reasons?.lexicalRank !== undefined ? { lexicalRank: h.reasons.lexicalRank } : {}),
      ...(h.chain ? { chain: { status: h.chain.status, latest: h.chain.latest.id } } : {}),
    })),
    exhaustive: r.exhaustive,
  };
}

function hitsFromSearch(r: SearchResult): CaseRun {
  return {
    hits: r.hits.map((h) => ({
      id: h.entry.id,
      score: h.score,
      ...(h.reasons?.semanticRank !== undefined ? { semanticRank: h.reasons.semanticRank } : {}),
      ...(h.reasons?.lexicalRank !== undefined ? { lexicalRank: h.reasons.lexicalRank } : {}),
      ...(h.chain ? { chain: { status: h.chain.status, latest: h.chain.latest.id } } : {}),
    })),
    exhaustive: r.report.exhaustive,
  };
}

export async function runCases(cases: EvalCase[], deps: RunDeps, opts: RunOptions): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const k = c.k ?? 40;
    const t0 = performance.now();
    let run: CaseRun;
    if (opts.mode === "recall") {
      run = hitsFromRecall(
        await deps.recall([c.query, ...(c.phrasings ?? [])], {
          filters: c.filters ?? {},
          k,
          noExpand: Boolean(c.noExpand),
          now: opts.now,
          ...(opts.tunables ? { tunables: opts.tunables } : {}),
        }),
      );
    } else {
      run = hitsFromSearch(
        await deps.searchDetailed([c.query, ...(c.phrasings ?? [])], c.filters ?? {}, k, {
          deep: true,
          completeness: "complete-if-small",
          now: opts.now,
          ...(opts.tunables ? { tunables: opts.tunables } : {}),
        }),
      );
    }
    const r = evaluateCase(c, run, Math.round(performance.now() - t0));
    out.push(r);
    opts.onCase?.(r, i, cases.length);
  }
  return out;
}

// --- rendering ---------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderText(report: EvalReport): string {
  const s = report.summary;
  const lines: string[] = [];
  const corpus = report.meta.corpus === "real-store" ? "real store" : `synthetic ${report.meta.corpus.size} (seed ${report.meta.corpus.seed}, gen ${report.meta.corpus.generator}, ${report.meta.corpus.chunkRows} chunks)`;
  lines.push(`eval · ${corpus} · mode ${report.meta.mode} · ${report.meta.embedderId} · ${report.meta.commit}`);
  lines.push(`cases ${s.cases} · passed ${s.passed}/${s.cases - s.xfailed} gated · xfail ${s.xfailed}`);
  lines.push(
    `recall@1 ${pct(s.recallAt[1])} · @5 ${pct(s.recallAt[5])} · @10 ${pct(s.recallAt[10])} · @40 ${pct(s.recallAt[40])} · MRR ${s.mrr.toFixed(4)} · nDCG@10 ${s.ndcg10.toFixed(4)} · pairs ${pct(s.pairPassRate)}`,
  );
  lines.push(`latency p50 ${s.latency.p50} ms · p95 ${s.latency.p95} ms · mean ${s.latency.mean.toFixed(0)} ms · mean returned ${s.meanReturned.toFixed(1)}`);
  lines.push("");
  lines.push(`${"kind".padEnd(11)} ${"n".padStart(4)} ${"pass".padStart(5)} ${"recall@10".padStart(10)} ${"MRR".padStart(7)}`);
  for (const [kind, k] of Object.entries(s.byKind)) {
    lines.push(`${kind.padEnd(11)} ${String(k.n).padStart(4)} ${String(k.pass).padStart(5)} ${pct(k.recall10).padStart(10)} ${k.mrr.toFixed(3).padStart(7)}`);
  }
  if (s.failures.length) {
    lines.push("");
    lines.push(`failures (${s.failures.length}):`);
    for (const f of s.failures) {
      const ranks = Object.entries(f.ranks)
        .map(([id, r]) => `${id}@${r ?? "—"}`)
        .join(" ");
      const why = [
        ...f.pairs.filter((p) => !p.ok).map((p) => `pair ${p.loser}>${p.winner}`),
        ...(f.absentOk === false ? ["absent-id present"] : []),
        ...(f.chainOk === false ? ["chain"] : []),
        ...(f.exhaustiveOk === false ? ["exhaustive"] : []),
      ].join(", ");
      lines.push(`  ${f.id} [${f.kind}] ${ranks}${why ? ` · ${why}` : ""}`);
      lines.push(`    top: ${f.top.map((t) => t.id).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function renderMarkdown(report: EvalReport): string {
  const s = report.summary;
  const m = report.meta;
  const corpus =
    m.corpus === "real-store"
      ? "real store"
      : `synthetic · ${m.corpus.size} entries · seed ${m.corpus.seed} · generator ${m.corpus.generator} · ${m.corpus.chunkRows} chunk rows${m.corpus.buildMs ? ` · built in ${(m.corpus.buildMs / 1000).toFixed(0)} s` : ""}${m.corpus.slot ? ` · slot ${m.corpus.slot}` : ""}`;
  const lines = [
    `# Retrieval evaluation baseline`,
    ``,
    `- recorded: ${m.at}`,
    `- commit: ${m.commit}`,
    `- node: ${m.node}`,
    `- embedder: ${m.embedderId}`,
    `- corpus: ${corpus}`,
    `- mode: ${m.mode} · fixed clock ${m.now}`,
    ``,
    `## Summary`,
    ``,
    `| metric | value |`,
    `|---|---|`,
    `| cases | ${s.cases} (gated ${s.cases - s.xfailed}, xfail ${s.xfailed}) |`,
    `| passed | ${s.passed} |`,
    `| recall@1 / @5 / @10 / @40 | ${pct(s.recallAt[1])} / ${pct(s.recallAt[5])} / ${pct(s.recallAt[10])} / ${pct(s.recallAt[40])} |`,
    `| MRR | ${s.mrr.toFixed(4)} |`,
    `| nDCG@10 | ${s.ndcg10.toFixed(4)} |`,
    `| pair pass rate | ${pct(s.pairPassRate)} |`,
    `| latency p50 / p95 / mean | ${s.latency.p50} / ${s.latency.p95} / ${s.latency.mean.toFixed(0)} ms |`,
    ``,
    `## By kind`,
    ``,
    `| kind | n | pass | recall@10 | MRR |`,
    `|---|---|---|---|---|`,
    ...Object.entries(s.byKind).map(([k, v]) => `| ${k} | ${v.n} | ${v.pass} | ${pct(v.recall10)} | ${v.mrr.toFixed(3)} |`),
    ``,
    `## Failing gated cases`,
    ``,
    ...(s.failures.length
      ? s.failures.map(
          (f) =>
            `- \`${f.id}\` (${f.kind}): ${Object.entries(f.ranks)
              .map(([id, r]) => `${id} @ ${r ?? "—"}`)
              .join(", ")}`,
        )
      : ["(none)"]),
    ``,
  ];
  return lines.join("\n");
}
