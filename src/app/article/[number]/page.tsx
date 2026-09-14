import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCitation, getArticle } from "@/lib/law";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * A stable address for one article, so a citation can be shared, bookmarked or linked to from outside the chat —
 * the way every CLIC recommendation ends in a link to the paragraph it came from rather than to a search box.
 */
export default async function ArticlePage({ params }: { params: Promise<{ number: string }> }) {
  const n = Number((await params).number);
  if (!Number.isInteger(n) || n < 1 || n > 160) notFound();
  const article = await getArticle(n);
  if (!article) notFound();

  // The lay questions the study bank maps to this article: what a reader would have asked to get here.
  const questions = await prisma.question.findMany({
    where: { articles: { has: n } },
    select: { id: true, text: true },
    orderBy: { id: "asc" },
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 text-xs text-neutral-500">
        <Link href="/" className="underline-offset-2 hover:underline">
          Basic Law Study Agent
        </Link>
        <span>
          Chapter {article.chapter.number} · {article.chapter.title}
          {article.section ? ` · Section ${article.section.number} ${article.section.title}` : ""}
        </span>
      </div>

      <h1 className="mb-3 text-lg font-semibold tracking-tight">{formatCitation(article.number)}</h1>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{article.text}</p>

      {article.notes.length ? (
        <ul className="mt-4 space-y-1 border-t border-neutral-200 pt-3 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          {article.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}

      {questions.length ? (
        <section className="mt-6 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h2 className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Study questions that lead here
          </h2>
          <ul className="space-y-1 text-xs">
            {questions.map((q) => (
              <li key={q.id}>
                <span className="font-mono text-neutral-400">{q.id}</span> {q.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav className="mt-6 flex gap-3 border-t border-neutral-200 pt-3 text-xs dark:border-neutral-800">
        {n > 1 ? (
          <Link href={`/article/${n - 1}`} className="underline-offset-2 hover:underline">
            ‹ Article {n - 1}
          </Link>
        ) : null}
        {n < 160 ? (
          <Link href={`/article/${n + 1}`} className="ml-auto underline-offset-2 hover:underline">
            Article {n + 1} ›
          </Link>
        ) : null}
      </nav>

      <p className="mt-6 text-xs text-neutral-500">
        Study aid only — not legal advice. Text from the Government of the HKSAR&rsquo;s published Basic Law booklet.
      </p>
    </main>
  );
}
