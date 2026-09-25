import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  bestRank,
  candidatePool,
  digestAnnotations,
  rankCandidates,
  rankToRRF,
  recencyMultiplier,
  refDate,
  shouldExhaustivelyAppend,
  whereClause,
  type RankList,
} from "./ranking.js";
import { DEFAULT_TUNABLES, IDENTITY_TUNABLES, resolveTunables } from "./ranking-tunables.js";
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
  const out = rankCandidates({ rankLists: LISTS, filtered: ENTRIES, exhaustive: false, k: 40 }, IDENTITY_TUNABLES, NOW);
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
  const out = rankCandidates({ rankLists: LISTS, filtered: ENTRIES, exhaustive: false, k: 40 }, IDENTITY_TUNABLES, NOW);
  const a = out.hits.find((h) => h.id === "a")!;
  assert.ok(Math.abs(a.breakdown.fused - 1.25 / 61) < 1e-12);
  assert.equal(a.breakdown.recency, 1.02);
});

test("rankCandidates: exhaustive appends signal-less candidates at score 0, newest first, after every signal hit", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["b"] }];
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 40 }, IDENTITY_TUNABLES, NOW);
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
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 2 }, IDENTITY_TUNABLES, NOW);
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
  const out = rankCandidates({ rankLists: lists, filtered: same, exhaustive: false, k: 40 }, IDENTITY_TUNABLES, NOW);
  assert.deepEqual(out.hits.map((h) => h.id), ["b", "c"]);
  const tie: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["c"] },
    { kind: "lexical", query: q("p", 1), ids: ["b"] },
  ];
  const t = rankCandidates({ rankLists: tie, filtered: same, exhaustive: false, k: 40 }, IDENTITY_TUNABLES, NOW);
  assert.deepEqual(t.hits.map((h) => h.id), ["c", "b"]);
});

test("bestRank: best 1-based rank across lists of one kind", () => {
  assert.equal(bestRank(LISTS, "c", "semantic"), 3);
  assert.equal(bestRank(LISTS, "c", "lexical"), 2);
  assert.equal(bestRank(LISTS, "a", "lexical"), undefined);
});

// --- tunables ----------------------------------------------------------------

test("resolveTunables: defaults ← env MEMORY_RANK_<NAME> ← explicit overrides", () => {
  assert.equal(IDENTITY_TUNABLES.RRF_K0, 60);
  assert.equal(IDENTITY_TUNABLES.RECENCY_EPS, 0.02);
  assert.equal(IDENTITY_TUNABLES.RECENCY_DECAY_DAYS, 90);
  const env = { MEMORY_RANK_RRF_K0: "20", MEMORY_RANK_RECENCY_EPS: "not-a-number" };
  const t = resolveTunables({ RECENCY_DECAY_DAYS: 30 }, env);
  assert.equal(t.RRF_K0, 20);
  assert.equal(t.RECENCY_EPS, 0.02); // unparsable env ignored
  assert.equal(t.RECENCY_DECAY_DAYS, 30);
});

test("per-leg weights scale each list kind's RRF contribution", () => {
  const lists: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["a"] },
    { kind: "lexical", query: q("p", 1), ids: ["a"] },
  ];
  const t = { ...IDENTITY_TUNABLES, RECENCY_EPS: 0, SEMANTIC_WEIGHT: 2, LEXICAL_WEIGHT: 0 };
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 1 }, t, NOW);
  assert.ok(Math.abs(out.hits[0]!.score - 2 / 61) < 1e-12, `semantic×2 only: got ${out.hits[0]!.score}`);
  const both = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 1 },
    { ...t, SEMANTIC_WEIGHT: 1, LEXICAL_WEIGHT: 0.5 },
    NOW,
  );
  assert.ok(Math.abs(both.hits[0]!.score - 1.5 / 61) < 1e-12, `1 + 0.5 legs: got ${both.hits[0]!.score}`);
});

