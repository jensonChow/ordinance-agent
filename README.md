# Basic Law Study Agent

[![ci](https://github.com/jensonChow/ordinance-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/jensonChow/ordinance-agent/actions/workflows/ci.yml)

**Live: [ordinance-agent.vercel.app](https://ordinance-agent.vercel.app)** — real corpus, the full four-path
retrieval including sentence embeddings, real citation audit and ratings. No model key is configured there, so the
assistant will not compose prose answers; it says so and shows what retrieval returned. See [Deploy](#deploy) for
exactly what is and is not running.

The interface is in Chinese — Hong Kong legal information is bilingual, and so are HKLII and CLIC — while article
text is the Government's English booklet and is marked `lang="en"` wherever it appears. It is built from a design
canvas kept in [`design/`](design/), whose README records the layout rules and the two places this implementation
deliberately departs from the mock.

A small, complete AI application for studying the **Basic Law of the Hong Kong SAR**: an agent that looks the text up
through **MCP tools**, quotes and cites articles, and keeps the learner's notes and every tool call in **PostgreSQL**.

It exists as a working sample of one specific stack — **Vercel AI SDK · Model Context Protocol · Prisma + PostgreSQL ·
Azure OpenAI**, plus a tiny **Flask/Gunicorn** side-service — rather than as a product. Study aid only; not legal advice.

```
Next.js 16 (App Router, TypeScript)
├─ /                 chat UI (@ai-sdk/react useChat) + topic chips + notes / corpus sidebar (server-rendered from Prisma)
├─ /article/[n]      permanent, linkable page for one article + the study questions that lead to it
├─ /eval             the retrieval benchmark and the reader ratings, rendered from the same data the CLI prints
├─ /api/chat         agent loop: streamText + tool calling, stopWhen isStepCount(8)
│                    tools = MCP tools discovered at runtime (@ai-sdk/mcp)  +  local Prisma tools (save_note, list_notes, format_citation)
├─ /api/mcp          Basic Law MCP server (mcp-handler, Streamable HTTP, stateless) — usable from Claude / Cursor / Codex too
│                    7 tools · 2 resources + an article template · 3 prompts
├─ /api/ratings      0-5 relevance judgements on a cited article, upserted per (message, article)
├─ /api/conversations, /api/notes
├─ prisma/           schema (Chapter, Section, Article, Annex, Conversation, Message, ToolCall, Citation, Rating, Note), migrations, seed
├─ data/             basic-law.en.json  ←  scripts/parse_basic_law.py  ←  official booklet PDF
│                    question-bank.json — 80 lay questions → articles, each with 2 held-out paraphrases for evaluation
├─ scripts/embed-corpus.ts     writes 384-dim sentence embeddings into PostgreSQL (npm run embed)
├─ scripts/eval-retrieval.ts   retrieval evaluation (eval/RESULTS.md)
├─ services/citation-py   optional Flask app served by Gunicorn (Dockerfile included)
└─ deploy/            example Apache vhost and systemd unit for a plain Linux host
```

```mermaid
flowchart LR
  UI[Chat UI<br/>useChat] -->|UIMessage stream| CHAT[/api/chat<br/>streamText · tool loop/]
  CHAT -->|createMCPClient http| MCP[/api/mcp<br/>mcp-handler/]
  MCP --> LAW[(PostgreSQL<br/>articles · tsvector FTS)]
  CHAT -->|local tools| NOTES[(PostgreSQL<br/>notes · messages · tool calls · citations)]
  CHAT -->|@ai-sdk/azure| AZ[Azure OpenAI deployment]
  CHAT -.->|fallback| OC[OpenAI-compatible endpoint]
  CHAT -.->|optional| PY[Flask + Gunicorn<br/>citation service]
```

## What the agent can do

| Tool | Where it runs | What it does |
|---|---|---|
| `list_chapters` | MCP server | Nine chapters, their sections and article ranges |
| `find_questions` | MCP server | Matches an everyday-language question against the **study question bank** (80 lay questions → the articles that answer them) |
| `suggest_topics` | MCP server | Ranks the chapters a situation is likely to fall under, **before** searching, so a reader with no legal vocabulary can confirm or correct the topic |
| `search_articles` | MCP server | **Hybrid retrieval**: the question bank (lexical + vector), PostgreSQL full-text search (strict `websearch_to_tsquery`, then loose any-term over de-boilerplated text) and sentence-embedding similarity, fused by reciprocal rank. Every hit reports `found_by` (the paths that returned it) and `model_questions` (the lay questions that map to it); `chapters` restricts it to a topic the reader picked |
| `get_article` / `get_articles` | MCP server | Full text of one article or a range, with chapter/section and NPCSC-interpretation footnotes |
| `get_annex` | MCP server | Annexes I–III |
| `save_note` / `list_notes` | local (Prisma) | Study notes, optionally attached to an article |
| `format_citation` | local → Flask | Citation string; calls the Python service when `CITATION_SERVICE_URL` is set, otherwise formats locally |
| `parse_citations` | local → Flask | Pulls citations out of a pasted passage (`BL art 24(2), Articles 45 to 47`) so they can be read with `get_article` |

Every assistant turn is persisted with its **UI message parts**, the **tool calls** it made (input, output, source
`mcp`/`local`) and the **articles it cited**, so a conversation is auditable after the fact.

## Citation audit: what the answer actually stands on

The interesting failure of a legal assistant is not a wrong sentence, it is a *confident* sentence citing an article
the model never opened. Every article chip under an answer is therefore derived from that message's own tool calls,
never from the prose:

| chip | meaning |
|---|---|
| green, `Art. 24 fts` | the agent read the full text; `fts` / `qb` says whether full-text search or the question bank surfaced it |
| plain | retrieval returned it, but the full text was never read |
| **amber, `Art. 106 ⚠`** | the answer names it and **no tool ever returned it** — the number came from the model's memory |

Opening a chip shows the article in full, the **study question the retrieval actually matched**, the passage that
earned the hit, and a 0-5 relevance rating.

`messageCitations()` in `src/lib/citations.ts` computes this. The mock provider deliberately ends one scripted answer
by naming an article it did not read, so the amber state is reachable from `npm test` and from the keyless smoke run
instead of only in theory.

## Retrieval: three paths, fused

People ask the Basic Law questions in everyday words ("Do I pay customs duty on goods I bring in?") while the text
says "free port … shall not impose any tariff". Strict full-text search finds nothing at all for that question.
Three cheap, transparent paths are combined instead:

1. **Loose lexical matching over de-boilerplated text** — the phrases every article repeats ("of the Hong Kong
   Special Administrative Region") are stripped into a `searchText` column so they stop dominating rank; query
   terms are OR-ed once strict matching fails.
2. **A study question bank** — 80 hand-written lay questions mapped to the articles that answer them, searchable
   lexically and by vector.
3. **Sentence embeddings** — all 160 articles and the 80 canonical questions are embedded locally with
   `all-MiniLM-L6-v2` (384 dims, int8, `npm run embed`) and stored in a `Float[]` column; similarity is a dot
   product of L2-normalised vectors computed in SQL. The model file is fetched into `models/` at build time
   (`npm run model:fetch`) and bundled into the deployment, so no request ever waits on huggingface.co.

The three are merged by **reciprocal rank fusion** (k = 60, not tuned). Each hit carries `found_by`, so an answer's
citations say which path produced them — and the result as a whole carries `paths_run`, because "no `vec` among the
hits" has two different meanings and a citation trail should not make the reader guess between them:

| | what it means |
|---|---|
| `paths_run` includes `dense`, no hit says `semantic` | vectors ran and lost to the other paths on this question |
| `paths_run` omits `dense` | vectors were not running at all — the model is absent or switched off, and these results are lexical only |

The interface shows the difference: the `vec` lane is faint in the first case and struck through in the second.

### Evaluation

Each of the 80 questions carries two paraphrases: paraphrase 1 is the **dev** set (tags and stop-words were tuned
on it), paraphrase 2 is the **test** set, never inspected while tuning. The canonical questions are never used as
queries, and the paraphrases are never indexed or embedded. `npm run eval:retrieval` measures whether the right
article is in the top-k (full tables in [eval/RESULTS.md](eval/RESULTS.md)):

| strategy (test set, 80 held-out paraphrases) | primary@1 | primary@3 | primary@5 | any@5 |
|---|---|---|---|---|
| strict FTS | 23.8% | 23.8% | 23.8% | 26.3% |
| loose FTS | 46.3% | 60.0% | 65.0% | 75.0% |
| smart FTS (strict→loose) | 52.5% | 62.5% | 67.5% | 78.8% |
| question bank (lexical) | 55.0% | 68.8% | 72.5% | 72.5% |
| question bank → smart FTS | 55.0% | 71.3% | 80.0% | 85.0% |
| dense (articles) | 60.0% | 82.5% | 87.5% | **93.8%** |
| dense (question bank) | 55.0% | 68.8% | 75.0% | 75.0% |
| **hybrid RRF (bank ×2 + FTS + dense)** | **63.7%** | **85.0%** | **91.3%** | 93.8% |

Two results worth stating plainly rather than burying:

- **Dense retrieval alone beats the entire hand-built pipeline on held-out queries** — 87.5% against 80.0%
  primary@5 — despite the question bank being 80 questions written by hand and the lexical layer having been
  tuned. A 23 MB model that was never shown this corpus does better than the tuning.
- **The tuning had overfit the dev set, and the fusion narrows that.** On dev the old pipeline scored 95.0% but only
  80.0% on test, a 15-point gap. Hybrid scores 95.0% dev / 91.3% test, a 3.7-point gap. The dev number barely moved;
  the honest number moved a lot.
- **Quantising the model cost nothing measurable.** The table is measured at int8 (`q8`, 23 MB). At fp32 (90 MB) the
  same fusion reads 88.8% test / 96.2% dev — test up 2.5 points at q8, dev down 1.2. Both swings are one to two
  questions out of 80, so the right conclusion is that the precision does not matter here, **not** that int8
  retrieves better. It was chosen for a different reason: 23 MB against 90 MB, and roughly half the load time, is
  what makes the dense path affordable inside a serverless function. `EMBEDDING_DTYPE=fp32` switches back (then
  `npm run embed` again — see below).

The numbers are retrieval only — whether the *article* is found — not answer quality; the agent still reads the
article with `get_article` and quotes it. The remaining test misses are mostly questions whose primary article is
one of several plausible ones (`any@5` is 93.8%).

**The index records which model built it.** A query embedded by one model and scored against an index built by
another still returns five articles — plausible ones, worse ones — with nothing thrown and nothing logged. So
`npm run embed` writes the model and precision into an `IndexMeta` row, and `/eval` compares that against what the
process is running and says so when they differ. The cheaper check was tried first and does not work: re-embedding
a stored row and comparing cannot separate the cases, because batching perturbs a vector more than quantisation
does (0.9989 self-similarity against 0.9967 across precisions — [VERIFICATION.md](VERIFICATION.md)).

## What this borrows from the AI CLIC Recommender

The [AI CLIC Recommender](https://ai.hklii.hk/recommender/) is a public tool from the University of Hong Kong's Law
and Technology Centre, which also runs [HKLII](https://www.hklii.hk) and [CLIC](https://clic.org.hk). This project is
not affiliated with any of them; it is a study sample built on a public government text. But the Recommender has
already solved problems this kind of application runs into, and three of its design choices are worth copying rather
than reinventing:

| What the Recommender does | What this project does with it |
|---|---|
| Asks you to describe a situation, then has you **confirm the topics** it inferred before it returns anything | `suggest_topics` ranks chapters from the same retrieval that is about to run, the answer offers them as chips, and the chapters the reader ticks are passed to `search_articles` as a SQL filter — not merely mentioned in the prompt |
| Presents each result as a **model question** standing for a page, not as a document | The study bank plays that role here: every hit carries the lay questions that map to it, and the article panel names the one that matched |
| Puts **"Is this recommendation relevant?" (0-5)** under every result | `/api/ratings` stores the same judgement per (answer, article) in PostgreSQL, and `/eval` shows the distribution beside the offline benchmark |

The last one matters most. The benchmark below measures whether retrieval found the article *the question bank says
is correct*. A reader's 0-5 score measures whether it was any use — a different question, and not one an automatic
metric can answer. Having both in the same page is the point.

Where it deliberately differs: the Recommender recommends pages and stops there, while this answers in prose. That
is a heavier promise, which is why every answer carries the citation audit above and flags any article it named
without opening.

## Run it locally

Prerequisites: Node 22+, PostgreSQL (any 14+; Homebrew, Docker or a hosted database), and `pdftotext` (poppler) only
if you want to rebuild the corpus.
On a Mac with Homebrew's `postgresql@17`, `scripts/local-postgres.sh init` creates a throwaway cluster inside the repo
(`.local/pgdata`, gitignored) on port 5433; `start` / `stop` / `status` / `psql` manage it.

```bash
npm install                              # also runs `prisma generate`
cp .env.example .env                     # set DATABASE_URL and a model provider
npm run db:migrate                       # creates tables + the full-text index
npm run db:seed                          # loads data/basic-law.en.json (160 articles, 3 annexes) and data/question-bank.json (80 questions)
npm run model:fetch                      # 23 MB sentence-embedding model into models/ (also runs as `prebuild`)
npm run embed                            # 384-dim embeddings for 160 articles + 80 questions — no API key, ~15 s
npm run dev
```

Dense retrieval knobs, all optional:

| variable | |
|---|---|
| `DENSE_RETRIEVAL=off` | drop the two vector paths; retrieval degrades to the question bank + full-text search, and every search says so in `paths_run` |
| `EMBEDDING_DTYPE=fp32` | the 90 MB original weights instead of the 23 MB int8 ones. **Re-run `npm run embed` after changing it** — `/eval` will otherwise tell you the index no longer matches the model |
| `EMBEDDING_LOCAL_ONLY=1` | refuse to fall back to huggingface.co, i.e. fail loudly if `models/` is missing. What CI and the deployment use |

Model provider (first match wins, or force with `MODEL_PROVIDER`):

- **Azure OpenAI** — `AZURE_RESOURCE_NAME`, `AZURE_API_KEY`, `AZURE_DEPLOYMENT` (`@ai-sdk/azure`).
- **OpenAI-compatible** — `OPENAI_COMPATIBLE_BASE_URL/_API_KEY/_MODEL` (OpenRouter, vLLM, Ollama …) via `@ai-sdk/openai-compatible`.
- **mock** — a scripted `MockLanguageModelV3` that walks the real tool loop (search → get_article → answer, or save_note) with no API key.

### Keyless end-to-end test

```bash
MODEL_PROVIDER=mock npm run dev -- -p 3100
node scripts/smoke-chat.mjs http://127.0.0.1:3100
```

The script creates a conversation, sends two turns through `/api/chat`, and checks that the stream contains the
expected tool calls and text. Rows land in `Message`, `ToolCall`, `Citation` and `Note`.

### Use the MCP server from another client

The tools are served stateless over Streamable HTTP at `/api/mcp`, so any MCP client can use them:

```bash
# Claude Code
claude mcp add --transport http basic-law http://localhost:3000/api/mcp

# plain JSON-RPC
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_articles","arguments":{"query":"permanent resident seven years","limit":3}}}'
```

Beyond tools, the server exposes the corpus as **resources** and the house retrieval discipline as **prompts**, so a
human-driven client can attach one article to its context, or reuse the workflow, without going through the chat route:

| kind | name | |
|---|---|---|
| resource | `basic-law://contents` | chapters, sections and article ranges (markdown) |
| resource | `basic-law://question-bank` | the 80 lay questions and their articles (JSON) |
| resource template | `basic-law://article/{number}` | one article, with completion over 1–160 |
| prompt | `answer-with-citations` | find_questions → search_articles → get_article → answer, citing every article read |
| prompt | `explain-article` | plain-language explanation of one article for a stated audience |
| prompt | `compare-articles` | read two articles and set out how they interact |

Swap `tools/call` above for `resources/list`, `resources/templates/list`, `prompts/list`, `resources/read` or
`prompts/get` to see them.

### Rebuild the corpus

```bash
npm run corpus:build      # downloads the official booklet PDF, runs pdftotext, writes data/basic-law.en.json
npm run db:seed
```

`scripts/parse_basic_law.py` locates the Basic Law inside the booklet (which also contains the PRC Constitution),
rebuilds paragraphs and list items from the `-layout` text, separates page-bottom footnotes into `notes`, and checks
that all 160 articles are present exactly once.

## Deploy

### The hosted demo

[ordinance-agent.vercel.app](https://ordinance-agent.vercel.app) runs this repository on Vercel (functions pinned to
`sin1`) against Supabase PostgreSQL in `ap-southeast-1` — same region, because a turn makes several round trips to
the database. What is running there, precisely:

| | |
|---|---|
| Corpus | the real 160 articles, 3 annexes and 80 study questions, verified byte-identical to a local seed by SHA-256 over `Article.text`, `Article.searchText`, `Question.searchText` and `Annex.text` |
| Retrieval | **all four paths, including the two vector ones** — the same fusion the table above measures at 91.3% primary@5. The model is bundled into the function (`EMBEDDING_LOCAL_ONLY=1`, so a missing file is an error rather than a quiet download), and the index was loaded into the hosted database from `data/embeddings.json` with the digest check in `deploy/supabase/load-embeddings.sql` |
| Latency | a warm `search_articles` through the MCP endpoint is ~1.0–1.6 s end to end from outside the region, and a call that needs no embedding (`find_questions`) is the same, so that figure is the round trips to the database, not the model. A request landing on a new instance has been seen at 2.7–4.8 s |
| Model | `MODEL_PROVIDER=mock`. For the questions the script covers you get a written answer; for anything else it runs the real search and then says it will not compose an answer, listing what retrieval returned |
| Everything else | genuine: the MCP server at `/api/mcp`, the citation audit, the article panel, the 0-5 ratings and their aggregates on `/eval` |

**The index is loaded as a file, not typed into the database.** `npm run embed && npm run embed:export` writes
`data/embeddings.json` — the vectors plus the model that made them and a SHA-256 digest of the exact corpus text
they were computed from — and `deploy/supabase/load-embeddings.sql` has the hosted PostgreSQL fetch that from this
public repository with the `http` extension, recompute the digest in SQL, and refuse the file if it disagrees. The
same route the corpus took. It exists because a raw PostgreSQL connection from the machine doing the deploy opens
and then hangs, so `npm run embed` cannot be pointed at production; the side effect is that what production is
querying stays inspectable in the repository at a known commit.

Two honest notes about how it was provisioned. The schema was applied through the Supabase API rather than
`prisma migrate deploy`, because the machine doing the deploy could not open a raw PostgreSQL connection; the seed
was loaded by having PostgreSQL fetch this repository's `data/*.json` over HTTPS, with `Article.searchText`
reimplemented in SQL and checked against the TypeScript seed by checksum before anything else ran. And the database
URL uses `uselibpqcompat=true&sslmode=require`, i.e. the connection is encrypted but the certificate is not
verified, because the pooler's chain does not validate against the system roots; a deployment holding anything
private should pin the provider's CA with `sslrootcert` instead.

### Deploying it yourself

- **Vercel**: import the repo; set `DATABASE_URL` (Neon, Supabase, Azure Database for PostgreSQL …) and the model
  variables; run `npx prisma migrate deploy && npm run db:seed` once against the production database. `/api/chat`
  reaches the MCP server on the same deployment; override with `MCP_SERVER_URL` if you host it elsewhere.
- **Citation service**: `docker build -t citation-py services/citation-py && docker run -p 8000:8000 citation-py`, then set
  `CITATION_SERVICE_URL=http://host:8000`. Without it the agent formats and parses citations locally — the service is
  optional on purpose, and every call to it is bounded by a 2.5s timeout that falls back rather than stalling the loop.
- **Plain Linux host (Apache + Gunicorn)**: `deploy/apache/basic-law.conf` fronts the Node app and proxies the Python
  service under `/citations/`; `deploy/systemd/citation-py.service` runs Gunicorn. The proxying is **run**, not just
  written down — `deploy/apache/local-check.sh` starts Apache on port 8080 against a TLS-less copy of the same vhost
  and checks both upstreams through it, including that the `/api/chat` token stream still arrives incrementally
  (`scripts/stream-timing.mjs`; a proxy that buffers the body is invisible to every other test in this repo and
  leaves the reader staring at a blank page until the tool loop ends). CI runs it on Apache 2.4 under Debian.

  One result from doing it rather than assuming it: with `flushpackets=on` removed, `mod_proxy_http` **still**
  streamed incrementally on 2.4.67 — the directive is an explicit guarantee, not the thing that saves you. The
  systemd unit remains an unexercised example.

## Data

Text comes from the official booklet published on the HKSAR Government's Basic Law website
(`basiclaw.gov.hk`, *The Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China*).
The booklet states that its content "has no legal status, and is made available for information only". This
repository reproduces it solely as a study corpus.

## Scope and limits

- Embeddings are computed by a 23 MB local model (`all-MiniLM-L6-v2`), not a hosted embedding API: anyone who clones
  the repo can reproduce the retrieval numbers without a key. The trade-off is a weaker encoder than a commercial one,
  and articles longer than roughly 256 tokens are truncated before embedding.
- Vectors live in a plain `Float[]` column scanned sequentially, not in pgvector. At 160 articles an exact scan is
  faster than any approximate index; on a corpus the size of HKLII the column would become a `vector(384)` with an
  HNSW index and nothing else in the query layer would change.
- If the model cannot be loaded (offline, or `DENSE_RETRIEVAL=off`), dense search returns nothing and the fusion
  degrades to exactly the previous question-bank + full-text behaviour rather than failing — and **says so**:
  `paths_run` omits `dense`, the `vec` lane is struck through, and `/eval` names the degraded pipeline's own score.
  A silent degradation would be the worse bug of the two, and it is the one that nearly shipped: the file tracer
  does not follow `onnxruntime-node`'s runtime `require` of its native binary, so a deployment can carry the model
  and still be unable to load it (VERIFICATION.md).
- Single-tenant: no auth; a conversation is addressed by its id in the URL. Relevance ratings are therefore
  unauthenticated too — fine for a sample, but a real deployment collecting them for research would need a per-reader
  identity before the numbers meant anything.
- The mock provider is scripted, not a model; it exercises the plumbing, not answer quality.
- Azure OpenAI is wired through the official AI SDK provider but only runs when you supply an Azure deployment.

## Verification log

[VERIFICATION.md](VERIFICATION.md) lists exactly which commands were run, on which date, with which results.

## License

MIT © 2026 ZHOU Zaixing (Jenson Chow)
