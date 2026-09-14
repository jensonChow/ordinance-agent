# Verification log

What was actually run, when, and what came back. Anything not listed here has not been verified.

Environment: macOS (Apple Silicon), Node v22.14.0, npm 10.9.2, PostgreSQL 17.11 (Homebrew, local cluster on port 5433),
Python 3.9 venv for the Flask service. Package versions: next 16.3.4, ai 7.0.97, @ai-sdk/react 4.0.100,
@ai-sdk/azure 4.0.68, @ai-sdk/mcp 2.0.48, @ai-sdk/openai-compatible 3.0.47, mcp-handler 2.1.1,
@modelcontextprotocol/server 2.0.0, prisma / @prisma/client 7.10.0, @prisma/adapter-pg 7.10.0, zod 4.6.1.

## 2026-09-10

| Step | Command | Result |
|---|---|---|
| Corpus build | `python3 scripts/parse_basic_law.py` (official booklet PDF → `pdftotext -layout` → JSON) | `articles=160 chapters=9 annexes=3 missing=[] dups=[]`; footnotes separated for articles 14, 22, 23, 24, 54, 104 |
| Schema | `npx prisma migrate dev --name init`, then `article_fts_index` (GIN on `to_tsvector('english', text)`) | both migrations applied; `prisma generate` → `src/generated/prisma` |
| Seed | `npm run db:seed` | `seeded { chapters: 9, sections: 10, articles: 160, annexes: 3 }` |
| FTS sanity | `psql`: `websearch_to_tsquery('english','permanent resident seven years')` | top hit Article 24 |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Lint | `npm run lint` (eslint 9, next config) | exit 0 |
| Build | `npm run build` (`prisma generate && next build`, Turbopack) | compiled; routes `/`, `/api/chat`, `/api/conversations`, `/api/mcp`, `/api/notes` |
| MCP server | `next dev -p 3100`, JSON-RPC over Streamable HTTP with curl | `tools/list` returns 5 tools with JSON Schema; `initialize` negotiates `2025-06-18`; `tools/call search_articles` returns Article 24 with `**highlighted**` snippet; `tools/call get_article 39` returns full text |
| Agent loop, keyless | `MODEL_PROVIDER=mock next dev -p 3100` + `node scripts/smoke-chat.mjs http://127.0.0.1:3100` | `SMOKE OK`. Turn 1 stream: `search_articles` → `get_article` (both via MCP client) → text citing Article 24(2)/(4). Turn 2: `save_note` (local Prisma tool) → text |
| Persistence | `psql` after the smoke run | `Message`: 2 user + 2 assistant rows (assistant ids `a_…`, parts arrays of 6 and 4); `ToolCall`: `search_articles` mcp, `get_article` mcp, `save_note` local, each linked to its assistant message; `Citation`: assistant message → article 24; `Note`: article 39, "revise Article 39 before the tutorial." |
| Flask service | `gunicorn -w 1 -b 127.0.0.1:8765 app:app` in `services/citation-py` | `/healthz` → `{"ok":true}`; `POST /cite {"article":24,"paragraph":2}` → `Basic Law, art. 24(2)`; `style=long` → `Article 24 of the Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China` |

## 2026-09-12

| Step | Command | Result |
|---|---|---|
| Schema | `prisma migrate dev --name question_bank` (+ GIN index on `Question.searchText`), `prisma migrate dev --name article_search_text` (+ GIN index on `Article.searchText`) | both applied; first attempt at indexing `array_to_string(tags)` failed with `functions in index expression must be marked IMMUTABLE`, replaced by a seeded `searchText` column |
| Seed | `npm run db:seed` | `questions: 80` added to the counts; articles re-seeded with `searchText` |
| MCP | `tools/list` on the dev server | 6 tools: `list_chapters`, `search_articles`, `find_questions`, `get_article`, `get_articles`, `get_annex` |
| MCP | `tools/call find_questions {"query":"Can I be arrested without a reason?"}` | top hit qb-008 → Article 28 |
| MCP | `tools/call search_articles {"query":"Do I pay customs duty on goods brought into Hong Kong?"}` | full-text search **misses**: loose hits 53, 79, 89 (the article says "tariff", not "customs duty") — `find_questions` on the same query returns qb-055 → Article 114, which is why the bank exists |
| Retrieval eval | `npm run eval:retrieval` (160 paraphrases; dev/test split) | test set: strict FTS primary@5 23.8% → smart FTS 67.5% → question bank + smart FTS **80.0%** (any@5 85.0%); dev set tuned to 4 misses, test set 16 misses — see `eval/RESULTS.md` |
| Typecheck / lint | `npx tsc --noEmit`, `npm run lint` | exit 0 |
| Agent loop, keyless | `node scripts/smoke-chat.mjs http://127.0.0.1:3100` (mock model) | see the commit log; the mock still walks search_articles → get_article → answer |