test("identical rank lists of one kind are fused once at the strongest phrasing weight when deduping", () => {
  // The cli keyword phrasing often yields the same lexical ordering as the
  // primary phrasing, double-counting the lexical leg.
  const lists: RankList[] = [
    { kind: "lexical", query: q("primary", 1.25), ids: ["a", "b"] },
    { kind: "lexical", query: q("keywords", 0.6, "cli"), ids: ["a", "b"] },
    { kind: "lexical", query: q("other", 0.6, "cli"), ids: ["b", "a"] },
  ];
  const t = { ...IDENTITY_TUNABLES, RECENCY_EPS: 0 };
  const dup = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 2 }, { ...t, DEDUPE_IDENTICAL_LISTS: 0 }, NOW);
  const a0 = dup.hits.find((h) => h.id === "a")!.score;
  assert.ok(Math.abs(a0 - ((1.25 + 0.6) / 61 + 0.6 / 62)) < 1e-12, `no dedupe: got ${a0}`);
  const dd = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 2 }, { ...t, DEDUPE_IDENTICAL_LISTS: 1 }, NOW);
  const a1 = dd.hits.find((h) => h.id === "a")!.score;
  assert.ok(Math.abs(a1 - (1.25 / 61 + 0.6 / 62)) < 1e-12, `got ${a1}`);
  // A semantic list with the same ids is a different kind: never merged.
  const cross: RankList[] = [
    { kind: "lexical", query: q("p", 1), ids: ["a"] },
    { kind: "semantic", query: q("p", 1), ids: ["a"] },
  ];
  const c = rankCandidates({ rankLists: cross, filtered: ENTRIES, exhaustive: false, k: 1 }, { ...t, DEDUPE_IDENTICAL_LISTS: 1 }, NOW);
  assert.ok(Math.abs(c.hits[0]!.score - 2 / 61) < 1e-12, `cross-kind kept: got ${c.hits[0]!.score}`);
});

test("identity defaults: leg weights 1, no dedupe — the pre-change ordering", () => {
  assert.equal(IDENTITY_TUNABLES.SEMANTIC_WEIGHT, 1);
  assert.equal(IDENTITY_TUNABLES.LEXICAL_WEIGHT, 1);
  assert.equal(IDENTITY_TUNABLES.DEDUPE_IDENTICAL_LISTS, 0);
});

test("rankCandidates honours RRF_K0 and a zero recency epsilon", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const out = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 1 },
    { ...IDENTITY_TUNABLES, RRF_K0: 0, RECENCY_EPS: 0 },
    NOW,
  );
  assert.equal(out.hits[0]!.score, 1);
});

// --- timeline multiplier -----------------------------------------------------

test("timeline: superseded or resolved entries are penalised, the chain's latest is boosted, others untouched", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "b", "c", "d"] }];
  const timeline = new Map([
    ["a", { superseded: true, resolved: false, latest: false }],
    ["b", { superseded: false, resolved: true, latest: false }],
    ["c", { superseded: false, resolved: false, latest: true }],
  ]);
  const t = { ...IDENTITY_TUNABLES, RECENCY_EPS: 0, SUPERSEDED_PENALTY: 0.2, LATEST_BONUS: 0.1 };
  const out = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 4, timeline }, t, NOW);
  const by = Object.fromEntries(out.hits.map((h) => [h.id, h]));
  assert.ok(Math.abs(by.a!.score - (1 / 61) * 0.8) < 1e-12, `a: ${by.a!.score}`);
  assert.ok(Math.abs(by.b!.score - (1 / 62) * 0.8) < 1e-12, `b: ${by.b!.score}`);
  assert.ok(Math.abs(by.c!.score - (1 / 63) * 1.1) < 1e-12, `c: ${by.c!.score}`);
  assert.ok(Math.abs(by.d!.score - 1 / 64) < 1e-12, `d: ${by.d!.score}`);
  assert.equal(by.a!.breakdown.timeline, 0.8);
  assert.equal(by.d!.breakdown.timeline, 1);
  assert.deepEqual(out.hits.map((h) => h.id), ["c", "d", "a", "b"]);
});

