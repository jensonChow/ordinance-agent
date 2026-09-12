# Retrieval evaluation

Date: 2026-09-12 · corpus: 160 articles · 80 study questions, each with two paraphrases: paraphrase 1 = **dev** (used to tune tags and stop-words), paraphrase 2 = **test** (never inspected while tuning). The canonical questions themselves are never used as queries.

"primary" = the first article listed for the question is in the top-k; "any" = any listed article is.

## test

| strategy (test, n=80) | primary@1 | primary@3 | primary@5 | any@1 | any@3 | any@5 |
|---|---|---|---|---|---|---|
| strict FTS | 23.8% | 23.8% | 23.8% | 26.3% | 26.3% | 26.3% |
| loose FTS | 46.3% | 60.0% | 65.0% | 53.8% | 70.0% | 75.0% |
| smart FTS (strict→loose) | 52.5% | 62.5% | 67.5% | 61.3% | 73.8% | 78.8% |
| question bank | 55.0% | 68.8% | 72.5% | 55.0% | 68.8% | 72.5% |
| question bank → smart FTS | 55.0% | 71.3% | 80.0% | 55.0% | 72.5% | 85.0% |

## dev

| strategy (dev, n=80) | primary@1 | primary@3 | primary@5 | any@1 | any@3 | any@5 |
|---|---|---|---|---|---|---|
| strict FTS | 15.0% | 17.5% | 17.5% | 16.3% | 18.8% | 18.8% |
| loose FTS | 37.5% | 56.3% | 67.5% | 46.3% | 65.0% | 75.0% |
| smart FTS (strict→loose) | 37.5% | 58.8% | 67.5% | 47.5% | 66.3% | 75.0% |
| question bank | 63.7% | 85.0% | 87.5% | 63.7% | 85.0% | 87.5% |
| question bank → smart FTS | 65.0% | 87.5% | 95.0% | 65.0% | 87.5% | 95.0% |

## all

| strategy (all, n=160) | primary@1 | primary@3 | primary@5 | any@1 | any@3 | any@5 |
|---|---|---|---|---|---|---|
| strict FTS | 19.4% | 20.6% | 20.6% | 21.3% | 22.5% | 22.5% |
| loose FTS | 41.9% | 58.1% | 66.3% | 50.0% | 67.5% | 75.0% |
| smart FTS (strict→loose) | 45.0% | 60.6% | 67.5% | 54.4% | 70.0% | 76.9% |
| question bank | 59.4% | 76.9% | 80.0% | 59.4% | 76.9% | 80.0% |
| question bank → smart FTS | 60.0% | 79.4% | 87.5% | 60.0% | 80.0% | 90.0% |
