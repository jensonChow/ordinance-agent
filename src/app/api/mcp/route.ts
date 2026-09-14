import { ResourceTemplate } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { formatCitation, getAnnex, getArticle, getArticleRange, listChapters, listQuestions, searchArticlesHybrid, searchQuestions, suggestTopics } from "@/lib/law";

export const runtime = "nodejs";

/** Serialise a tool payload as a single text content block (what LLM clients read). */
function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Basic Law MCP server (Streamable HTTP, stateless) mounted at /api/mcp.
 * Any MCP client — the chat agent in this app, Claude, Cursor, Codex — can call these tools.
 */
const CHAPTERS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"] as const;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_chapters",
      {
        title: "List chapters",
        description:
          "List the nine chapters of the Basic Law of the Hong Kong SAR with their sections and article ranges. Use it to orient before searching.",
        inputSchema: z.object({}),
      },
      async () => text({ chapters: await listChapters() }),
    );

    server.registerTool(
      "search_articles",
      {
        title: "Search articles",
        description:
          "Search the 160 articles of the Basic Law. Fuses three retrieval paths by reciprocal rank: the study question bank, PostgreSQL full-text search (strict websearch syntax first, then loose any-term matching) and sentence-embedding similarity. Each hit reports which paths found it in `found_by` and, when the question bank was one of them, the lay `model_questions` that map to it. Pass `chapters` to honour a topic the reader has chosen. Returns ranked hits with snippets; follow up with get_article for the full text before quoting.",
        inputSchema: z.object({
          query: z.string().min(2).max(200).describe("Search terms, e.g. 'permanent resident seven years'"),
          limit: z.number().int().min(1).max(10).default(5),
          chapters: z
            .array(z.enum(CHAPTERS))
            .max(9)
            .optional()
            .describe("Restrict the search to these chapters, e.g. ['III'] once the reader has confirmed the topic"),
        }),
      },
      async ({ query, limit, chapters }) => {
        const hits = await searchArticlesHybrid(query, limit, chapters);
        return text({
          query,
          chapters: chapters ?? null,
          hits: hits.map((h) => ({
            article: h.number,
            citation: formatCitation(h.number),
            chapter: `${h.chapterNumber} ${h.chapterTitle}`,
            match: h.mode,
            found_by: h.sources ?? [],
            model_questions: h.viaQuestions?.map((q) => q.text) ?? [],
            snippet: h.snippet,
          })),
        });
      },
    );

    server.registerTool(
      "suggest_topics",
      {
        title: "Suggest topics",
        description:
          "Rank the chapters of the Basic Law a situation is likely to fall under, before searching. Use it when the question is broad or the wording could belong to more than one chapter: offer the top chapters to the reader, let them confirm, then pass the confirmed chapters to search_articles. Returns chapters with a score and the articles that drove it.",
        inputSchema: z.object({
          query: z.string().min(2).max(300).describe("The situation or question in the reader's own words"),
          limit: z.number().int().min(1).max(9).default(3),
        }),
      },
      async ({ query, limit }) => {
        const topics = await suggestTopics(query, limit);
        return text({
          query,
          topics: topics.map((t) => ({
            chapter: t.chapter,
            title: t.title,
            score: t.score,
            articles: t.articles,
          })),
        });
      },
    );

    server.registerTool(
      "find_questions",
      {
        title: "Find study questions",
        description:
          "Match an everyday-language question against the study question bank (80 lay questions, each mapped to the Basic Law articles that answer it). Use this first when the user's wording is not legal wording; then read the articles with get_article.",
        inputSchema: z.object({
          query: z.string().min(2).max(300).describe("The user's question in their own words"),
          limit: z.number().int().min(1).max(5).default(3),
        }),
      },
      async ({ query, limit }) => {
        const hits = await searchQuestions(query, limit);
        return text({
          query,
          questions: hits.map((h) => ({
            id: h.id,
            question: h.text,
            articles: h.articles,
            citations: h.articles.map((n) => formatCitation(n)),
            tags: h.tags,
            rank: Number(h.rank.toFixed(4)),
          })),
        });
      },
    );

    server.registerTool(
      "get_article",
      {
        title: "Get article",
        description: "Return the full text of one article (1–160) with its chapter, section and any footnotes.",
        inputSchema: z.object({ number: z.number().int().min(1).max(160) }),
      },
      async ({ number }) => {
        const a = await getArticle(number);
        if (!a) return { content: [{ type: "text" as const, text: `Article ${number} not found` }], isError: true };
        return text({
          article: a.number,
          citation: formatCitation(a.number),
          chapter: `${a.chapter.number} ${a.chapter.title}`,
          section: a.section ? `Section ${a.section.number} ${a.section.title}` : null,
          text: a.text,
          notes: a.notes,
        });
      },
    );

    server.registerTool(
      "get_articles",
      {
        title: "Get a range of articles",
        description: "Return the full text of consecutive articles, e.g. 24–42 for Chapter III. At most 12 articles per call.",
        inputSchema: z
          .object({
            from: z.number().int().min(1).max(160),
            to: z.number().int().min(1).max(160),
          })
          .refine((r) => r.to >= r.from && r.to - r.from < 12, { message: "to must be >= from and span at most 12 articles" }),
      },
      async ({ from, to }) => {
        const rows = await getArticleRange(from, to);
        return text({
          articles: rows.map((a) => ({ article: a.number, citation: formatCitation(a.number), text: a.text })),
        });
      },
    );

    server.registerTool(
      "get_annex",
      {
        title: "Get annex",
        description:
          "Return one of the three annexes: I (selection of the Chief Executive), II (formation of the Legislative Council), III (national laws applied in the HKSAR).",
        inputSchema: z.object({ id: z.enum(["I", "II", "III"]) }),
      },
      async ({ id }) => {
        const annex = await getAnnex(id);
        if (!annex) return { content: [{ type: "text" as const, text: `Annex ${id} not found` }], isError: true };
        return text({ annex: annex.id, title: annex.title, text: annex.text });
      },
    );

    // ---------------------------------------------------------------- resources
    // Tools are for the agent loop; resources let a human-driven client (Claude, Cursor) browse the corpus
    // and attach a specific article to its context without spending a tool call.

    server.registerResource(
      "contents",
      "basic-law://contents",
      { title: "Table of contents", description: "Chapters, sections and article ranges of the Basic Law.", mimeType: "text/markdown" },
      async (uri) => {
        const chapters = await listChapters();
        const body = chapters
          .map((c) => {
            const range = c.articles ? ` (Articles ${c.articles.from}–${c.articles.to})` : "";
            const sections = c.sections.map((s) => `\n  - Section ${s.number}. ${s.title}`).join("");
            return `- **Chapter ${c.number}. ${c.title}**${range}${sections}`;
          })
          .join("\n");
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# Basic Law — contents\n\n${body}\n` }] };
      },
    );

    server.registerResource(
      "question-bank",
      "basic-law://question-bank",
      {
        title: "Study question bank",
        description: "80 everyday-language questions, each mapped to the articles that answer it.",
        mimeType: "application/json",
      },
      async (uri) => {
        const questions = await listQuestions();
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ questions }, null, 2) }] };
      },
    );

    server.registerResource(
      "article",
      new ResourceTemplate("basic-law://article/{number}", {
        // Listing all 160 articles would flood a client's resource list; they are reachable by URI and through search.
        list: undefined,
        complete: {
          number: (value) =>
            Array.from({ length: 160 }, (_, i) => String(i + 1))
              .filter((n) => n.startsWith(value))
              .slice(0, 20),
        },
      }),
      { title: "Article", description: "Full text of one article, 1–160.", mimeType: "text/plain" },
      async (uri, { number }) => {
        const n = Number(Array.isArray(number) ? number[0] : number);
        const a = Number.isInteger(n) ? await getArticle(n) : null;
        if (!a) throw new Error(`Article ${String(number)} not found (valid range 1–160)`);
        const notes = a.notes.length ? `\n\nNotes:\n${a.notes.map((x) => `- ${x}`).join("\n")}` : "";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `${formatCitation(a.number)} — Chapter ${a.chapter.number} ${a.chapter.title}\n\n${a.text}${notes}`,
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------ prompts
    // The retrieval discipline this project cares about (look it up, then cite it), packaged so any MCP client
    // gets the same behaviour as the built-in chat route.

    server.registerPrompt(
      "answer-with-citations",
      {
        title: "Answer with citations",
        description: "Answer a lay question about the Basic Law by looking the text up first and citing every article used.",
        argsSchema: z.object({ question: z.string().min(2).describe("The question in the user's own words") }),
      },
      ({ question }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Answer this question about the Basic Law of the Hong Kong SAR: "${question}"

Work in this order:
1. call find_questions with the question as written — the study bank maps lay wording to articles;
2. if that returns nothing useful, call search_articles;
3. call get_article for every article you intend to rely on, and read it before quoting;
4. answer in a few sentences, quote the operative wording, and cite each article as "Article N".

Never name an article you have not read. If the Basic Law does not settle the question, say so. This is a study aid, not legal advice.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "explain-article",
      {
        title: "Explain an article",
        description: "Explain one article in plain language for a reader with no legal training.",
        argsSchema: z.object({
          number: z.string().describe("Article number, 1–160"),
          audience: z.string().optional().describe("Who it is for, e.g. 'a secondary school class'"),
        }),
      },
      ({ number, audience }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Read Article ${number} of the Basic Law with get_article (or the basic-law://article/${number} resource), then explain it${
                audience ? ` for ${audience}` : " for a reader with no legal training"
              }.

Give: one sentence on what it does; the operative wording quoted; what it does not cover; any NPCSC interpretation note attached to it. Cite it as "Article ${number}". This is a study aid, not legal advice.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "compare-articles",
      {
        title: "Compare two articles",
        description: "Read two articles and set out how they interact.",
        argsSchema: z.object({ first: z.string().describe("First article number"), second: z.string().describe("Second article number") }),
      },
      ({ first, second }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Call get_article for Article ${first} and Article ${second}, then compare them: what each one does, where they overlap, and whether one qualifies the other. Quote the wording you rely on and cite both. If they do not interact, say so plainly.`,
            },
          },
        ],
      }),
    );
  },
  { serverInfo: { name: "basic-law-mcp", version: "0.3.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