test("timeline: complete-scan appends stay at 0 and identity defaults change nothing", () => {
  assert.equal(IDENTITY_TUNABLES.SUPERSEDED_PENALTY, 0);
  assert.equal(IDENTITY_TUNABLES.LATEST_BONUS, 0);
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const timeline = new Map([["b", { superseded: true, resolved: false, latest: false }]]);
  const out = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 4, timeline },
    { ...IDENTITY_TUNABLES, SUPERSEDED_PENALTY: 0.5 },
    NOW,
  );
  assert.equal(out.hits.find((h) => h.id === "b")!.score, 0);
});

// --- one-hop spread over explicit edges -------------------------------------

const SPREAD_ENTRIES = [
  { id: "a", date: "2026-01-01" },
  { id: "b", date: "2026-01-02" },
  { id: "x", date: "2026-01-03" },
  { id: "y", date: "2026-01-04" },
  { id: "z", date: "2026-01-05" },
];
const NO_RECENCY = { ...IDENTITY_TUNABLES, RECENCY_EPS: 0 };

test("spread: identity fraction adds nothing; a retrieved hit lends a fraction of its score to its explicit neighbours", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const edges = new Map([["a", ["x"]]]);
  const off = rankCandidates({ rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, edges }, NO_RECENCY, NOW);
  assert.deepEqual(off.hits.map((h) => h.id), ["a"]);
  assert.equal(IDENTITY_TUNABLES.SPREAD_EDGE_FRACTION, 0);

  const on = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, edges },
    { ...NO_RECENCY, SPREAD_EDGE_FRACTION: 0.3 },
    NOW,
  );
  assert.deepEqual(on.hits.map((h) => h.id), ["a", "x"]);
  const x = on.hits[1]!;
  assert.ok(Math.abs(x.score - 0.3 / 61) < 1e-12, `x: ${x.score}`);
  assert.equal(x.breakdown.fused, 0);
  assert.ok(Math.abs(x.breakdown.spread - 0.3 / 61) < 1e-12, `spread: ${x.breakdown.spread}`);
  assert.deepEqual(x.spreadFrom, ["a"]);
  assert.equal(on.retrievalSignalCount, 1, "spread-only entries carry no retrieval signal");
});

test("spread: gains take the max over seeds, never the sum, and stack on a neighbour's own score", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "b", "y"] }];
  const edges = new Map([
    ["a", ["x", "y"]],
    ["b", ["x"]],
  ]);
  const out = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, edges },
    { ...NO_RECENCY, SPREAD_EDGE_FRACTION: 0.5 },
    NOW,
  );
  const by = Object.fromEntries(out.hits.map((h) => [h.id, h]));
  assert.ok(Math.abs(by.x!.score - 0.5 / 61) < 1e-12, `x takes max(a, b): ${by.x!.score}`);
  assert.deepEqual(by.x!.spreadFrom, ["a"]);
  assert.ok(Math.abs(by.y!.score - (1 / 63 + 0.5 / 61)) < 1e-12, `y keeps its own score plus the gain: ${by.y!.score}`);
});

test("spread: only the top-N seeds spread, fan-out is capped by prior score then date, unknown ids are ignored", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "b", "y"] }];
  const edges = new Map([
    ["a", ["x", "y", "z", "ghost"]],
    ["b", ["z"]],
  ]);
  const t = { ...NO_RECENCY, SPREAD_EDGE_FRACTION: 0.5, SPREAD_TOP_N: 1, SPREAD_FANOUT: 2 };
  const out = rankCandidates({ rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, edges }, t, NOW);
  const ids = out.hits.map((h) => h.id);
  // seed a only (top-1); of its neighbours y has prior signal, then newest date wins: z over x
  assert.ok(ids.includes("z") && !ids.includes("x"), `fan-out picked ${ids.join(",")}`);
  assert.ok(!ids.includes("ghost"), "ids outside the candidate space never enter");
  const y = out.hits.find((h) => h.id === "y")!;
  assert.ok(y.breakdown.spread > 0, "y (prior signal) is within the fan-out");
});

