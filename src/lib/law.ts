import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

export type ArticleHit = {
  number: number;
  chapterNumber: string;
  chapterTitle: string;
  rank: number;
  snippet: string;
  /** "strict" = every query term matched (websearch syntax); "loose" = any term matched, ranked by density. */
  mode: "strict" | "loose";
};


/**
 * Words that appear in almost every article ("Basic Law", "Hong Kong", "Region", "government", "law" …) carry no
 * signal for loose matching and let short generic articles outrank the relevant one, so loose queries drop them.
 * Strict (websearch) queries are left exactly as the caller wrote them.
 */
const DOMAIN_STOP_PHRASES = [
  "hong kong special administrative region", "special administrative region", "people's republic of china", "people’s republic of china",
  "basic law", "hong kong", "hksar", "the region", "region", "government", "governments", "laws", "law", "legal",
  "article", "articles", "provision", "provisions", "does", "say", "says", "mention", "what", "which", "who", "how", "can", "may", "must",
];
export function stripDomainStopwords(query: string): string {
  let q = ` ${query.toLowerCase().replace(/[’']s\b/g, "").replace(/[?!.,;:"()]/g, " ")} `;
  for (const phrase of DOMAIN_STOP_PHRASES) q = q.split(` ${phrase} `).join(" ");
  q = q.replace(/\s+/g, " ").trim();
  return q || query;
}

const HEADLINE = "MaxFragments=2, MinWords=10, MaxWords=28, StartSel=**, StopSel=**";

/**
 * Strict full-text search: PostgreSQL websearch syntax (all terms must match; quotes, OR and -exclusions allowed).
 * Backed by the GIN index from migration article_fts_index.
 */
export async function searchArticles(query: string, limit = 5): Promise<ArticleHit[]> {
  const rows = await prisma.$queryRaw<Omit<ArticleHit, "mode">[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           ts_rank_cd(to_tsvector('english', a."text"), q)::float8 AS "rank",
           ts_headline('english', a."text", q, ${HEADLINE}) AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber",
         websearch_to_tsquery('english', ${query}) q
    WHERE to_tsvector('english', a."text") @@ q
    ORDER BY "rank" DESC, a."number" ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ ...r, mode: "strict" }));
}

/**
 * Loose full-text search: the same lexemes OR-ed together, so a lay question that shares only a few words with the
 * article still ranks. Built by rewriting plainto_tsquery's AND-chain into an OR-chain inside PostgreSQL, over
 * Article.searchText (boilerplate phrases removed; index from migration article_search_text).
 */
export async function searchArticlesLoose(query: string, limit = 5): Promise<ArticleHit[]> {
  const loose = stripDomainStopwords(query);
  const rows = await prisma.$queryRaw<Omit<ArticleHit, "mode">[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           ts_rank_cd(to_tsvector('english', a."searchText"), q)::float8 AS "rank",
           ts_headline('english', a."text", q, ${HEADLINE}) AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber",
         to_tsquery('english', regexp_replace(plainto_tsquery('english', ${loose})::text, '&', '|', 'g')) q
    WHERE to_tsvector('english', a."searchText") @@ q
    ORDER BY "rank" DESC, a."number" ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ ...r, mode: "loose" }));
}

/** Strict hits first, then loose hits to fill up to `limit` (deduplicated). This is what the MCP tool exposes. */
export async function searchArticlesSmart(query: string, limit = 5): Promise<ArticleHit[]> {
  const strict = await searchArticles(query, limit);
  if (strict.length >= limit) return strict;
  const seen = new Set(strict.map((h) => h.number));
  const loose = (await searchArticlesLoose(query, limit + strict.length)).filter((h) => !seen.has(h.number));
  return [...strict, ...loose].slice(0, limit);
}

export type QuestionHit = { id: string; text: string; articles: number[]; tags: string[]; rank: number };

/**
 * Search the study question bank (lay-language questions mapped to articles). Loose OR-matching over the question
 * text and tags, so a paraphrase still finds its canonical question. Backed by the GIN index from migration question_bank.
 */
export async function searchQuestions(query: string, limit = 3): Promise<QuestionHit[]> {
  const loose = stripDomainStopwords(query);
  return prisma.$queryRaw<QuestionHit[]>(Prisma.sql`
    SELECT q."id", q."text", q."articles", q."tags",
           ts_rank_cd(to_tsvector('english', q."searchText"), tq)::float8 AS "rank"
    FROM "Question" q,
         to_tsquery('english', regexp_replace(plainto_tsquery('english', ${loose})::text, '&', '|', 'g')) tq
    WHERE to_tsvector('english', q."searchText") @@ tq
    ORDER BY "rank" DESC, q."id" ASC
    LIMIT ${limit}
  `);
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
