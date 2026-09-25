# Retrieval evaluation baseline

- recorded: 2026-09-25T12:44:57.779Z
- commit: 3f4840a
- node: v20.20.1
- embedder: local:Xenova/bge-small-en-v1.5
- corpus: synthetic · 4000 entries · seed 42 · generator 1 · 4088 chunk rows · built in 89 s
- mode: recall · fixed clock 2026-07-01T00:00:00.000Z

## Summary

| metric | value |
|---|---|
| cases | 132 (gated 126, xfail 6) |
| passed | 111 |
| recall@1 / @5 / @10 / @40 | 71.8% / 88.2% / 89.7% / 95.2% |
| MRR | 0.8409 |
| nDCG@10 | 0.8523 |
| pair pass rate | 100.0% |
| latency p50 / p95 / mean | 98 / 115 / 98 ms |

## By kind

| kind | n | pass | recall@10 | MRR |
|---|---|---|---|---|
| needle | 61 | 59 | 99.1% | 0.984 |
| dup | 10 | 8 | 100.0% | 0.900 |
| paraphrase | 12 | 1 | 8.3% | 0.045 |
| alias | 6 | 5 | 83.3% | 0.833 |
| chain | 20 | 20 | 100.0% | 0.721 |
| filter | 3 | 3 | 51.0% | 0.667 |
| title | 20 | 20 | 100.0% | 1.000 |

## Failing gated cases

- `needle-01-fact` (needle): 2023-09-05-needle-01 @ 2
- `needle-06-fact` (needle): 2024-05-22-needle-06 @ 2
- `needle-01-vs-dup` (dup): 2023-09-05-needle-01 @ 2
- `needle-06-vs-dup` (dup): 2024-05-22-needle-06 @ 2
- `paraphrase-00` (paraphrase): 2024-08-22-paraphrase-00 @ —
- `paraphrase-01` (paraphrase): 2025-06-18-paraphrase-01 @ —
- `paraphrase-02` (paraphrase): 2026-04-10-paraphrase-02 @ 31
- `paraphrase-03` (paraphrase): 2024-12-17-paraphrase-03 @ 40
- `paraphrase-05` (paraphrase): 2025-10-07-paraphrase-05 @ —
- `paraphrase-06` (paraphrase): 2025-12-06-paraphrase-06 @ —
- `paraphrase-07` (paraphrase): 2025-11-05-paraphrase-07 @ 19
- `paraphrase-08` (paraphrase): 2023-10-22-paraphrase-08 @ 13
- `paraphrase-09` (paraphrase): 2025-04-11-paraphrase-09 @ 15
- `paraphrase-10` (paraphrase): 2025-05-01-paraphrase-10 @ 31
- `paraphrase-11` (paraphrase): 2024-07-23-paraphrase-11 @ —
