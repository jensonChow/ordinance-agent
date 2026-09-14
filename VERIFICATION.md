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

## Not verified

- **Azure OpenAI**: the provider path (`@ai-sdk/azure`, `createAzure({ resourceName, apiKey })`, deployment as model id)
  compiles and is selected when `AZURE_*` are set, but no request has been made to an Azure resource yet.
- **OpenAI-compatible fallback**: same — wired, not exercised against a live endpoint.
- **Vercel deployment**: not deployed yet.
- **Docker image** for the Flask service: Dockerfile written, not built (no Docker on the build machine); the same
  `gunicorn` command was run directly in a venv on 2026-09-10. The endpoints added on 2026-09-13 (`GET /`, `POST /parse`)
  were exercised through Flask's test client, not through Gunicorn.
- **`deploy/apache/basic-law.conf` and `deploy/systemd/citation-py.service`**: written as worked examples from the
  documented directives; never loaded by an Apache or systemd instance, and not touched by CI.
- **Concurrency / multi-user behaviour**: single-user local runs only.

## One bug found and fixed during verification

The first smoke run persisted the assistant message with an empty id (`responseMessage.id === ""`), so the second turn
overwrote the first and its tool calls. Fix: `toUIMessageStreamResponse({ generateMessageId })` plus a server-side
fallback id in `onFinish`. The rerun shows two distinct assistant rows with their own tool calls and citations.
