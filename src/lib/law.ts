import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

export type ArticleHit = {
  number: number;
  chapterNumber: string;
  chapterTitle: string;
  rank: number;
  snippet: string;
};

/** Full-text search over article text using PostgreSQL tsvector/tsquery (see migration article_fts_index). */
export async function searchArticles(query: string, limit = 5): Promise<ArticleHit[]> {
  const rows = await prisma.$queryRaw<ArticleHit[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           ts_rank_cd(to_tsvector('english', a."text"), q)::float8 AS "rank",
           ts_headline('english', a."text", q,
             'MaxFragments=2, MinWords=10, MaxWords=28, StartSel=**, StopSel=**') AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber",
         websearch_to_tsquery('english', ${query}) q
    WHERE to_tsvector('english', a."text") @@ q
    ORDER BY "rank" DESC, a."number" ASC
    LIMIT ${limit}
  `);
  return rows;
}

export async function getArticle(number: number) {
  return prisma.article.findUnique({
    where: { number },
    include: { chapter: true, section: true },
  });
}

export async function getArticleRange(from: number, to: number) {
  return prisma.article.findMany({
    where: { number: { gte: from, lte: to } },
    orderBy: { number: "asc" },
    include: { chapter: true, section: true },
  });
}

export async function listChapters() {
  const chapters = await prisma.chapter.findMany({
    orderBy: { ordinal: "asc" },
    include: {
      sections: { orderBy: { number: "asc" } },
      articles: { select: { number: true }, orderBy: { number: "asc" } },
    },
  });
  return chapters.map((c) => ({
    number: c.number,
    title: c.title,
    articles: c.articles.length
      ? { from: c.articles[0].number, to: c.articles[c.articles.length - 1].number }
      : null,
    sections: c.sections.map((s) => ({ number: s.number, title: s.title })),
  }));
}

export async function getAnnex(id: "I" | "II" | "III") {
  return prisma.annex.findUnique({ where: { id } });
}

/** Human-readable citation, e.g. "Basic Law, art. 24(2)". */
export function formatCitation(article: number, paragraph?: number | null) {
  return paragraph ? `Basic Law, art. ${article}(${paragraph})` : `Basic Law, art. ${article}`;
}
