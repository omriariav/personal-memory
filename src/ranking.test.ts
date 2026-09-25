import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  bestRank,
  candidatePool,
  rankCandidates,
  rankToRRF,
  recencyMultiplier,
  refDate,
  shouldExhaustivelyAppend,
  whereClause,
  type RankList,
} from "./ranking.js";
import { DEFAULT_TUNABLES, resolveTunables } from "./ranking-tunables.js";
import type { QuerySpec } from "./ranking.js";

const NOW = Date.parse("2026-06-01");

function q(text: string, weight: number, origin: QuerySpec["origin"] = "primary"): QuerySpec {
  return { text, origin, weight };
}

// --- rankToRRF ---------------------------------------------------------------

test("rankToRRF: rank i (1-based) scores 1/(k0+i)", () => {
  const m = rankToRRF(["a", "b", "c"]);
  assert.equal(m.get("a"), 1 / 61);
  assert.equal(m.get("b"), 1 / 62);
  assert.equal(m.get("c"), 1 / 63);
  assert.equal(rankToRRF([]).size, 0);
});

test("rankToRRF: custom k0 changes the denominator", () => {
  assert.equal(rankToRRF(["a"], 10).get("a"), 1 / 11);
});

// --- recency -----------------------------------------------------------------

test("recencyMultiplier: age 0 gives the full 2% bonus, decaying with e-folding 90 days", () => {
  assert.equal(recencyMultiplier("2026-06-01", NOW), 1.02);
  const at90 = recencyMultiplier("2026-03-03", NOW); // 90 days earlier
  assert.ok(Math.abs(at90 - (1 + 0.02 / Math.E)) < 1e-12, `got ${at90}`);
});

test("recencyMultiplier: future dates clamp to age 0; ancient dates approach 1", () => {
  assert.equal(recencyMultiplier("2030-01-01", NOW), 1.02);
  assert.ok(recencyMultiplier("2000-01-01", NOW) - 1 < 1e-9);
});

test("refDate: updated wins only when newer than date", () => {
  assert.equal(refDate({ date: "2026-01-01", updated: "2026-02-01" }), "2026-02-01");
  assert.equal(refDate({ date: "2026-03-01", updated: "2026-02-01" }), "2026-03-01");
  assert.equal(refDate({ date: "2026-03-01" }), "2026-03-01");
});

test("recency bonus can flip immediately adjacent ranks in one list, never two ranks apart", () => {
  // Adjacent ranks differ by ~1.6% (1/61 vs 1/62): a brand-new entry one
  // rank below an ancient one overtakes it. Two ranks apart (~3.2%) it cannot.
  const ancientAt1 = (1 / 61) * recencyMultiplier("2000-01-01", NOW);
  const freshAt2 = (1 / 62) * recencyMultiplier("2026-06-01", NOW);
  const freshAt3 = (1 / 63) * recencyMultiplier("2026-06-01", NOW);
  assert.ok(freshAt2 > ancientAt1);
  assert.ok(freshAt3 < ancientAt1);
});

// --- completeness + pool ----------------------------------------------------

test("shouldExhaustivelyAppend truth table", () => {
  const none = {};
  const some = { person: "x" };
  assert.equal(shouldExhaustivelyAppend(none, 0, "complete", 200), false);
  assert.equal(shouldExhaustivelyAppend(none, 5, "complete", 200), true);
  assert.equal(shouldExhaustivelyAppend(none, 500, "complete", 200), true);
  assert.equal(shouldExhaustivelyAppend(none, 200, "complete-if-small", 200), true);
  assert.equal(shouldExhaustivelyAppend(none, 201, "complete-if-small", 200), false);
  assert.equal(shouldExhaustivelyAppend(none, 5, "auto", 200), false);
  assert.equal(shouldExhaustivelyAppend(some, 5, "auto", 200), true);
  assert.equal(shouldExhaustivelyAppend(some, 201, "auto", 200), false);
  assert.equal(shouldExhaustivelyAppend(some, 5, "none", 200), false);
});