## 2026-09-13

| Step | Command | Result |
|---|---|---|
| Unit tests without a database | `npm test` with `DATABASE_URL` unset | `tests/law.test.ts` failed at import: `src/lib/law.ts` builds the Prisma client eagerly. Fixed by moving the pure helpers (`stripDomainStopwords`, `formatCitation`) to `src/lib/text.ts` (re-exported from `law.ts`); the unit suite no longer touches the database. `vitest.config.ts` → `.mts` to silence the ESM-in-CJS warning |
| Tests / typecheck / lint | `npm test`, `npx tsc --noEmit`, `npm run lint` (local cluster on 5433 up) | 3 files, 10 tests passed; tsc exit 0; eslint exit 0 |
| MCP surface | `resources/list`, `resources/templates/list`, `prompts/list` over JSON-RPC on the dev server | 2 resources (`basic-law://contents` markdown, `basic-law://question-bank` JSON), 1 template (`basic-law://article/{number}`), 3 prompts (`answer-with-citations`, `explain-article`, `compare-articles`) |
| MCP resource read | `resources/read {"uri":"basic-law://article/24"}` | returns `Basic Law, art. 24 — Chapter III …` with the full text; `basic-law://contents` returns the nine chapters with article ranges |
| MCP prompt get | `prompts/get explain-article {number: 39, audience: "a secondary school class"}` | renders the instruction with both arguments substituted |
| Citation audit | `npm test` + the browser at `localhost:3100` | chips render green `Art. 24 fts` / green `Art. 114 qb` / amber `Art. 106 ⚠` with "1 article named in this answer was never returned by a tool"; no console errors |
| Agent loop, keyless | `node scripts/smoke-chat.mjs http://127.0.0.1:3100` (mock model), now three turns | `SMOKE OK`. Turn 3 walks `find_questions` → `get_article(114)` → answer, and by design names Article 106 without reading it so the audit has something to catch |
| Python service | Flask test client against `services/citation-py/app.py` | `GET /` service index 200, `GET /healthz` 200, `POST /cite` → `Basic Law, art. 24(2)`, `style=long` → full form, `article=999` → 400, `POST /parse` → 6 citations from "see BL art 24(2), Articles 39 and 41, and Articles 45 to 47", empty body → 400 |
| Parser parity | same three inputs through `parseCitations()` (TypeScript) and `parse_citations()` (Python) | byte-identical results, including the expanded range 45/46/47 and dropping Article 999 |
| Service fallback | `tests/citation-service.test.ts` with a stubbed `fetch` | returns the body on 200; returns null (so the caller uses the local path) when unset, on 500, on a network error and on a timeout; trailing slash in the base URL handled |
| Tests / typecheck / lint (after the above) | `npm test`, `npx tsc --noEmit`, `npm run lint` | 4 files, 20 tests passed; tsc exit 0; eslint exit 0 |

## 2026-09-14

| Step | Command | Result |
|---|---|---|
| Push | `gh repo create jensonChow/ordinance-agent --public --source . --remote origin --push` | 7 commits pushed to `main`; repository public. Anonymous `curl` (no credentials) returns 200 for the repo page, `README.md`, `VERIFICATION.md`, `eval/RESULTS.md` and `deploy/apache/basic-law.conf`; `git ls-tree origin/main` lists 60 files and contains no `.env`, `.local/` or `pgdata` |
| CI, first run | GitHub Actions `ci` on push | **Failed** at `npx tsc --noEmit`: `Cannot find name 'LayoutProps'` (src/app/layout.tsx:21). `LayoutProps` is a Next.js global helper generated by `next dev`, `next build` or `next typegen`; on a clean checkout the workflow type-checked before anything had generated it, so it passed locally (where `.next/types` existed) and failed in CI. Fixed by adding `npx next typegen` before the type check. Reproduced locally with `rm -rf .next/types && npx tsc --noEmit`, and confirmed `npx next typegen` alone makes it pass |

