import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareReports,
  evaluateCase,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank,
  summarize,
  type CaseHit,
  type EvalCase,
  type EvalReport,
} from "./eval.js";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("recallAtK: fraction of expected ids ranked within k; null = not retrieved", () => {
  assert.equal(recallAtK([1, 4, null], 5), 2 / 3);
  assert.equal(recallAtK([1, 4, null], 1), 1 / 3);
  assert.equal(recallAtK([], 10), 0);
});

test("reciprocalRank: 1/best rank, 0 when nothing retrieved", () => {
  assert.equal(reciprocalRank([3, 7]), 1 / 3);
  assert.equal(reciprocalRank([null, 2]), 1 / 2);
  assert.equal(reciprocalRank([null]), 0);
});

test("ndcgAtK: graded gains, ideal ordering scores 1", () => {
  close(ndcgAtK(["c", "b", "a", "x"], { c: 3, b: 1, a: 1 }, 10), 1);
  close(ndcgAtK(["a", "x", "c"], { c: 3, a: 1 }, 10), 2.5 / (3 + 1 / Math.log2(3)));
  assert.equal(ndcgAtK(["x"], { c: 3 }, 10), 0);
  assert.equal(ndcgAtK([], {}, 10), 0);
});

test("percentile: nearest-rank on the sorted sample", () => {
  const xs = [50, 10, 40, 20, 30];
  assert.equal(percentile(xs, 50), 30);
  assert.equal(percentile(xs, 95), 50);
  assert.equal(percentile(xs, 0), 10);
  assert.equal(percentile([], 50), 0);
});

// --- evaluateCase ------------------------------------------------------------

function hit(id: string, extra: Partial<CaseHit> = {}): CaseHit {
  return { id, score: 1, ...extra };
}

test("evaluateCase: binary expectation, ranks, recall@k, MRR and pass at the default k=10", () => {
  const c: EvalCase = { id: "n1", kind: "needle", query: "q", expect: ["b", "z"] };
  const r = evaluateCase(c, { hits: [hit("a"), hit("b"), hit("c")], exhaustive: false }, 12);
  assert.deepEqual(r.ranks, { b: 2, z: null });
  assert.equal(r.firstRelevantRank, 2);
  assert.equal(r.recallAt[1], 0);
  assert.equal(r.recallAt[5], 0.5);
  assert.equal(r.reciprocalRank, 0.5);
  assert.equal(r.pass, false);
  assert.equal(r.ms, 12);
  assert.deepEqual(r.top.map((t) => t.id), ["a", "b", "c"]);
});

test("evaluateCase: passes when every expected id is within passAtK and every pair/absent/chain/exhaustive check holds", () => {
  const c: EvalCase = {
    id: "ch1",
    kind: "chain",
    query: "q",
    expect: { dec: 3, pend: 1 },
    mustNotOutrank: [["pend", "dec"]],
    expectAbsent: ["ghost"],
    expectChain: { id: "pend", status: "resolved", latest: "dec" },
    expectExhaustive: false,
    passAtK: 5,
  };
  const hits = [
    hit("dec", { chain: { status: undefined, latest: "dec" } }),
    hit("pend", { chain: { status: "resolved", latest: "dec" } }),
  ];
  const r = evaluateCase(c, { hits, exhaustive: false }, 1);
  assert.equal(r.pass, true);
  assert.deepEqual(r.pairs, [{ loser: "pend", winner: "dec", ok: true }]);
  assert.equal(r.absentOk, true);
  assert.equal(r.chainOk, true);
  assert.equal(r.exhaustiveOk, true);
  close(r.ndcg10, 1);
});

test("evaluateCase: a losing pair, a present absent-id, or a wrong chain status fails the case", () => {
  const base: EvalCase = { id: "x", kind: "chain", query: "q", expect: ["dec"], passAtK: 10 };
  const hits = [hit("pend", { chain: { status: "open", latest: "pend" } }), hit("dec")];
  assert.equal(evaluateCase({ ...base, mustNotOutrank: [["pend", "dec"]] }, { hits, exhaustive: false }, 1).pass, false);
  assert.equal(evaluateCase({ ...base, expectAbsent: ["pend"] }, { hits, exhaustive: false }, 1).pass, false);
  assert.equal(
    evaluateCase({ ...base, expectChain: { id: "pend", status: "resolved" } }, { hits, exhaustive: false }, 1).pass,
    false,
  );
  assert.equal(evaluateCase({ ...base, expectExhaustive: true }, { hits, exhaustive: false }, 1).pass, false);
});

