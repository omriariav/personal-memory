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

// --- self-healing on version mismatch ----------------------------------------

test("ensureLexical: an index file from an older version is rebuilt on the read path and persisted", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureLexical } = await import("./lexical.js");
  const dir = mkdtempSync(join(tmpdir(), "pm-lex-"));
  try {
    const path = join(dir, "lexical.json");
    writeFileSync(path, JSON.stringify({ version: 2, docs: [{ id: "old", hash: "h", len: 1 }], postings: { stale: [[0, 1]] } }));
    const entries = [
      { id: "a", date: "2026-01-01", type: "note", title: "Alpha rollout", people: [], teams: [], tags: [], body: "alpha body", path: "/x/a.md", paths: {}, graphs: ["default"] },
    ] as any[];
    const idx = await ensureLexical(entries, path);
    assert.equal(idx.version, 3);
    assert.deepEqual(idx.docs.map((d) => d?.id), ["a"]);
    assert.ok(idx.postings.alpha, "rebuilt from the current entries");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3, "persisted, so maintenance never reports it missing");
    // a second call reads the persisted file without rebuilding
    const again = await ensureLexical(entries, path);
    assert.deepEqual(again.docs, idx.docs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