| Dense + hybrid retrieval | migration `embeddings`, `npm run embed`, `npm run eval:retrieval` | 160 articles and 80 canonical questions embedded (384 dims, `all-MiniLM-L6-v2`, local ONNX, no API key); held-out paraphrases never embedded. Test set: dense alone primary@5 **86.3%** vs the previous best 80.0%; hybrid RRF **88.8%** primary@5 / 63.7% primary@1. Dev/test gap narrowed from 15.0 to 7.5 points, i.e. the earlier lexical tuning had overfit dev |
| Hybrid over the wire | `tools/call search_articles {"query":"Do I pay customs duty on goods I bring into Hong Kong?"}` on the dev server | returns Article 114 first with `found_by: ["question bank"]`; strict full-text search returns nothing for the same query. "Are foreigners bound by Hong Kong laws?" returns Article 42 first, `found_by: ["question bank","semantic"]` |
| SQL dot product | `select sum(x*y) from unnest(ARRAY[0.1,0.2,0.3], ARRAY[1.0,2.0,3.0]) as t(x,y)` | 1.4, as expected; cosine over L2-normalised vectors needs no extension |
| Tests / typecheck / lint / smoke | `npm test`, `npx tsc --noEmit`, `npm run lint`, `node scripts/smoke-chat.mjs` | 4 files, 22 tests passed (2 new hybrid integration tests, skipped when the corpus is not embedded); tsc and eslint exit 0; `SMOKE OK` |

## 2026-09-14 (second session) — topic narrowing, model questions, reader ratings

Built after reading the three public systems this stack is aimed at (HKLII, CLIC, the AI CLIC Recommender) rather
than from the job description alone; see the README section on what was borrowed.

| Step | Command / action | Result |
|---|---|---|
| Migration | `npx prisma migrate dev --name relevance_ratings` | `Rating` table created (unique on `(messageId, articleNumber)`, FKs to `Message` with cascade and to `Article`); `npx prisma generate` regenerated the client |
| Chapter filter in SQL | `tools/call search_articles {"query":"Can the police search my flat without a warrant?","chapters":["III"]}` | all three hits in Chapter III (29, 28, 30); the unfiltered call also returns Chapter IV and V articles. The filter is a `WHERE … chapterNumber = ANY(...)` on every article-level path, and an article-set intersection on the question-bank path |
| Topic ranking | `tools/call suggest_topics {"query":"Can the police search my flat without a warrant?"}` | `III Fundamental Rights and Duties` 1.8095, `V Economy` 0.6583, `IV Political Structure` 0.5242 — the right chapter first, with the articles that drove it (29, 28, 30, 31) |
| Model questions over the wire | same `search_articles` call | Article 29 carries `model_questions: ["Can the police search my home without lawful authority?"]`, Article 28 `["Can the police arrest or detain me without a lawful reason?"]` |
| MCP surface | `tools/list` | 7 tools; `search_articles` advertises the `chapters` enum (I–IX) and `suggest_topics` is listed with its schema |
| Retrieval unchanged | `npm run eval:retrieval` | identical to the previous run (test primary@5 88.8%, dev 96.3%, all 92.5%); `eval/retrieval-results.json` and `eval/RESULTS.md` unchanged in `git diff`. The chapter filter is optional and off by default, so it cannot move the benchmark |
| Tests / typecheck / lint / build | `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` | 4 files, **28 tests** passed (6 new: chapter filtering keeps hits inside the chosen chapters and still returns hits when the chapter is right, topic ranking order, model-question provenance, and two citation-parsing cases); tsc, eslint and the production build exit 0 with `/eval`, `/article/[number]` and `/api/ratings` in the route table |
| Keyless end-to-end | `MODEL_PROVIDER=mock npm run dev -- -p 3100`, `node scripts/smoke-chat.mjs http://127.0.0.1:3100` | `SMOKE OK` over **five** turns. Two are new: a broad question drives `suggest_topics → search_articles → get_article`, and the same question sent with `chapters: ["III"]` arrives at the search tool as `"chapters":["III"]` — the mock model reads the selection back out of the system prompt, so the assertion proves the narrowing survived the whole trip from chip row to tool call |
| Browser, real clicks | Chrome against `localhost:3100` | Disclaimer banner renders; the nine chapter chips render under the composer; the broad question produces the answer plus a "Narrow to" row built from the `suggest_topics` result; the `Art. 27 qb·vec` chip opens a panel showing the matched study question ("Is freedom of speech protected in Hong Kong?"), the full article, a collapsible matched passage with its caveat, and the 0–5 rating row. Clicking `4` shows "saved"; `/eval` then reports "1 judgement, mean 4.00 out of 5" and "Art. 27 — 1 rating, mean 4.00". `/article/27` renders with its two study questions and prev/next links. No console errors |

## 2026-09-14 (third session) — deployed to Vercel + Supabase

