import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { formatCitation, getAnnex, getArticle, getArticleRange, listChapters, searchArticles } from "@/lib/law";

export const runtime = "nodejs";

/** Serialise a tool payload as a single text content block (what LLM clients read). */
function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Basic Law MCP server (Streamable HTTP, stateless) mounted at /api/mcp.
 * Any MCP client — the chat agent in this app, Claude, Cursor, Codex — can call these tools.
 */
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
          "Full-text search over the 160 articles of the Basic Law (PostgreSQL websearch syntax: quoted phrases, OR, -exclusions). Returns ranked hits with highlighted snippets. Follow up with get_article for the full text before quoting.",
        inputSchema: z.object({
          query: z.string().min(2).max(200).describe("Search terms, e.g. 'permanent resident seven years'"),
          limit: z.number().int().min(1).max(10).default(5),
        }),
      },
      async ({ query, limit }) => {
        const hits = await searchArticles(query, limit);
        return text({
          query,
          hits: hits.map((h) => ({
            article: h.number,
            citation: formatCitation(h.number),
            chapter: `${h.chapterNumber} ${h.chapterTitle}`,
            rank: Number(h.rank.toFixed(4)),
            snippet: h.snippet,
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
  },
  { serverInfo: { name: "basic-law-mcp", version: "0.1.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
