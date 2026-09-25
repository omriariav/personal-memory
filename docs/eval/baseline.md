# Retrieval evaluation baseline

- recorded: 2026-09-25T13:30:36.927Z
- commit: 5ccaa22
- node: v20.20.1
- embedder: local:Xenova/bge-small-en-v1.5
- corpus: synthetic · 4000 entries · seed 42 · generator 2 · 4088 chunk rows · built in 0 s
- mode: recall · fixed clock 2026-07-01T00:00:00.000Z

## Summary

| metric | value |
|---|---|
| cases | 142 (gated 136, xfail 6) |
| passed | 122 |
| recall@1 / @5 / @10 / @40 | 67.6% / 89.3% / 91.1% / 94.9% |
| MRR | 0.8255 |
| nDCG@10 | 0.8464 |
| pair pass rate | 100.0% |
| latency p50 / p95 / mean | 113 / 128 / 114 ms |

## By kind

| kind | n | pass | recall@10 | MRR |
|---|---|---|---|---|
| needle | 61 | 59 | 98.9% | 0.984 |
| dup | 10 | 8 | 100.0% | 0.900 |
| paraphrase | 12 | 2 | 16.7% | 0.037 |
| alias | 6 | 5 | 83.3% | 0.833 |
| chain | 30 | 30 | 100.0% | 0.694 |
| filter | 3 | 3 | 51.0% | 0.667 |
| title | 20 | 20 | 100.0% | 1.000 |

## Failing gated cases

- `needle-01-fact` (needle): 2023-09-05-needle-01 @ 2
- `needle-06-fact` (needle): 2024-05-22-needle-06 @ 2
- `needle-01-vs-dup` (dup): 2023-09-05-needle-01 @ 2
- `needle-06-vs-dup` (dup): 2024-05-22-needle-06 @ 2
- `paraphrase-00` (paraphrase): 2024-08-22-paraphrase-00 @ —
- `paraphrase-01` (paraphrase): 2025-06-18-paraphrase-01 @ —
- `paraphrase-02` (paraphrase): 2026-04-10-paraphrase-02 @ 24
- `paraphrase-03` (paraphrase): 2024-12-17-paraphrase-03 @ 13
- `paraphrase-05` (paraphrase): 2025-10-07-paraphrase-05 @ 17
- `paraphrase-06` (paraphrase): 2025-12-06-paraphrase-06 @ —
- `paraphrase-07` (paraphrase): 2025-11-05-paraphrase-07 @ 19
- `paraphrase-08` (paraphrase): 2023-10-22-paraphrase-08 @ —
- `paraphrase-10` (paraphrase): 2025-05-01-paraphrase-10 @ —
- `paraphrase-11` (paraphrase): 2024-07-23-paraphrase-11 @ —
