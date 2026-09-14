import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCitation, getArticle } from "@/lib/law";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const mono = { font: "400 10.5px/1.4 'Geist Mono', ui-monospace, monospace", letterSpacing: ".08em" } as const;

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
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "26px 26px 60px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <Link href="/" style={{ font: "600 19px/1.2 'Noto Serif SC', serif", letterSpacing: ".05em" }}>
          基本法研讀
        </Link>
        <span style={{ ...mono, color: "var(--ink4)" }}>
          {article.chapter.number} · {article.chapter.title}
          {article.section ? ` · Section ${article.section.number} ${article.section.title}` : ""}
        </span>
      </div>

      <div style={{ borderTop: "3px double var(--rule2)", paddingTop: 16 }}>
        <h1 style={{ font: "600 26px/1.3 'Noto Serif SC', serif", margin: "0 0 14px" }}>{formatCitation(article.number)}</h1>
        <p lang="en" style={{ font: "400 15px/2 'Noto Sans SC', sans-serif", whiteSpace: "pre-wrap", margin: 0 }}>
          {article.text}
        </p>
      </div>

      {article.notes.length ? (
        <ul
          style={{
            marginTop: 18,
            paddingTop: 12,
            borderTop: "1px solid var(--rule)",
            font: "400 12px/1.8 'Noto Sans SC', sans-serif",
            color: "var(--ink3)",
            paddingLeft: 18,
          }}
        >
          {article.notes.map((note, i) => (
            <li key={i} lang="en">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {questions.length ? (
        <section style={{ marginTop: 22, paddingTop: 12, borderTop: "1px solid var(--rule)" }}>
          <h2 style={{ font: "600 13px/1.3 'Noto Serif SC', serif", margin: "0 0 8px", letterSpacing: ".04em" }}>
            會導向這一條的學習題
          </h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, font: "400 12px/1.75 'Noto Sans SC', sans-serif" }}>
            {questions.map((q) => (
              <li key={q.id} lang="en">
                <span style={{ ...mono, color: "var(--ink4)", marginRight: 7 }}>{q.id}</span>
                {q.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav style={{ marginTop: 24, paddingTop: 12, borderTop: "1px solid var(--rule)", display: "flex", ...mono }}>
        {n > 1 ? <Link href={`/article/${n - 1}`}>‹ 第 {n - 1} 條</Link> : null}
        {n < 160 ? (
          <Link href={`/article/${n + 1}`} style={{ marginLeft: "auto" }}>
            第 {n + 1} 條 ›
          </Link>
        ) : null}
      </nav>

      <p style={{ marginTop: 26, font: "400 11px/1.7 'Noto Sans SC', sans-serif", color: "var(--ink4)" }}>
        學習輔助，不是法律意見。條文正文取自香港特區政府出版的《基本法》英文小冊子。
      </p>
    </main>
  );
}
