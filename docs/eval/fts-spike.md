# Phase 3 spike — LanceDB full-text search as the lexical leg

Question: can the JSON postings index (`.index/lexical.json`, `bm25Scores`) be
replaced by a LanceDB FTS index on a pre-tokenized `lex` column, so the lexical
leg stops re-parsing one JSON blob per command at 100k entries?

Runner: `npx tsx scripts/spike-fts.ts --size <N> [--lancedb <alt dist/index.js>]`
(text only — no embedding model, no vectors; the table lives in
`.cache/eval/corpus-<N>-s42/.spike-fts/`). Index options:
`whitespace` tokenizer, no lowercase/stem/stopwords/ascii-folding, no positions —
tokens are exactly `tokenize()` output, so the query is `tokenize(q).join(" ")`.

## Result (2026-09-25, 0.37.1 columns added 2026-09-29)

| Gate | 0.21.3 (pinned), 4k | 0.39.0, 4k | 0.39.0, 100k | **0.37.1, 4k** | **0.37.1, 100k** |
|---|---|---|---|---|---|
| 1 filter + FTS returns filtered rows only | PASS (0 violations / 73 queries) | PASS (0 / 71) | PASS (0 / 77) | PASS (0 / 72) | PASS (0 / 74) |
| 2 rows added after the index are found before `optimize()` | PASS (30/30 by rarest terms, limit 20) | PASS (30/30) | PASS (30/30) | PASS (30/30) | PASS (30/30) |
| 3 τ-b of FTS scores vs `bm25Scores` over the FTS top-40, mean over 264 eval phrasings | **FAIL** τ 0.27, top-1 agreement 24 % | PASS τ 0.980 (vs k1=1.2 reference 0.997), overlap 98.5 %, top-1 100 % | PASS τ 0.979 (vs k1=1.2: 0.998), overlap 95.6 %, top-1 99.6 % | PASS τ 0.980 (k1=1.2: 0.997), overlap 98.5 %, top-1 100 % | PASS τ 0.979 (k1=1.2: 0.998), overlap 95.9 %, top-1 99.6 % |
| 4 latency per phrasing | p50 0.9 ms | p50 0.7 ms | p50 1.3 ms, p95 1.8 ms; with `where` p50 2.7 ms; postings `bm25Scores` p50 3.6 ms | p50 0.7 ms | p50 1.3 ms, p95 1.6 ms; with `where` 2.6 ms; postings 3.8 ms |

Index build at 100k: 0.27 s over 99,988 rows (tokenizing 0.8 s); `optimize()`
folds 100 un-indexed rows in 0.26 s. Loading 100k entries with
`loadAllEntries` took 2.0–6.5 s — the number Phase 3's catalog is meant to remove.

## Findings

1. **The pinned `@lancedb/lancedb` 0.21.3 cannot be used for FTS.** Its
   `limit(n)` is applied to the posting scan in row order *before* scoring:
   `limit(10)` returns the first 10 matching rows sorted by score, not the
   global top 10 (`migration`, 321 matches: limit 10 / 100 / 1000 each give a
   different top-1; only limit ≥ matches is exact). Un-indexed rows are also
   scored with different statistics from indexed ones (the appended tail
   outranked everything at 5.14 vs 4.53). Query API (`query().fullTextSearch`,
   `search(q, "fts")`, `MatchQuery`) makes no difference.
2. **0.37.1 and 0.39.0 are exact**: the same top-k at every limit, and the
   ranking matches our BM25 up to the k1 difference (Lance 1.2, ours 1.5):
   τ 0.998 against a k1=1.2 reference at 100k. The residual set difference
   (overlap ≈ 96 %) is which members of equal-score tie groups make the top-40
   — arbitrary on both sides. Whether to align `bm25Scores` to k1=1.2 is left
   to the retrieval harness (RRF consumes ranks only).
3. **Format compatibility, both directions, on the 4k corpus' real `.index`
   written by 0.21.3** (checked for 0.37.1 and 0.39.0): the newer library opens
   `memory` + `memory_headers`, runs a filtered vector search, and leaves the
   bytes untouched; after a newer-library write (add + delete → table version
   3), 0.21.3 still opens the table and counts rows. So the upgrade forces no
   rebuild and can be rolled back.
4. Newer releases warn that `select([...])` without `_score` will stop
   auto-projecting the score — always select `_score` explicitly.

## Version choice and upgrade verification (2026-09-29)

`@lancedb/lancedb` 0.38.0 and later declare `engines.node >= 22`; this repo
pins Node 20 (`.nvmrc`, `engines.node >= 20`). **0.37.1** is the newest
release that declares Node ≥ 18, and it passes every gate identically to
0.39.0 (columns above). The upgrade `^0.21.0 → ^0.37.1` was verified on this
machine before committing:

- `npm run typecheck` clean; `npm test`: 208/208 unit tests, migration-script
  tests, 72 guard checks.
- `npm run eval` vs `docs/eval/baseline-4k.json`: every metric delta 0, no
  case flips.
- Real store (1071 entries, 1766 chunks): `maintenance` reports the same index
  health before and after; three `recall --format json` runs return identical
  hit sets in identical order — the only diff is 7th-decimal score drift from
  the wall-clock recency term. The derived index was backed up to the session
  scratchpad before the first read with the new library (never committed).

## Verdict

FTS is viable only on a LanceDB release with exact top-k — landed as `^0.37.1`
(the newest Node-20-compatible release). All four gates pass at 4k and 100k,
so the plan's fallback (a `postings` table + JS `bm25Scores`) is not needed.
Next: implement `MEMORY_LEXICAL=postings|fts` behind the `Catalog` seam and let
`npm run eval --compare` decide.