| Step | Command / action | Result |
|---|---|---|
| Database | Supabase project `ordinance-agent`, `ap-southeast-1`, free tier | ACTIVE_HEALTHY. The project password is generated at creation and never shown again, and `ALTER USER postgres` is refused (`42501: permission denied to alter role`, Supabase treats it as privileged), so the app connects as a purpose-made role: `CREATE ROLE ordinance_app LOGIN`, `GRANT USAGE, CREATE ON SCHEMA public`, plus DML on the tables it owns nothing of |
| Attack surface | `REVOKE ALL ON ALL TABLES/SEQUENCES IN SCHEMA public FROM anon, authenticated` | `information_schema.role_table_grants` then lists only `ordinance_app` (44), `postgres` (77) and `service_role` (77). Without this the tables would have been readable and writable through Supabase's public PostgREST endpoint, which this app does not use |
| Schema | the six `prisma/migrations` files applied in order through the Supabase API | Applied as one migration. Not `prisma migrate deploy`: this machine cannot open a raw PostgreSQL connection (TCP connects, then the session hangs — the sandbox forwards HTTPS only), so `_prisma_migrations` is absent on the hosted database and a future `migrate deploy` there would need it seeded first |
| Seed without shipping the data | `CREATE EXTENSION http`, then `http_get` on this repository's raw `data/basic-law.en.json` and `data/question-bank.json` | 9 chapters, 10 sections, 160 articles, 3 annexes, 80 questions; 93 articles carry a section id, matching local. The corpus is already public on GitHub, so the database fetches it directly instead of it being pushed through the deploy path |
| `searchText` port | the four `BOILERPLATE` regexes from `prisma/seed.ts` reimplemented as nested `regexp_replace(... 'gi')` | **Byte-identical.** SHA-256 over `string_agg(searchText)` ordered by article: `ab2426d2…ba4a` on both. `Article.text` `f1b41355…a67b`, `Question.searchText` `748a2f3e…1b84d`, `Annex.text` `c212d1cd…62b8` — all four match the locally seeded database exactly |
| TLS | first deploy failed: `P1011 Error opening a TLS connection: self-signed certificate in certificate chain` | `pg-connection-string` now treats `sslmode=require` as `verify-full`, and the pooler's chain does not validate against the system roots. Fixed with `uselibpqcompat=true&sslmode=require` — encrypted, certificate unverified. Recorded in the README as a real limitation, with `sslrootcert` named as what a deployment holding private data should do instead |
| Pooler host | second deploy failed: `XX000 (ENOTFOUND) tenant/user ordinance_app.alpktfqbtpykhakaefoo not found` | Supavisor runs several clusters per region and the project is on `aws-0-ap-southeast-1`, not `aws-1`. DNS resolves both (they are different load balancers), and nothing in the Management API says which, so this was settled by deploying and reading the error |
| Live pages, anonymous `curl` | `/`, `/article/27`, `/eval` | 200. The homepage renders `160 articles · 3 annexes · 80 study questions` from the live database; `/article/27` shows the article with the two study questions that lead to it; `/eval` renders both benchmark tables and the reader ratings |
| Live MCP server | `tools/list`, then `search_articles {"chapters":["III"]}` | 7 tools listed. The filtered search returns only Chapter III (28, 29, 31) and carries `model_questions` — "Can the police search my home without lawful authority?" for Article 29 |
| Live agent loop | two turns through `/api/chat` | Scripted question: `search_articles → get_article`, 6.0s cold. Unscripted question: real search, then the refusal-with-results text naming Articles 30, 27, 105, 119, 6 — 2.9s warm |
| Live ratings | `POST /api/ratings` twice, then `/eval` | `200 {"ok":true}` both times; `/eval` then reports "2 judgements, mean 4.00 out of 5" with per-article breakdown. The whole loop — retrieve, cite, rate, aggregate — works against the hosted database |
| Honesty check | `/eval` | The page carries a notice that this deployment runs with `DENSE_RETRIEVAL=off` and is therefore the 80.0% pipeline, not the 88.8% in the table it is showing. A benchmark page that describes something other than what is running would be worse than no page |

## 2026-09-14 (fourth session) — the interface rebuilt from the design canvas

Implements `design/Redesign.dc.html`. The canvas was read for its rules, not copied: its component script states the
layout constraints (one rail at a time, per-mode panel names, a measured header height) that a screenshot does not.