test("spread happens before the timeline multiplier, so a superseded neighbour is still penalised", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const edges = new Map([["a", ["x"]]]);
  const timeline = new Map([["x", { superseded: true, resolved: false, latest: false }]]);
  const out = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, edges, timeline },
    { ...NO_RECENCY, SPREAD_EDGE_FRACTION: 0.5, SUPERSEDED_PENALTY: 0.2 },
    NOW,
  );
  const x = out.hits.find((h) => h.id === "x")!;
  assert.ok(Math.abs(x.score - (0.5 / 61) * 0.8) < 1e-12, `x: ${x.score}`);
});

// --- successor lift: the current state ranks above its stale members ---------

test("lift: a retrieved stale member lifts its successor to at least CURRENT_LIFT × its own score", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const timeline = new Map([["a", { superseded: true, resolved: false, latest: false, successor: "x" }]]);
  const off = rankCandidates({ rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline }, NO_RECENCY, NOW);
  assert.deepEqual(off.hits.map((h) => h.id), ["a"]);
  assert.equal(IDENTITY_TUNABLES.CURRENT_LIFT, 0);

  const on = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline },
    { ...NO_RECENCY, CURRENT_LIFT: 1.05 },
    NOW,
  );
  assert.deepEqual(on.hits.map((h) => h.id), ["x", "a"], "successor now ranks first");
  const x = on.hits[0]!;
  assert.ok(Math.abs(x.score - 1.05 / 61) < 1e-12, `x: ${x.score}`);
  assert.ok(Math.abs(x.breakdown.lift - 1.05 / 61) < 1e-12, `lift: ${x.breakdown.lift}`);
  assert.equal(x.breakdown.spread, 0);
  assert.deepEqual(x.spreadFrom, ["a"]);
  const a = on.hits[1]!;
  assert.ok(Math.abs(a.score - 1 / 61) < 1e-12, "the stale member itself is not demoted");
});

test("lift is a floor, not a bonus: a successor already ranked higher keeps its own score; resolved items lift their resolver", () => {
  const timeline = new Map([["a", { superseded: false, resolved: true, latest: false, successor: "x" }]]);
  // x already above a (1/61 > 1.0 × 1/62): untouched
  const above = rankCandidates(
    { rankLists: [{ kind: "semantic", query: q("p", 1), ids: ["x", "a"] }], filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline },
    { ...NO_RECENCY, CURRENT_LIFT: 1.0 },
    NOW,
  );
  const xa = above.hits.find((h) => h.id === "x")!;
  assert.ok(Math.abs(xa.score - 1 / 61) < 1e-12, `x keeps its own score: ${xa.score}`);
  assert.equal(xa.breakdown.lift, 0);
  // x below a: floored to 1.05 × a, not a + own
  const below = rankCandidates(
    { rankLists: [{ kind: "semantic", query: q("p", 1), ids: ["a", "x"] }], filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline },
    { ...NO_RECENCY, CURRENT_LIFT: 1.05 },
    NOW,
  );
  assert.deepEqual(below.hits.map((h) => h.id), ["x", "a"]);
  const xb = below.hits[0]!;
  assert.ok(Math.abs(xb.score - 1.05 / 61) < 1e-12, `x floored: ${xb.score}`);
  assert.ok(Math.abs(xb.breakdown.lift - 1.05 / 61) < 1e-12, `lift recorded: ${xb.breakdown.lift}`);
  assert.equal(xb.breakdown.fused, 1 / 62);
});

test("lift: a stale member with no successor in the candidate space lifts nothing", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const timeline = new Map([["a", { superseded: true, resolved: false, latest: false, successor: "outside" }]]);
  const on = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline },
    { ...NO_RECENCY, CURRENT_LIFT: 1.05 },
    NOW,
  );
  assert.deepEqual(on.hits.map((h) => h.id), ["a"]);
});

// --- relative score cutoff ---------------------------------------------------