test("candidatePool: floors at 40, deep multiplies k by 12, caps at 512; exhaustive scales with the filtered set", () => {
  assert.equal(candidatePool({ exhaustive: false, filteredCount: 900, k: 1, deep: false, chunkRows: 100 }), 40);
  assert.equal(candidatePool({ exhaustive: false, filteredCount: 900, k: 8, deep: false, chunkRows: 1489 }), 75);
  assert.equal(candidatePool({ exhaustive: false, filteredCount: 900, k: 40, deep: true, chunkRows: 1489 }), 480);
  assert.equal(candidatePool({ exhaustive: false, filteredCount: 900, k: 100, deep: true, chunkRows: 1489 }), 512);
  assert.equal(candidatePool({ exhaustive: true, filteredCount: 3, k: 40, deep: true, chunkRows: 1489 }), 40);
  assert.equal(candidatePool({ exhaustive: true, filteredCount: 100, k: 40, deep: true, chunkRows: 1489 }), 800);
  assert.equal(candidatePool({ exhaustive: true, filteredCount: 1000, k: 40, deep: true, chunkRows: 1489 }), 4096);
});

// --- filters -----------------------------------------------------------------

test("whereClause mirrors every filter and never interpolates invalid values", () => {
  assert.equal(whereClause({}), undefined);
  assert.equal(
    whereClause({ person: "jane-doe", type: "decision", since: "2026-01-01", until: "2026-02-01", team: "t", tag: "g", graph: "default" }),
    "type = 'decision' AND date >= '2026-01-01' AND date <= '2026-02-01' AND people LIKE '%|jane-doe|%' AND teams LIKE '%|t|%' AND tags LIKE '%|g|%' AND graphs LIKE '%|default|%'",
  );
  assert.equal(whereClause({ person: "x' OR 1=1 --" }), undefined);
  assert.equal(whereClause({ since: "yesterday" }), undefined);
  assert.equal(whereClause({ person: "Jane Doe" }), undefined);
});

test("applyFilters is the JS authority: exact slug membership, inclusive date window", () => {
  const es = [
    { id: "a", date: "2026-01-10", type: "note", people: ["ana"], teams: [], tags: ["x"], graphs: ["default"] },
    { id: "b", date: "2026-02-10", type: "decision", people: ["an"], teams: ["t"], tags: [], graphs: ["default", "g"] },
  ];
  assert.deepEqual(applyFilters(es, { person: "an" }).map((e) => e.id), ["b"]);
  assert.deepEqual(applyFilters(es, { since: "2026-01-10", until: "2026-02-10" }).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(applyFilters(es, { until: "2026-02-09" }).map((e) => e.id), ["a"]);
  assert.deepEqual(applyFilters(es, { graph: "g" }).map((e) => e.id), ["b"]);
  assert.deepEqual(applyFilters(es, { tag: "x", type: "decision" }), []);
});

// --- fusion pipeline ---------------------------------------------------------

const ENTRIES = [
  { id: "a", date: "2026-06-01" },
  { id: "b", date: "2025-06-01" },
  { id: "c", date: "2026-05-31" },
  { id: "d", date: "2026-04-01" },
];

const LISTS: RankList[] = [
  { kind: "semantic", query: q("primary", 1.25), ids: ["a", "b", "c"] },
  { kind: "lexical", query: q("primary", 1.25), ids: ["b", "c"] },
];

test("rankCandidates reproduces weighted RRF × recency (golden values computed independently)", () => {
  const out = rankCandidates({ rankLists: LISTS, filtered: ENTRIES, exhaustive: false, k: 40 }, DEFAULT_TUNABLES, NOW);
  assert.deepEqual(
    out.hits.map((h) => h.id),
    ["c", "b", "a"],
  );
  const by = Object.fromEntries(out.hits.map((h) => [h.id, h.score]));
  assert.ok(Math.abs(by.a! - 0.0209016393442623) < 1e-12, `a=${by.a}`);
  assert.ok(Math.abs(by.b! - 0.040667180590959896) < 1e-12, `b=${by.b}`);
  assert.ok(Math.abs(by.c! - 0.04079377111278635) < 1e-12, `c=${by.c}`);
  assert.equal(out.retrievalSignalCount, 3);
  assert.equal(out.limitedByK, false);
});

test("rankCandidates exposes the fused score and recency factor per hit", () => {
  const out = rankCandidates({ rankLists: LISTS, filtered: ENTRIES, exhaustive: false, k: 40 }, DEFAULT_TUNABLES, NOW);
  const a = out.hits.find((h) => h.id === "a")!;
  assert.ok(Math.abs(a.breakdown.fused - 1.25 / 61) < 1e-12);
  assert.equal(a.breakdown.recency, 1.02);
});

test("rankCandidates: exhaustive appends signal-less candidates at score 0, newest first, after every signal hit", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["b"] }];
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 40 }, DEFAULT_TUNABLES, NOW);
  assert.deepEqual(
    out.hits.map((h) => [h.id, h.score === 0]),
    [
      ["b", false],
      ["a", true],
      ["c", true],
      ["d", true],
    ],
  );
  assert.equal(out.retrievalSignalCount, 1);
});