| Step | Command / action | Result |
|---|---|---|
| Import | Claude Design project *Ordinance Agent UI 改进* | `Redesign.dc.html` (142,068 chars decoded) fetched through the project's own API in an authenticated browser and saved to `design/`. `support.js` was not kept: its first line is `// GENERATED from dc-runtime/src/*.ts — do not edit`, i.e. the canvas host's runtime rather than part of the design |
| Typecheck / lint / tests | `npx tsc --noEmit`, `npm run lint`, `npm test` | clean; 28 tests still pass — the rewrite is presentation only, no retrieval or persistence logic changed |
| Build | `npm run build` | compiled; `/`, `/eval`, `/article/[number]` and all six API routes present |
| Modes, in a browser | Chrome against `localhost:3100` | All five switch. 自測 draws a real question from the bank (`qb-012`), marks the pick against the article the bank lists, and turns the chosen row green with the verdict naming the id. 讀條文 opens the corpus tree on the left **and closes the evidence rail**, which is the one-rail rule working |
| Panel renaming | switching modes | 證據 → 對照 → 掌握度 → 標籤 → 部署, matching the canvas |
| The answer path | "Do I pay customs duty on goods I bring into Hong Kong?" | `find_questions → get_article`; 依據 row shows `art. 106 ⚠` in seal red and `art. 114 qb` in green, with the line "這個回答提到 1 條條文，但任何工具都沒有返回過它 —— 當作未經查證". The evidence rail lists five articles with their matched study questions and states, and lights only the `qb` lane — the lanes come from the search tool's `found_by`, not from a timer |
| Rating | clicking 4 on art. 114 | highlighted and "已保存"; the row is keyed by message + article so a different citation remounts it |
| Theme | toggle, then navigate to `/eval` and `/article/27` | both dark. The theme lives on `<html>` behind a pre-paint script in `layout.tsx`, so it survives navigation; `suppressHydrationWarning` on `<html>` covers the one attribute that differs by design |
| One real defect found and fixed | dev overlay reported 1 issue | React hydration mismatch on `<html data-theme>`, caused by that pre-paint script. Fixed with `suppressHydrationWarning`; no console errors after |
| Keyless end-to-end | `node scripts/smoke-chat.mjs` | `SMOKE OK` — the five-turn agent loop is untouched by the rewrite |
| Live | push → Vercel auto-deploy | https://ordinance-agent.vercel.app serves the new interface; anonymous `curl` finds 基本法研讀, all five mode labels, the notice bar and the corpus tree |

**Not done here.** Article text is still the Government's English booklet, marked `lang="en"` with the notice bar
saying so; the canvas mocks Chinese article text, and supplying it for real would mean a multilingual embedding
model and a re-run of every number in `eval/RESULTS.md`.

## Not verified

- **Azure OpenAI**: the provider path (`@ai-sdk/azure`, `createAzure({ resourceName, apiKey })`, deployment as model id)
  compiles and is selected when `AZURE_*` are set, but no request has been made to an Azure resource yet.
- **OpenAI-compatible fallback**: same — wired, not exercised against a live endpoint.
- **Dense retrieval on the hosted demo**: switched off there (`DENSE_RETRIEVAL=off`) rather than measured. The
  cold-start cost of loading the 23 MB model inside a serverless function has still not been timed; that is the
  next thing to find out, and until it is, the live site runs the lexical pipeline.
- **Docker image** for the Flask service: Dockerfile written, not built (no Docker on the build machine); the same
  `gunicorn` command was run directly in a venv on 2026-09-10. The endpoints added on 2026-09-13 (`GET /`, `POST /parse`)
  were exercised through Flask's test client, not through Gunicorn.
- **`deploy/apache/basic-law.conf` and `deploy/systemd/citation-py.service`**: written as worked examples from the
  documented directives; never loaded by an Apache or systemd instance, and not touched by CI.
- **Concurrency / multi-user behaviour**: single-user local runs only.
- **Dense retrieval in a serverless deployment**: the embedding model loads inside the Node server, which is fine
  locally but untested on Vercel, where a cold start would pay the model load. `DENSE_RETRIEVAL=off` turns it off
  and the fusion falls back to lexical.
- **pgvector**: not used and not installed; the schema stores plain float arrays (see README).

## One bug found and fixed during verification

The first smoke run persisted the assistant message with an empty id (`responseMessage.id === ""`), so the second turn
overwrote the first and its tool calls. Fix: `toUIMessageStreamResponse({ generateMessageId })` plus a server-side
fallback id in `onFinish`. The rerun shows two distinct assistant rows with their own tool calls and citations.

## 2026-09-14 — making the dense path deployable, and running the Apache config

Everything in this section was run on the machine described at the top of this file. The Vercel measurements are of
the **traced build output**, not of a live function; where that distinction matters it is said so.

### Cold-start cost of the embedding model

