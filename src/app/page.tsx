import { redirect } from "next/navigation";
import type { UIMessage } from "ai";
import { Chat } from "./chat";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

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

  const initialMessages = conversation.messages.map(
    (m) => ({ id: m.id, role: m.role, parts: m.parts as UIMessage["parts"] }) as UIMessage,
  );

  const [notes, chapters, articleCount, toolCallCount] = await Promise.all([
    prisma.note.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.chapter.findMany({ orderBy: { ordinal: "asc" }, select: { number: true, title: true } }),
    prisma.article.count(),
    prisma.toolCall.count({ where: { message: { conversationId: c } } }),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:flex-row">
      <section className="flex min-h-[70vh] flex-1 flex-col">
        <header className="mb-4">
          <h1 className="text-xl font-semibold tracking-tight">Basic Law Study Agent</h1>
          <p className="text-sm text-neutral-500">
            An agent that reads the Basic Law of the HKSAR through MCP tools, cites articles, and keeps your notes in
            PostgreSQL. Study aid only — not legal advice.
          </p>
        </header>
        <Chat conversationId={conversation.id} initialMessages={initialMessages} />
      </section>

      <aside className="w-full shrink-0 space-y-6 text-sm md:w-72">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="mb-2 font-medium">Corpus</h2>
          <p className="text-neutral-500">
            {articleCount} articles · 3 annexes · full-text search in PostgreSQL. Tool calls in this conversation:{" "}
            {toolCallCount}.
          </p>
          <ul className="mt-2 space-y-1 text-neutral-600 dark:text-neutral-400">
            {chapters.map((ch) => (
              <li key={ch.number}>
                <span className="font-mono text-xs">{ch.number}</span> {ch.title}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="mb-2 font-medium">Recent notes</h2>
          {notes.length === 0 ? (
            <p className="text-neutral-500">No notes yet. Ask the agent to “save a note …”.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="rounded bg-neutral-100 p-2 dark:bg-neutral-900">
                  {n.articleNumber ? <span className="mr-1 font-mono text-xs">art. {n.articleNumber}</span> : null}
                  {n.body}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="mb-2 font-medium">MCP endpoint</h2>
          <p className="text-neutral-500">
            The same tools are exposed at <code className="font-mono text-xs">/api/mcp</code> (Streamable HTTP) for
            Claude, Cursor or any MCP client.
          </p>
        </div>
      </aside>
    </main>
  );
}