test("evaluateCase: a missing winner fails its pair; a pair-only case passes on the pair alone", () => {
  const c: EvalCase = { id: "p", kind: "golden", query: "q", expect: [], mustNotOutrank: [["a", "b"]] };
  assert.equal(evaluateCase(c, { hits: [hit("a")], exhaustive: true }, 1).pass, false);
  assert.equal(evaluateCase(c, { hits: [hit("b"), hit("a")], exhaustive: true }, 1).pass, true);
});

test("evaluateCase: an empty expectation with no other assertion passes only when nothing is returned", () => {
  const c: EvalCase = { id: "p", kind: "filter", query: "q", expect: [] };
  assert.equal(evaluateCase(c, { hits: [], exhaustive: true }, 1).pass, true);
  assert.equal(evaluateCase(c, { hits: [hit("a")], exhaustive: true }, 1).pass, false);
});

test("evaluateCase: paraphrase cases record whether the expected hit had no lexical signal", () => {
  const c: EvalCase = { id: "pp", kind: "paraphrase", query: "q", expect: ["a"] };
  const blind = evaluateCase(c, { hits: [hit("a", { semanticRank: 1 })], exhaustive: false }, 1);
  assert.equal(blind.lexicalBlind, true);
  const seen = evaluateCase(c, { hits: [hit("a", { semanticRank: 1, lexicalRank: 3 })], exhaustive: false }, 1);
  assert.equal(seen.lexicalBlind, false);
});

// --- summarize + compare -----------------------------------------------------

function result(id: string, kind: string, ranks: (number | null)[], ms: number, xfail = false) {
  const c: EvalCase = { id, kind: kind as EvalCase["kind"], query: id, expect: ranks.map((_, i) => `e${i}`), xfail };
  const hits: CaseHit[] = [];
  ranks.forEach((r, i) => {
    if (r !== null) hits[r - 1] = hit(`e${i}`);
  });
  for (let i = 0; i < hits.length; i++) hits[i] ??= hit(`filler${i}`);
  return evaluateCase(c, { hits, exhaustive: false }, ms);
}

test("summarize: means over cases, xfail excluded from pass counts and gates, per-kind breakdown, latency percentiles", () => {
  const results = [
    result("a", "needle", [1], 10),
    result("b", "needle", [3], 20),
    result("c", "alias", [null], 30, true),
    result("d", "chain", [12], 40),
  ];
  const s = summarize(results);
  assert.equal(s.cases, 4);
  assert.equal(s.xfailed, 1);
  assert.equal(s.passed, 2); // a, b (rank 3 ≤ 10); d fails at 12; c is xfail
  close(s.recallAt[10], 2 / 3); // over the 3 gated cases
  close(s.mrr, (1 + 1 / 3 + 1 / 12) / 3);
  assert.equal(s.byKind.needle!.n, 2);
  assert.equal(s.byKind.needle!.pass, 2);
  assert.equal(s.byKind.alias!.n, 1);
  assert.equal(s.latency.p50, 20);
  assert.equal(s.latency.n, 4);
  assert.deepEqual(s.failures.map((f) => f.id), ["d"]);
});

function report(results: ReturnType<typeof result>[]): EvalReport {
  return {
    meta: { at: "t", commit: "c", node: "n", embedderId: "e", corpus: "real-store", mode: "recall", now: "t" },
    summary: summarize(results),
    results,
  };
}

test("compareReports: flags regression on metric drop beyond the threshold or a gated case flipping to fail", () => {
  const base = report([result("a", "needle", [1], 1), result("b", "needle", [2], 1)]);
  const same = compareReports(base, base);
  assert.equal(same.regressed, false);
  assert.deepEqual(same.newlyFailing, []);

  const worse = report([result("a", "needle", [1], 1), result("b", "needle", [null], 1)]);
  const cmp = compareReports(base, worse);
  assert.equal(cmp.regressed, true);
  assert.deepEqual(cmp.newlyFailing, ["b"]);
  assert.ok(cmp.deltas.mrr! < 0);
  assert.match(cmp.text, /mrr/);

  const better = report([result("a", "needle", [1], 1), result("b", "needle", [1], 1)]);
  const up = compareReports(base, better);
  assert.equal(up.regressed, false);
  assert.ok(up.deltas.mrr! > 0);
});

test("compareReports: an xfail case flipping to fail never regresses", () => {
  const base = report([result("a", "needle", [1], 1), result("x", "alias", [1], 1, true)]);
  const cur = report([result("a", "needle", [1], 1), result("x", "alias", [null], 1, true)]);
  assert.equal(compareReports(base, cur).regressed, false);
});