| Step | Command | Result |
|---|---|---|
| Where the cost actually is | `tsx` script: import `@huggingface/transformers`, `pipeline()`, first embed, second embed | import 224 ms · `pipeline()` 238 ms · first embed 8 ms · second embed 4 ms · **471 ms total**, RSS 418 MB. So the model load is not the problem — a *download* would be |
| Model file sizes, as downloaded | `ls` on the transformers.js cache | `onnx/model.onnx` **90,387,606 B** (fp32, the default) and `onnx/model_quantized.onnx` **22,972,370 B** (q8). The README's earlier "23 MB model" described the file the code was **not** loading; corrected |
| q8 first load, cold cache | `pipeline(..., { dtype: "q8" })` with nothing cached | 5,899 ms — almost all of it the 23 MB download |
| q8 and fp32 once on local disk | same, repeated | q8 32–53 ms · fp32 45 ms. **Conclusion: bundle the file and the cold start is a local read, not a network fetch** |
| Bundled, remote fetching refused | `EMBEDDING_LOCAL_ONLY=1 EMBEDDING_DTYPE=… ` against `models/` | fp32 452 ms / RSS 427 MB · q8 214 ms / RSS 318 MB (import + load + one embed, whole process) · `DENSE_RETRIEVAL=off` 0 ms, returns null |

### Does quantisation cost accuracy?

`npm run model:fetch -- --all`, then for each precision `npm run embed && npm run eval:retrieval` (the index must be
rebuilt: the query and the index have to come from the same model).

| test split, primary@5 | fp32 | q8 | Δ |
|---|---|---|---|
| dense (articles) | 86.2% | 87.5% | +1.2 |
| hybrid RRF | 88.8% | 91.2% | +2.5 |
| **dev** split, hybrid | 96.2% | 95.0% | −1.2 |

At n=80 one question is 1.25 points, so these are one- and two-question movements that go in opposite directions on
the two splits. Recorded as **"quantisation costs nothing measurable here"** — not as int8 retrieving better. fp32
reproduced the previously published numbers exactly (88.8% test / 96.3% dev) when loaded from `models/` instead of
the package cache, which also confirms the bundling changed no results.

### Function size: the reason this was not simply switched on

`npm run build`, then the traced file set of each route summed from `.next/server/app/**/*.nft.json`.

| | before | after |
|---|---|---|
| `/api/mcp` (the route that runs retrieval) | 243.0 MB | **74.1 MB** |
| `/api/chat` | 243.2 MB | 38.8 MB |
| every page route | ~242.9 MB | ~38.5 MB |

Against Vercel's 250 MB unzipped limit the original trace had 7 MB of headroom. What it was spending it on:

- **114 MB of the development machine's own model cache** (`node_modules/@huggingface/transformers/.cache/**`),
  traced in only because this repo had been run before the build. Excluded.
- **the 90 MB fp32 graph** sitting next to the q8 one in `models/`. Excluded; the include list names files, not the
  directory, so the wrong precision cannot be dragged along.
- `onnxruntime-web` (130 MB of WASM the Node backend never loads) and `sharp`, an image dependency of
  @huggingface/transformers that a text pipeline has no use for. Excluded.

**And a bug this measurement found.** `onnxruntime-node` contributed **0 bytes** of native code to the traced set:
the tracer follows the package's JavaScript but not the runtime `require` of
`bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`. Shipped that way, the function loads the JS, fails to load
the binding, and `src/lib/embeddings.ts` catches it and returns null — so retrieval would have degraded to lexical
**silently**, on a deployment whose own `/eval` page would still have claimed the vector pipeline. Fixed by naming
`bin/napi-v6/linux/x64/*` in `outputFileTracingIncludes`; the traced set then contains `libonnxruntime.so.1`
(35.16 MB) and `onnxruntime_binding.node` (0.38 MB). **Not yet confirmed on a live Vercel function** — this is a
measurement of the build output.

### Reporting a degraded pipeline instead of absorbing it

| Step | Command | Result |
|---|---|---|
| Retrieval reports its own paths | `searchArticlesHybridReported` on the seeded corpus | `{questionBank: true, fullText: true, dense: true}`; hits carry `semantic` among `found_by` |
| …and reports the dense path as absent | same with `DENSE_RETRIEVAL=off` (fresh module; the pipeline is memoised) | `dense: false`, and hits still returned — degrades rather than failing. Covered by `npm test` |
| The interface shows the difference | browser, app started with `DENSE_RETRIEVAL=off`, question routed through `search_articles` | the `vec` lane renders `data-lane="down"` with `text-decoration: line-through` and a dashed border, title "這條路沒有在跑…"; `qb` and `fts` render `on`. With the dense path up, `vec` is `off` when it simply lost |
| `/eval` says what it is describing | both servers | dense on: "向量索引 `Xenova/all-MiniLM-L6-v2@q8 dims=384 articles=160 questions=80` · 建於 2026-09-14 —— 與本進程載入的模型相符". Dense off: the notice quotes **80.0%** against the table's **91.3%** — both numbers now read out of `eval/retrieval-results.json` rather than typed into the page, which is what let them be wrong before |
| Index provenance detects the mismatch | `npm test` (stubs `EMBEDDING_DTYPE` to the other precision) | `indexStatus()` → `mismatch`, `running` ≠ `built` |