test("rankCandidates: k cuts after the exhaustive append and reports limitedByK", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["b"] }];
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 2 }, DEFAULT_TUNABLES, NOW);
  assert.deepEqual(out.hits.map((h) => h.id), ["b", "a"]);
  assert.equal(out.limitedByK, true);
});

test("rankCandidates: ids outside the candidate space are dropped; exact ties keep first-seen order", () => {
  const lists: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["zz", "b"] },
    { kind: "lexical", query: q("p", 1), ids: ["c", "b"] },
  ];
  const same = [
    { id: "b", date: "2026-01-01" },
    { id: "c", date: "2026-01-01" },
  ];
  // b: 1/62 + 1/62, c: 1/61 → c wins; then with equal lists order is insertion order.
  const out = rankCandidates({ rankLists: lists, filtered: same, exhaustive: false, k: 40 }, DEFAULT_TUNABLES, NOW);
  assert.deepEqual(out.hits.map((h) => h.id), ["b", "c"]);
  const tie: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["c"] },
    { kind: "lexical", query: q("p", 1), ids: ["b"] },
  ];
  const t = rankCandidates({ rankLists: tie, filtered: same, exhaustive: false, k: 40 }, DEFAULT_TUNABLES, NOW);
  assert.deepEqual(t.hits.map((h) => h.id), ["c", "b"]);
});

test("bestRank: best 1-based rank across lists of one kind", () => {
  assert.equal(bestRank(LISTS, "c", "semantic"), 3);
  assert.equal(bestRank(LISTS, "c", "lexical"), 2);
  assert.equal(bestRank(LISTS, "a", "lexical"), undefined);
});

// --- tunables ----------------------------------------------------------------

test("resolveTunables: defaults ← env MEMORY_RANK_<NAME> ← explicit overrides", () => {
  assert.equal(DEFAULT_TUNABLES.RRF_K0, 60);
  assert.equal(DEFAULT_TUNABLES.RECENCY_EPS, 0.02);
  assert.equal(DEFAULT_TUNABLES.RECENCY_DECAY_DAYS, 90);
  const env = { MEMORY_RANK_RRF_K0: "20", MEMORY_RANK_RECENCY_EPS: "not-a-number" };
  const t = resolveTunables({ RECENCY_DECAY_DAYS: 30 }, env);
  assert.equal(t.RRF_K0, 20);
  assert.equal(t.RECENCY_EPS, 0.02); // unparsable env ignored
  assert.equal(t.RECENCY_DECAY_DAYS, 30);
});

test("rankCandidates honours RRF_K0 and a zero recency epsilon", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const out = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 1 },
    { ...DEFAULT_TUNABLES, RRF_K0: 0, RECENCY_EPS: 0 },
    NOW,
  );
  assert.equal(out.hits[0]!.score, 1);
});
