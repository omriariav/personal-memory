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

## Harness decision (2026-10-01)

The spike left the choice to the harness. Both legs were measured on the 4k
synthetic corpus (seed 42, generator 3, 4088 chunk rows) in the `next`
new-format slot, against `docs/eval/baseline-4k.json` — the legacy slot's
recorded baseline. `npm run eval` (legacy slot, unchanged) is delta 0 on
every metric in both rounds, so the slot numbers below isolate the lexical
leg alone.

`MEMORY_LEXICAL=fts` (`npm run eval:slot` with the FTS leg):

| metric | baseline | fts slot | delta |
|---|---|---|---|
| recall@1 | 0.6827 | 0.6999 | +0.0173 |
| recall@5 | 0.8978 | 0.8974 | −0.0004 |
| recall@10 | 0.9146 | 0.9076 | **−0.0070** |
| recall@40 | 0.9507 | 0.9507 | 0 |
| MRR | 0.8294 | 0.8376 | **+0.0082** |
| nDCG@10 | 0.8503 | 0.8558 | **+0.0055** |
| pair pass rate | 1 | 1 | 0 |
| mean returned | 19.1479 | 19.2465 | +0.0986 |
| latency p50 / p95 | 101 / 119 ms | 68 / 80 ms | −33 / −39 ms |

newly failing: `paraphrase-09` · newly passing: `needle-06-fact`,
`needle-06-vs-dup` (142 cases, xfail 0).

The three gated metrics are all within −0.01 — recall@10 is the only one
down, by 0.0070 — and FTS is a third faster. **But a non-xfail case flips to
failing**, which the decision rule treats as disqualifying on its own.
Lance's BM25 uses k1 = 1.2 against our 1.5: the lower term-frequency
saturation reshuffles enough mid-list rankings to cost `paraphrase-09` its
place, and buy two `needle-06` cases theirs. The net is positive on average
and negative on the one case the gate watches.

`MEMORY_LEXICAL=postings` (the default this decision installs):

| metric | baseline | postings slot | delta |
|---|---|---|---|
| recall@1 / @5 / @10 / @40 | 0.6827 / 0.8978 / 0.9146 / 0.9507 | identical | 0 |
| MRR | 0.8294 | 0.8294 | 0 |
| nDCG@10 | 0.8503 | 0.8503 | 0 |
| pair pass rate | 1 | 1 | 0 |
| mean returned | 19.1479 | 19.1479 | 0 |
| latency p50 / p95 | 101 / 119 ms | 108 / 121 ms | +7 / +2 ms |

newly failing: none · newly passing: none.

**Decision: `postings` is the default for new-format slots** (`lexicalMode()`
in `src/catalog.ts`); a new-format slot is therefore rank-identical to the
legacy slot out of the box. `MEMORY_LEXICAL=fts` is opt-in and stays
supported — it is the faster leg and wins on MRR and nDCG@10 — until the k1
gap is closed, either by configuring Lance's k1 to 1.5 (or ours to 1.2) and
re-running `npm run eval:slot` to delta 0 up to tie order. Reproduce with
`npm run eval:slot` and `MEMORY_LEXICAL=fts npm run eval:slot`.

## 20k read-path measurement (2026-10-01)

The 4k harness above is too small to show what the format-2 read path costs
per process. One run each over the cached 20 088-entry corpus
(`--size 20000`, seed 42), sequential, nothing else on the machine, compared
against `docs/eval/baseline-20k.json` (recorded on the legacy slot at
`3538b06`). The `next` slot was built from the corpus' legacy index and
reused every vector — `entries 20088 · vectors reused 20088 · embedded 0`.

| run | p50 | p95 | recall@10 | MRR | nDCG@10 |
|---|---|---|---|---|---|
| baseline-20k.json (recorded) | 477 ms | 531 ms | 0.9046 | 0.8058 | 0.8319 |
| legacy slot | 467 ms | 522 ms | 0.9046 | 0.8058 | 0.8319 |
| `--index-slot next`, `postings` | 549 ms | 618 ms | 0.9046 | 0.8058 | 0.8319 |
| `--index-slot next`, `MEMORY_LEXICAL=fts` | 286 ms | 322 ms | 0.9046 | 0.8223 | 0.8436 |

What it says, at five times the 4k corpus:

- **Rank identity holds at scale.** The `postings` slot reproduces every
  metric of the legacy slot exactly (all deltas 0, no case flips), which is
  the property the default rests on.
- **`postings` costs about 80 ms per query more than the legacy slot here**
  (+17%), where at 4k it cost 7 ms (+7%). The reference scorer rebuilds its
  BM25 index from the catalog's `lex` column once per process and then scores
  every doc per phrasing, so its share grows with the corpus.
- **FTS is the leg that scales**: 286 ms against the legacy slot's 467, and
  ahead on MRR (+0.0164) and nDCG@10 (+0.0117) with recall@10 unchanged. It
  still flips cases — `needle-00-fact` and `needle-00-vs-dup` fail where
  `needle-03`/`needle-09` pass — so the harness still reports a regression
  under the decision rule, for the same k1 = 1.2 reason as at 4k.

No default moves on this measurement; it is recorded so the `MEMORY_LEXICAL`
decision is taken with the scale numbers in hand rather than the 4k ones.
Reproduce with `npx tsx scripts/eval-retrieval.ts --size 20000 [--index-slot
next] --compare docs/eval/baseline-20k.json`, adding `MEMORY_LEXICAL=fts` for
the last row.