**A rejected approach, because the numbers rejected it.** The first design detected a mismatched index without
storing anything: re-embed a row whose vector is already in the database and compare. Measured against a q8 index —

| query precision | cosine to the stored vector (question qb-001 / article 1) |
|---|---|
| q8 — *the same model that built the index* | 0.998906 / 0.996750 |
| fp32 — a different precision | 0.996713 / 0.994080 |

The same model does not reproduce itself: `npm run embed` embeds in batches of 32 and padding to the longest text in
each batch perturbs the result more than the quantisation does. Two thousandths of cosine is not a threshold to
hang a correctness check on, so the check became an explicit `IndexMeta` row (one migration, `index_meta`).

### Apache: the example vhost, actually executed

`deploy/apache/local-check.sh` — Apache 2.4.67 (macOS system httpd) on port 8080, unprivileged, against a TLS-less
copy of `basic-law.conf`; app on 3100, Gunicorn on 8000.

| Check | Result |
|---|---|
| `httpd -t` | Syntax OK |
| `/`, `/eval`, `/article/27` through the proxy | 307 (the conversation redirect), 200, 200 — each carrying the app's own markup |
| `POST /api/mcp tools/list` through the proxy | 7 tools |
| `/citations/healthz`, `/citations/parse` | reach Gunicorn with the prefix rewritten away; `parse` returns `count=4` for "see arts 45 to 47 and art 24(2)" |
| `/api/chat` streaming, direct | chunks at 21, 39, 44 ms — first byte at 0.48 of the total |
| `/api/chat` streaming, through Apache | chunks at 19, 37, 42 ms — 0.45, `via: Apache/2.4.67 (Unix)`. **Not buffered** |

Three things had to be got right to run it at all, all now in the committed config: `DefaultRuntimeDir` and
`Mutex file:` inside the run directory (otherwise a non-root httpd dies on "Couldn't create the proxy mutex"); the
config copied out of the repository before starting (the system httpd's sandbox returns "Operation not permitted"
for a config on this volume, though the shell reads it fine); and `<IfModule !…>` guards around every `LoadModule`
so the same file loads on Debian, where some of those modules are compiled in.

**A false alarm worth recording.** The first version of `scripts/stream-timing.mjs` grouped arrivals within 40 ms
and called a single group "buffered". It reported the proxy as buffering — and it was wrong: against the scripted
model a whole answer completes in ~50 ms, so on a warm server the *direct* request looked identical (arrivals
`[34]`, `[18]`). The measure was replaced by the scale-free one (first chunk as a fraction of the last), which
separates the cases at any speed.

**And a claim the measurement removed.** With the `<Location "/api/chat">` block deleted — no `flushpackets=on` —
the stream was *still* incremental through the proxy (ratios 0.51 and 0.44 over two runs). On 2.4.67
`mod_proxy_http` forwards as it reads. The directive stays as an explicit guarantee, but the README no longer
suggests it is what makes streaming work.

### Repaired along the way

- `services/citation-py/.venv` had been broken since the folder moved on 2026-09-13: its console scripts still had
  `#!/Volumes/APFS/Repos/ordinance-agent/...` shebangs, so `launch.json`'s `citation-py` configuration could not
  have started. Rebuilt (Flask 3.1.3, Gunicorn 23.0.0). The earlier note that "the preview sandbox will not execute
  programs inside `.venv`" is *also* true and is the reason the service was started from a shell here: the sandbox
  denies reading that directory at all (`PermissionError` on the site-packages path).
- The CI cache for the model pointed at `~/.cache/huggingface`, which transformers.js never writes, so every CI run
  re-downloaded the weights. It now caches `models/` and runs `npm run model:fetch`, with `EMBEDDING_LOCAL_ONLY=1`
  on the embed and eval steps so CI exercises the same bundled path as the deployment.

### Switching the hosted deployment onto the vector pipeline