test("cutoff: below CUTOFF_TAU × top score results are dropped once CUTOFF_MIN_RESULTS are kept; identity at 0", () => {
  const lists: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["a"] },
    { kind: "lexical", query: q("weak", 0.1, "cli"), ids: ["b", "c"] },
  ];
  assert.equal(IDENTITY_TUNABLES.CUTOFF_TAU, 0);
  const off = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5 }, NO_RECENCY, NOW);
  assert.deepEqual(off.hits.map((h) => h.id), ["a", "b", "c"]);
  assert.deepEqual(off.cutoff, { applied: false, dropped: 0 });

  const one = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5 },
    { ...NO_RECENCY, CUTOFF_TAU: 0.2, CUTOFF_MIN_RESULTS: 1 },
    NOW,
  );
  assert.deepEqual(one.hits.map((h) => h.id), ["a"]);
  assert.deepEqual(one.cutoff, { applied: true, dropped: 2 });
  assert.equal(one.retrievalSignalCount, 3, "signal count is measured before the cutoff");
  assert.equal(one.limitedByK, false);

  const two = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5 },
    { ...NO_RECENCY, CUTOFF_TAU: 0.2, CUTOFF_MIN_RESULTS: 2 },
    NOW,
  );
  assert.deepEqual(two.hits.map((h) => h.id), ["a", "b"]);
});

test("cutoff is disabled entirely on an exhaustive run (completeness contract)", () => {
  const lists: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["a"] },
    { kind: "lexical", query: q("weak", 0.1, "cli"), ids: ["b"] },
  ];
  const out = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 5 },
    { ...NO_RECENCY, CUTOFF_TAU: 0.9, CUTOFF_MIN_RESULTS: 1 },
    NOW,
  );
  assert.deepEqual(out.hits.map((h) => h.id), ["a", "b", "c", "d"]);
  assert.deepEqual(out.cutoff, { applied: false, dropped: 0 });
});

test("lift floor is measured after spread, so a stale member boosted by its own successor still ends below it", () => {
  // a (stale) and x (its successor) link both ways; spread lends each to the other.
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "x"] }];
  const timeline = new Map([["a", { superseded: true, resolved: false, latest: false, successor: "x" }]]);
  const edges = new Map([
    ["a", ["x"]],
    ["x", ["a"]],
  ]);
  const out = rankCandidates(
    { rankLists: lists, filtered: SPREAD_ENTRIES, exhaustive: false, k: 5, timeline, edges },
    { ...NO_RECENCY, CURRENT_LIFT: 1.02, SPREAD_EDGE_FRACTION: 0.5 },
    NOW,
  );
  assert.deepEqual(out.hits.map((h) => h.id), ["x", "a"]);
  const a = out.hits[1]!;
  const x = out.hits[0]!;
  assert.ok(Math.abs(a.score - (1 / 61 + 0.5 / 62)) < 1e-12, `a: ${a.score}`);
  assert.ok(Math.abs(x.score - 1.02 * a.score) < 1e-12, `x floored on a's post-spread score: ${x.score}`);
});

// --- profiles ----------------------------------------------------------------

test("DEFAULT_TUNABLES is the measured 'current' profile; IDENTITY_TUNABLES reproduces the pre-change ordering", () => {
  assert.equal(IDENTITY_TUNABLES.RRF_K0, 60);
  assert.equal(IDENTITY_TUNABLES.CURRENT_LIFT, 0);
  assert.equal(IDENTITY_TUNABLES.SPREAD_EDGE_FRACTION, 0);
  assert.equal(IDENTITY_TUNABLES.CUTOFF_TAU, 0);
  assert.equal(DEFAULT_TUNABLES.RRF_K0, 20);
  assert.equal(DEFAULT_TUNABLES.CURRENT_LIFT, 1.02);
  assert.equal(DEFAULT_TUNABLES.SPREAD_EDGE_FRACTION, 0.3);
  assert.equal(DEFAULT_TUNABLES.CUTOFF_TAU, 0.5);
  assert.equal(DEFAULT_TUNABLES.CUTOFF_MIN_RESULTS, 8);
  assert.equal(DEFAULT_TUNABLES.ENTITY_LEG_WEIGHT, 2);
});

