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