| Step | Result |
|---|---|
| Hosted index, before | `Article` 160 rows / `Question` 80 rows, **0 with a 384-dim vector**; no `IndexMeta` table; the `http` extension already installed |
| Schema | `index_meta` migration applied through the Supabase API, plus `GRANT` to `ordinance_app` (the app does not connect as `postgres`) |
| Export | `npm run embed:export` → `data/embeddings.json`, 1.89 MB, article digest `276f175b…`, question digest `5e9a050c…` |
| The digest is reproducible in SQL | the same two digests recomputed by `sha256(convert_to(string_agg(…)))` against the **local** database: byte-identical to the TypeScript, so the loader's refusal is a real check and not decoration |
| Fetchable | after pushing, `curl` of `raw.githubusercontent.com/…/3751814b/data/embeddings.json` → 200, 1,893,124 bytes (matches local) |
| Load | the loader ran against the hosted database: 160 articles + 80 questions embedded, stamp `Xenova/all-MiniLM-L6-v2@q8 dims=384 articles=160 questions=80` |
| Vectors arrived intact | article 114: L2 norm `1.000000`, self dot product `1.000000`, and `embedding[1] = 0.002445087535306811::float8` → **true** for the first, second and last component. (The API's JSON rounds to 15 digits on display, which looks like a mismatch and is not — hence the comparison in SQL) |
| Environment | `DENSE_RETRIEVAL=on`, `EMBEDDING_LOCAL_ONLY=1` set on Vercel production; redeployed |

**The first deployment with vectors on did not work, and said so itself.** `search_articles` came back
`paths_run: ["questionBank","fullText"]`, `dense_path: unavailable`. That is the reporting built above doing its
job — but two things were wrong with the state it exposed:

1. `/eval`, rendering in a *different* serverless function, still showed the vector pipeline as enabled, because
   all it could see was the environment variable. Fixed by having the retrieval route write down what it observed
   (`dense-path-observed` in `IndexMeta`) and letting that observation outrank the setting everywhere in the UI.
2. "unavailable" did not say why. Fixed by carrying the loader's own error out through `paths.denseReason` into the
   tool output — which then answered the question in one request:

   > `not running (Failed to load external module @huggingface/transformers-…: Error [ERR_MODULE_NOT_FOUND]:
   > Cannot find package 'sharp' imported from /var/task/node_modules/@huggingface/transformers/dist/transformers.node.mjs)`

`sharp` had been excluded from tracing as obviously useless to a text-embedding pipeline. It is the **only bare
import** in `transformers.node.mjs`, so excluding it stopped the module resolving at all. Checked the same build
for what else it reaches rather than guessing a second time — it names `onnxruntime-common` and `onnxruntime-node`
and never `onnxruntime-web`, so that 130 MB stays out. With `sharp` and `@img` back (minus the WASM fallback a
native build never touches), `/api/mcp` traces to **90.8 MB**: onnxruntime-node 35.56 MB, the model 23.69 MB,
sharp + @img 16.58 MB.

| After the fix | Result |
|---|---|
| Live `search_articles` | `paths_run: ["questionBank","fullText","dense"]`, `dense_path: ran`; among the hits, **article 116 found only by `semantic`** — the vector path is contributing on the deployment, not merely loading |
| Live `/eval` | no degradation notice; "向量索引 `…@q8 dims=384 articles=160 questions=80` · 建於 2026-09-14 —— 檢索行程最近一次實跑確認用的就是它", and the table's 91.3% |
| Live UI | browser at ordinance-agent.vercel.app, one question: the `qb`, `fts` **and `vec`** lanes all render `on` |
| Live latency, 12 samples | warm 0.97–1.61 s end to end from outside the region, median 1.61 s; 2.73–4.79 s when a request landed on a new instance. `find_questions`, which embeds nothing, is the same warm (1.20 / 1.63 s) — so the ~1.2 s floor is the round trips to Supabase, not the model, whose own share is the ~215 ms measured locally |

### CI

All four commits green, including the Apache step, which had never run on Debian when it was written: `Syntax OK`,
7 tools through the proxy, `/citations/parse -> count=4`, and `verdict: incremental` both direct and through the
proxy. The model cache now hits (`= onnx/model_quantized.onnx (22,972,370 bytes, already present)`), which the
previous key never did.

### Not verified

- The cold start was **observed** (2.7–4.8 s on a new instance) but not decomposed: how much of it is the model, how
  much the Node runtime and the first database connection, is not separated. Locally the model's share is ~215 ms.
- `deploy/systemd/citation-py.service` is still an unexercised example.
- Real model provider (Azure or OpenAI-compatible), Docker build: unchanged, still not run.
- The hosted database still has no `_prisma_migrations` history — `index_meta` was applied through the Supabase API
  like the schema before it, so Prisma does not know it has been applied there.
