import { test } from "node:test";
import assert from "node:assert/strict";
import { bm25Scores, stem, tokenize, type LexicalIndex } from "./lexical.js";

// Hand-built index so the BM25 formula is checked against values computed
// independently (k1 = 1.5, b = 0.75, idf = ln(1 + (N - n + 0.5) / (n + 0.5))).
function index(docs: LexicalIndex["docs"], postings: LexicalIndex["postings"]): LexicalIndex {
  return { version: 2, docs, postings };
}

const THREE = index(
  [
    { id: "d0", hash: "h0", len: 10 },
    { id: "d1", hash: "h1", len: 20 },
    { id: "d2", hash: "h2", len: 30 },
  ],
  {
    alpha: [[0, 1]],
    beta: [[1, 2], [2, 1]],
    gamma: [[0, 5]],
    delta: [[2, 1]],
  },
);

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

test("bm25: single rare term, tf 1, short doc (N=3, n=1, dl=10, avgdl=20)", () => {
  const s = bm25Scores("alpha", THREE);
  assert.deepEqual([...s.keys()], ["d0"]);
  close(s.get("d0"), 1.2655861329183566);
});

test("bm25: term frequency saturates (tf 5 scores ~1.63× tf 1, not 5×)", () => {
  close(bm25Scores("gamma", THREE).get("d0"), 2.0649036905510028);
});

test("bm25: length normalisation favours the shorter document at equal tf", () => {
  close(bm25Scores("delta", THREE).get("d2"), 0.8006769412340624);
  assert.ok(bm25Scores("alpha", THREE).get("d0")! > bm25Scores("delta", THREE).get("d2")!);
});

test("bm25: multi-term query sums per-term contributions", () => {
  const s = bm25Scores("beta delta", THREE);
  close(s.get("d1"), 0.6714337560653365);
  assert.ok(s.get("d2")! > 0.8006769412340624); // delta + a beta share
});

test("bm25: tombstoned docs are excluded from N and avgdl; a stale posting to one is skipped", () => {
  const idx = index(
    [
      { id: "d0", hash: "h0", len: 10 },
      null,
      { id: "d2", hash: "h2", len: 30 },
    ],
    { alpha: [[0, 1]], stale: [[1, 9]] },
  );
  const s = bm25Scores("alpha", idx);
  assert.deepEqual([...s.keys()], ["d0"]);
  close(s.get("d0"), 0.8943834587870262); // N = 2, avgdl = 20
  assert.equal(bm25Scores("stale", idx).size, 0);
});

test("bm25: query terms are stemmed like documents; unknown terms and empty queries score nothing", () => {
  const idx = index([{ id: "d0", hash: "h", len: 3 }], { decision: [[0, 1]] });
  assert.equal(bm25Scores("decisions", idx).size, 1);
  assert.equal(bm25Scores("zzz", idx).size, 0);
  assert.equal(bm25Scores("", idx).size, 0);
});

test("stem: light suffix stripping, never below the length guards", () => {
  assert.equal(stem("decisions"), "decision");
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("hiring"), "hir");
  assert.equal(stem("shipped"), "shipp");
  assert.equal(stem("boss"), "boss");
  assert.equal(stem("ies"), "ies");
  assert.equal(stem("cat"), "cat");
});

test("tokenize: lowercase alphanumerics, drops single-char tokens, stems", () => {
  assert.deepEqual(tokenize("Jane-Doe's A/B tests, 2026!"), ["jane", "doe", "test", "2026"]);
});