test("resolveTunables: MEMORY_RANK_PROFILE=legacy starts from identity; explicit values still override it", () => {
  const legacy = resolveTunables({}, { MEMORY_RANK_PROFILE: "legacy" });
  assert.deepEqual(legacy, { ...IDENTITY_TUNABLES });
  const current = resolveTunables({}, {});
  assert.deepEqual(current, { ...DEFAULT_TUNABLES });
  const mixed = resolveTunables({ RRF_K0: 40 }, { MEMORY_RANK_PROFILE: "legacy", MEMORY_RANK_CUTOFF_TAU: "0.2" });
  assert.equal(mixed.RRF_K0, 40);
  assert.equal(mixed.CUTOFF_TAU, 0.2);
  assert.equal(mixed.CURRENT_LIFT, 0);
  assert.throws(() => resolveTunables({}, { MEMORY_RANK_PROFILE: "bogus" }), /MEMORY_RANK_PROFILE/);
});

// --- entity leg --------------------------------------------------------------

test("entity leg: matches form an extra RRF list ordered by match count, then prior score, then date; identity weight 0", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const entityMatches = new Map([
    ["c", 1],
    ["b", 2],
    ["a", 1],
    ["ghost", 3],
  ]);
  assert.equal(IDENTITY_TUNABLES.ENTITY_LEG_WEIGHT, 0);
  const off = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5, entityMatches }, NO_RECENCY, NOW);
  assert.deepEqual(off.hits.map((h) => h.id), ["a"]);
  assert.equal(off.entityList, undefined);

  const on = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5, entityMatches },
    { ...NO_RECENCY, ENTITY_LEG_WEIGHT: 1 },
    NOW,
  );
  assert.deepEqual(on.entityList?.ids, ["b", "a", "c"], "count desc, then prior score (a has one), then date");
  assert.equal(on.entityList?.kind, "entity");
  assert.deepEqual(on.hits.map((h) => h.id), ["a", "b", "c"]);
  const by = Object.fromEntries(on.hits.map((h) => [h.id, h.score]));
  assert.ok(Math.abs(by.a! - (1 / 61 + 1 / 62)) < 1e-12, `a: ${by.a}`);
  assert.ok(Math.abs(by.b! - 1 / 61) < 1e-12, `b: ${by.b}`);
  assert.ok(Math.abs(by.c! - 1 / 63) < 1e-12, `c: ${by.c}`);
  assert.equal(on.retrievalSignalCount, 3);
});

test("entity leg: weight scales the list and ENTITY_LIST_MAX caps it", () => {
  const entityMatches = new Map([
    ["a", 1],
    ["b", 1],
    ["c", 1],
  ]);
  const out = rankCandidates(
    { rankLists: [], filtered: ENTRIES, exhaustive: false, k: 5, entityMatches },
    { ...NO_RECENCY, ENTITY_LEG_WEIGHT: 0.5, ENTITY_LIST_MAX: 2 },
    NOW,
  );
  // no prior scores: date desc → a (2026-06-01), c (2026-05-31); b (2025) is cut
  assert.deepEqual(out.entityList?.ids, ["a", "c"]);
  assert.ok(Math.abs(out.hits[0]!.score - 0.5 / 61) < 1e-12, `weighted: ${out.hits[0]!.score}`);
});

// --- digest annotations ------------------------------------------------------

test("digestAnnotations: a summary hit lists which of its sources were also returned; those raw hits point back at it", () => {
  const hits = [
    { id: "summary-q3", sources: ["a", "b", "z"] },
    { id: "a" },
    { id: "b", sources: [] },
    { id: "c" },
    { id: "summary-jane", sources: ["a"] },
  ];
  const ann = digestAnnotations(hits);
  assert.deepEqual(ann.get("summary-q3"), { digestOf: ["a", "b"] });
  assert.deepEqual(ann.get("summary-jane"), { digestOf: ["a"] });
  assert.deepEqual(ann.get("a"), { coveredBy: ["summary-q3", "summary-jane"] });
  assert.deepEqual(ann.get("b"), { coveredBy: ["summary-q3"] });
  assert.equal(ann.has("c"), false);
  assert.equal(digestAnnotations([{ id: "s", sources: ["missing"] }]).size, 0);
});

