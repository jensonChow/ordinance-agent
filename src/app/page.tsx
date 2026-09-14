import { redirect } from "next/navigation";
import type { UIMessage } from "ai";
import { Shell } from "./shell";
import { listChapters } from "@/lib/law";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Four plausible options for one quiz item: the bank's own answer plus three other articles it never lists. */
function options(answer: number, pool: number[]): number[] {
  const wrong = pool.filter((n) => n !== answer);
  const picked: number[] = [];
  for (let i = 0; i < wrong.length && picked.length < 3; i++) {
    const n = wrong[(i * 7 + answer) % wrong.length];
    if (!picked.includes(n)) picked.push(n);
  }
  return [...picked, answer].sort((a, b) => a - b);
}

export default async function Home({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;

  // One conversation per URL: create it server-side, then persist every turn through /api/chat.
  if (!c) {
    const conversation = await prisma.conversation.create({ data: {} });
    redirect(`/?c=${conversation.id}`);
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: c },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) redirect("/");

  const [chapters, notes, conversations, articleCount, questionCount, annexCount, toolCallCount, ratingCount, starters, quizRows] =
    await Promise.all([
      listChapters(),
      prisma.note.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
      prisma.conversation.findMany({
        where: { messages: { some: {} } },
        orderBy: { updatedAt: "desc" },
        take: 8,
        include: { _count: { select: { messages: true } }, messages: { where: { role: "user" }, orderBy: { createdAt: "asc" }, take: 1 } },
      }),
      prisma.article.count(),
      prisma.question.count(),
      prisma.annex.count(),
      prisma.toolCall.count({ where: { message: { conversationId: c } } }),
      prisma.rating.count(),
      prisma.$queryRaw<{ text: string }[]>(Prisma.sql`SELECT "text" FROM "Question" ORDER BY random() LIMIT 5`),
      prisma.$queryRaw<{ id: string; text: string; articles: number[] }[]>(
        Prisma.sql`SELECT "id", "text", "articles" FROM "Question" WHERE cardinality("articles") > 0 ORDER BY random() LIMIT 10`,
      ),
    ]);

  const firstUserText = (parts: unknown) => {
    const p = parts as { type: string; text?: string }[] | undefined;
    return p?.find((x) => x.type === "text")?.text ?? "";
  };

  const pool = [...new Set(quizRows.map((q) => q.articles[0]))];
  const quiz = quizRows.map((q) => ({ id: q.id, text: q.text, answer: q.articles[0], options: options(q.articles[0], pool) }));
  // An option is only answerable with a glimpse of what the article says, so each one carries its opening clause.
  const previewRows = await prisma.article.findMany({
    where: { number: { in: [...new Set(quiz.flatMap((q) => q.options))] } },
    select: { number: true, text: true },
  });
  const preview = new Map(
    previewRows.map((a) => {
      const clipped = a.text.replace(/\s+/g, " ").slice(0, 96);
      return [a.number, clipped.length < a.text.length ? `${clipped}…` : clipped];
    }),
  );

  return (
    <Shell
      conversationId={conversation.id}
      initialMessages={conversation.messages.map(
        (m) => ({ id: m.id, role: m.role, parts: m.parts as UIMessage["parts"] }) as UIMessage,
      )}
      chapters={chapters.map((ch) => ({
        number: ch.number,
        title: ch.title,
        from: ch.articles?.from ?? null,
        to: ch.articles?.to ?? null,
      }))}
      starters={starters.map((s) => s.text)}
      notes={notes.map((n) => ({ id: n.id, articleNumber: n.articleNumber, body: n.body }))}
      conversations={conversations.map((cv) => ({
        id: cv.id,
        label: firstUserText(cv.messages[0]?.parts),
        count: cv._count.messages,
      }))}
      counts={{
        articles: articleCount,
        questions: questionCount,
        annexes: annexCount,
        toolCalls: toolCallCount,
        ratings: ratingCount,
      }}
      quiz={quiz.map((q) => ({ ...q, options: q.options.map((n) => ({ n, preview: preview.get(n) ?? "" })) }))}
      denseOff={process.env.DENSE_RETRIEVAL === "off"}
    />
  );
}
