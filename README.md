# Basic Law Study Agent

A small, complete AI application for studying the **Basic Law of the Hong Kong SAR**: an agent that looks the text up
through **MCP tools**, quotes and cites articles, and keeps the learner's notes and every tool call in **PostgreSQL**.

It exists as a working sample of one specific stack — **Vercel AI SDK · Model Context Protocol · Prisma + PostgreSQL ·
Azure OpenAI**, plus a tiny **Flask/Gunicorn** side-service — rather than as a product. Study aid only; not legal advice.

```
Next.js 16 (App Router, TypeScript)
├─ /                 chat UI (@ai-sdk/react useChat) + notes / corpus sidebar (server-rendered from Prisma)
├─ /api/chat         agent loop: streamText + tool calling, stopWhen isStepCount(8)
│                    tools = MCP tools discovered at runtime (@ai-sdk/mcp)  +  local Prisma tools (save_note, list_notes, format_citation)
├─ /api/mcp          Basic Law MCP server (mcp-handler, Streamable HTTP, stateless) — usable from Claude / Cursor / Codex too
├─ /api/conversations, /api/notes
├─ prisma/           schema (Chapter, Section, Article, Annex, Conversation, Message, ToolCall, Citation, Note), migrations, seed
├─ data/             basic-law.en.json  ←  scripts/parse_basic_law.py  ←  official booklet PDF
└─ services/citation-py   optional Flask app served by Gunicorn (Dockerfile included)
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
| `search_articles` | MCP server | PostgreSQL full-text search (`websearch_to_tsquery`, `ts_rank_cd`, `ts_headline` snippets, GIN index) |
| `get_article` / `get_articles` | MCP server | Full text of one article or a range, with chapter/section and NPCSC-interpretation footnotes |
| `get_annex` | MCP server | Annexes I–III |
| `save_note` / `list_notes` | local (Prisma) | Study notes, optionally attached to an article |
| `format_citation` | local → Flask | Citation string; calls the Python service when `CITATION_SERVICE_URL` is set |

Every assistant turn is persisted with its **UI message parts**, the **tool calls** it made (input, output, source
`mcp`/`local`) and the **articles it cited**, so a conversation is auditable after the fact.

## Run it locally

Prerequisites: Node 22+, PostgreSQL (any 14+; Homebrew, Docker or a hosted database), and `pdftotext` (poppler) only
if you want to rebuild the corpus.

```bash
npm install                              # also runs `prisma generate`
cp .env.example .env                     # set DATABASE_URL and a model provider
npm run db:migrate                       # creates tables + the full-text index
npm run db:seed                          # loads data/basic-law.en.json (160 articles, 3 annexes)
npm run dev
```

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

### Rebuild the corpus

```bash
npm run corpus:build      # downloads the official booklet PDF, runs pdftotext, writes data/basic-law.en.json
npm run db:seed
```

`scripts/parse_basic_law.py` locates the Basic Law inside the booklet (which also contains the PRC Constitution),
rebuilds paragraphs and list items from the `-layout` text, separates page-bottom footnotes into `notes`, and checks
that all 160 articles are present exactly once.

## Deploy

- **Vercel**: import the repo; set `DATABASE_URL` (Neon, Supabase, Azure Database for PostgreSQL …) and the model
  variables; run `npx prisma migrate deploy && npm run db:seed` once against the production database. `/api/chat`
  reaches the MCP server on the same deployment; override with `MCP_SERVER_URL` if you host it elsewhere.
- **Citation service**: `docker build -t citation-py services/citation-py && docker run -p 8000:8000 citation-py`, then set
  `CITATION_SERVICE_URL=http://host:8000`. Without it the agent formats citations locally.

## Data

Text comes from the official booklet published on the HKSAR Government's Basic Law website
(`basiclaw.gov.hk`, *The Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China*).
The booklet states that its content "has no legal status, and is made available for information only". This
repository reproduces it solely as a study corpus.

## Scope and limits

- Lexical search only (tsvector), deliberately — the point is tool use, citations and persistence, not retrieval research.
- Single-tenant: no auth; a conversation is addressed by its id in the URL.
- The mock provider is scripted, not a model; it exercises the plumbing, not answer quality.
- Azure OpenAI is wired through the official AI SDK provider but only runs when you supply an Azure deployment.

## Verification log

[VERIFICATION.md](VERIFICATION.md) lists exactly which commands were run, on which date, with which results.

## License

MIT © 2026 ZHOU Zaixing (Jenson Chow)