// --- header leg --------------------------------------------------------------

test("header lists are a third semantic-style leg with their own weight; identity 0 drops them", () => {
  const lists: RankList[] = [
    { kind: "semantic", query: q("p", 1), ids: ["a"] },
    { kind: "header", query: q("p", 1), ids: ["b", "a"] },
  ];
  assert.equal(IDENTITY_TUNABLES.HEADER_LEG_WEIGHT, 0);
  const off = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5 }, NO_RECENCY, NOW);
  assert.deepEqual(off.hits.map((h) => h.id), ["a"]);
  const on = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5 }, { ...NO_RECENCY, HEADER_LEG_WEIGHT: 0.5 }, NOW);
  assert.deepEqual(on.hits.map((h) => h.id), ["a", "b"]);
  const by = Object.fromEntries(on.hits.map((h) => [h.id, h.score]));
  assert.ok(Math.abs(by.a! - (1 / 61 + 0.5 / 62)) < 1e-12, `a: ${by.a}`);
  assert.ok(Math.abs(by.b! - 0.5 / 61) < 1e-12, `b: ${by.b}`);
  assert.equal(bestRank(lists, "b", "header"), 1);
});

// --- reranker blend ----------------------------------------------------------

test("rerank: blends min-max rerank scores with min-max fused scores over the reranked block; the rest stays below it", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "b", "c", "d"] }];
  const rerankScores = new Map([
    ["a", 0.1],
    ["b", 0.9],
    ["c", 0.5],
  ]); // d was beyond RERANK_N
  const t = { ...NO_RECENCY, RERANK_ALPHA: 1 };
  const pure = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5, rerankScores }, t, NOW);
  assert.deepEqual(pure.hits.map((h) => h.id), ["b", "c", "a", "d"], "alpha 1 = pure rerank order, d after the block");
  assert.ok(pure.hits[3]!.score < pure.hits[2]!.score, "unreranked tail scores below the reranked block");
  assert.equal(pure.hits[0]!.breakdown.rerank, 0.9);
  assert.equal(pure.hits[3]!.breakdown.rerank, undefined);

  const half = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5, rerankScores },
    { ...NO_RECENCY, RERANK_ALPHA: 0.5 },
    NOW,
  );
  // fused minmax over {a,b,c}: a=1, b=0.5, c=0; rerank minmax: a=0, b=1, c=0.5
  // blended: a=0.5, b=0.75, c=0.25 → b, a, c
  assert.deepEqual(half.hits.map((h) => h.id), ["b", "a", "c", "d"]);
});

test("rerank: no scores = identity; a single reranked candidate keeps its score; exhaustive appends stay at 0", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a"] }];
  const base = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 5 }, NO_RECENCY, NOW);
  const same = rankCandidates({ rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 5, rerankScores: new Map() }, NO_RECENCY, NOW);
  assert.deepEqual(same.hits.map((h) => [h.id, h.score]), base.hits.map((h) => [h.id, h.score]));
  const one = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: true, k: 5, rerankScores: new Map([["a", 0.3]]) },
    { ...NO_RECENCY, RERANK_ALPHA: 0.7 },
    NOW,
  );
  assert.ok(one.hits[0]!.score > 0, "a keeps a positive score");
  assert.equal(one.hits[1]!.score, 0, "complete-scan append untouched");
});

test("rerank runs before the timeline multiplier and the cutoff", () => {
  const lists: RankList[] = [{ kind: "semantic", query: q("p", 1), ids: ["a", "b"] }];
  const timeline = new Map([["b", { superseded: true, resolved: false, latest: false, successor: "a" }]]);
  const out = rankCandidates(
    { rankLists: lists, filtered: ENTRIES, exhaustive: false, k: 5, rerankScores: new Map([["a", 0.2], ["b", 0.9]]), timeline },
    { ...NO_RECENCY, RERANK_ALPHA: 1, CURRENT_LIFT: 1.02 },
    NOW,
  );
  // rerank puts b first, then the lift raises a (b's successor) just above b
  assert.deepEqual(out.hits.map((h) => h.id), ["a", "b"]);
});
