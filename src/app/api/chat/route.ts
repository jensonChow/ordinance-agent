import { createMCPClient } from "@ai-sdk/mcp";
import { convertToModelMessages, isStepCount, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai";
import { callCitationService } from "@/lib/citation-service";
import { formatCitation } from "@/lib/law";
import { parseCitations, type ParsedCitation } from "@/lib/text";
import { prisma } from "@/lib/prisma";
import { citedArticles, toolTraces } from "@/lib/trace";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `You are a study assistant for the Basic Law of the Hong Kong Special Administrative Region.
Rules:
- Before answering any question about the Basic Law, look the text up with the tools — never answer from memory. For questions in everyday language, call find_questions first (it maps lay questions to articles), then search_articles if needed, then get_article to read the full text before quoting.
- Quote the relevant wording and cite it as "Article N" (or "Article N(paragraph)"). Mention footnotes when an article carries an NPCSC interpretation note.
- If a question is outside the Basic Law, say so and do not speculate. You are a study aid, not a lawyer; this is not legal advice.
- When the user asks you to remember something, use save_note. Keep answers concise and structured.`;

function mcpUrl(req: Request) {
  return process.env.MCP_SERVER_URL || `${new URL(req.url).origin}/api/mcp`;
}

export async function POST(req: Request) {
  const { messages, conversationId } = (await req.json()) as { messages: UIMessage[]; conversationId?: string };
  const { model, info } = await getModel();

  // Tools come from two places: the Basic Law MCP server (remote, discovered at runtime) …
  const mcp = await createMCPClient({ transport: { type: "http", url: mcpUrl(req) } });
  const mcpTools = await mcp.tools();

  // … and local tools backed by Prisma / PostgreSQL.
  const localTools = {
    save_note: tool({
      description: "Save a study note for the user (optionally attached to an article number).",
      inputSchema: z.object({
        body: z.string().min(1).max(2000),
        article: z.number().int().min(1).max(160).optional(),
      }),
      execute: async ({ body, article }) => {
        const note = await prisma.note.create({
          data: { body, articleNumber: article ?? null, conversationId: conversationId ?? null },
        });
        return { saved: true, id: note.id, article: article ?? null };
      },
    }),
    list_notes: tool({
      description: "List the user's most recent study notes.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ limit }) => {
        const notes = await prisma.note.findMany({ orderBy: { createdAt: "desc" }, take: limit });
        return { notes: notes.map((n) => ({ id: n.id, article: n.articleNumber, body: n.body, at: n.createdAt })) };
      },
    }),
    format_citation: tool({
      description: "Format a citation string for an article and optional paragraph number.",
      inputSchema: z.object({ article: z.number().int().min(1).max(160), paragraph: z.number().int().min(1).optional() }),
      execute: async ({ article, paragraph }) => {
        // Optional Python (Flask + Gunicorn) service; falls back to the local formatter when it is not there.
        const remote = await callCitationService<{ citation: string }>("/cite", { article, paragraph });
        return remote
          ? { ...remote, source: "python-service" as const }
          : { citation: formatCitation(article, paragraph), source: "local" as const };
      },
    }),
    parse_citations: tool({
      description:
        "Extract Basic Law citations from a passage the user pasted (essay, judgment, notes), e.g. 'BL art 24(2), Articles 39 and 41, Articles 45 to 47'. Returns the article numbers so you can read them with get_article.",
      inputSchema: z.object({ text: z.string().min(2).max(20000).describe("Free text that may contain citations") }),
      execute: async ({ text }) => {
        const remote = await callCitationService<{ citations: ParsedCitation[]; count: number }>("/parse", { text });
        if (remote) return { ...remote, source: "python-service" as const };
        const citations = parseCitations(text);
        return { citations, count: citations.length, source: "local" as const };
      },
    }),
  };

  // Persist the incoming user message (id comes from the client so retries are idempotent).
  const last = messages.at(-1);
  if (conversationId && last?.role === "user") {
    await prisma.message.upsert({
      where: { id: last.id },
      create: { id: last.id, conversationId, role: "user", parts: last.parts as object[] },
      update: {},
    });
  }

  const result = streamText({
    model,
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools: { ...mcpTools, ...localTools },
    stopWhen: isStepCount(8),
    onFinish: async () => {
      await mcp.close();
    },
    onError: async () => {
      await mcp.close();
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // Give the assistant message a server-side id so the persisted row, tool calls and citations line up with the UI.
    generateMessageId: () => `a_${crypto.randomUUID()}`,
    messageMetadata: () => ({ provider: info.provider, model: info.model }),
    onFinish: async ({ responseMessage, isAborted }) => {
      if (!conversationId || isAborted) return;
      const messageId = responseMessage.id || `a_${crypto.randomUUID()}`;
      const traces = toolTraces(responseMessage);
      const cited = citedArticles(traces);
      await prisma.$transaction(async (tx) => {
        await tx.message.upsert({
          where: { id: messageId },
          create: { id: messageId, conversationId, role: "assistant", parts: responseMessage.parts as object[] },
          update: { parts: responseMessage.parts as object[] },
        });
        await tx.toolCall.deleteMany({ where: { messageId } });
        if (traces.length) {
          await tx.toolCall.createMany({
            data: traces.map((t) => ({
              messageId,
              toolName: t.toolName,
              source: t.source,
              input: (t.input ?? {}) as object,
              output: (t.output ?? undefined) as object | undefined,
            })),
          });
        }
        if (cited.length) {
          await tx.citation.createMany({
            data: cited.map((n) => ({ messageId, articleNumber: n })),
            skipDuplicates: true,
          });
        }
        await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      });
    },
  });
}
