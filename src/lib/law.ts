import { prisma } from "@/lib/prisma";
import { embedOne, EMBEDDING_DIMS } from "@/lib/embeddings";
import { stripDomainStopwords } from "@/lib/text";
export { formatCitation, stripDomainStopwords } from "@/lib/text";
import { Prisma } from "@/generated/prisma/client";

export type ArticleHit = {
  number: number;
  chapterNumber: string;
  chapterTitle: string;
  rank: number;
  snippet: string;
  /**
   * How the hit was found: "strict" = every query term matched (websearch syntax); "loose" = any term matched,
   * ranked by density; "dense" = nearest neighbour by sentence embedding; "hybrid" = fused from several lists.
   */
  mode: "strict" | "loose" | "dense" | "hybrid";
  /** For hybrid hits: which retrieval paths returned this article, in a fixed order. */
  sources?: RetrievalSource[];
  /**
   * For hybrid hits: the study-bank questions that map to this article. The AI CLIC Recommender presents its
   * results *as* these "model questions" rather than as raw documents; surfacing them here lets a reader see the
   * lay question the retrieval actually matched, not just the article it landed on.
   */
  viaQuestions?: { id: string; text: string }[];
};

/** The retrieval paths the hybrid search fuses; surfaced per hit so an answer's citations stay auditable. */
export type RetrievalSource = "question bank" | "full-text" | "semantic";

const HEADLINE = "MaxFragments=2, MinWords=10, MaxWords=28, StartSel=**, StopSel=**";

/**
 * Restrict a search to the chapters a reader has ticked. Empty or undefined means no restriction, so every
 * caller can pass the selection straight through without branching.
 */
function chapterFilter(chapters?: string[]) {
  return chapters?.length ? Prisma.sql`AND a."chapterNumber" = ANY(${chapters}::text[])` : Prisma.empty;
}

/**
 * Strict full-text search: PostgreSQL websearch syntax (all terms must match; quotes, OR and -exclusions allowed).
 * Backed by the GIN index from migration article_fts_index.
 */
export async function searchArticles(query: string, limit = 5, chapters?: string[]): Promise<ArticleHit[]> {
  const only = chapterFilter(chapters);
  const rows = await prisma.$queryRaw<Omit<ArticleHit, "mode">[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           ts_rank_cd(to_tsvector('english', a."text"), q)::float8 AS "rank",
           ts_headline('english', a."text", q, ${HEADLINE}) AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber",
         websearch_to_tsquery('english', ${query}) q
    WHERE to_tsvector('english', a."text") @@ q ${only}
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
export async function searchArticlesLoose(query: string, limit = 5, chapters?: string[]): Promise<ArticleHit[]> {
  const loose = stripDomainStopwords(query);
  const only = chapterFilter(chapters);
  const rows = await prisma.$queryRaw<Omit<ArticleHit, "mode">[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           ts_rank_cd(to_tsvector('english', a."searchText"), q)::float8 AS "rank",
           ts_headline('english', a."text", q, ${HEADLINE}) AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber",
         to_tsquery('english', regexp_replace(plainto_tsquery('english', ${loose})::text, '&', '|', 'g')) q
    WHERE to_tsvector('english', a."searchText") @@ q ${only}
    ORDER BY "rank" DESC, a."number" ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ ...r, mode: "loose" }));
}

/** Strict hits first, then loose hits to fill up to `limit` (deduplicated). This is what the MCP tool exposes. */
export async function searchArticlesSmart(query: string, limit = 5, chapters?: string[]): Promise<ArticleHit[]> {
  const strict = await searchArticles(query, limit, chapters);
  if (strict.length >= limit) return strict;
  const seen = new Set(strict.map((h) => h.number));
  const loose = (await searchArticlesLoose(query, limit + strict.length, chapters)).filter((h) => !seen.has(h.number));
  return [...strict, ...loose].slice(0, limit);
}

/**
 * Dense retrieval: nearest articles to the query by sentence embedding (dot product of L2-normalised vectors =
 * cosine). Answers the failure lexical search cannot: "customs duty" against an article that says "tariff".
 *
 * Returns [] when the corpus has not been embedded (`npm run embed`) or the model is unavailable, so every
 * caller degrades to lexical retrieval instead of erroring.
 */
export async function searchArticlesDense(
  query: string,
  limit = 5,
  precomputed?: number[] | null,
  chapters?: string[],
): Promise<ArticleHit[]> {
  const vector = precomputed !== undefined ? precomputed : await embedOne(query);
  if (!vector) return [];
  const only = chapterFilter(chapters);
  const literal = `{${vector.join(",")}}`;
  const rows = await prisma.$queryRaw<Omit<ArticleHit, "mode">[]>(Prisma.sql`
    SELECT a."number",
           a."chapterNumber",
           c."title" AS "chapterTitle",
           (SELECT sum(x * y) FROM unnest(a."embedding", ${literal}::float8[]) AS t(x, y))::float8 AS "rank",
           left(a."text", 240) AS "snippet"
    FROM "Article" a
    JOIN "Chapter" c ON c."number" = a."chapterNumber"
    WHERE cardinality(a."embedding") = ${EMBEDDING_DIMS} ${only}
    ORDER BY "rank" DESC, a."number" ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ ...r, mode: "dense" as const }));
}

/** The same nearest-neighbour lookup over the study question bank (canonical questions only). */
export async function searchQuestionsDense(query: string, limit = 3, precomputed?: number[] | null): Promise<QuestionHit[]> {
  const vector = precomputed !== undefined ? precomputed : await embedOne(query);
  if (!vector) return [];
  const literal = `{${vector.join(",")}}`;
  return prisma.$queryRaw<QuestionHit[]>(Prisma.sql`
    SELECT q."id", q."text", q."articles", q."tags",
           (SELECT sum(x * y) FROM unnest(q."embedding", ${literal}::float8[]) AS t(x, y))::float8 AS "rank"
    FROM "Question" q
    WHERE cardinality(q."embedding") = ${EMBEDDING_DIMS}
    ORDER BY "rank" DESC, q."id" ASC
    LIMIT ${limit}
  `);
}

/** Reciprocal rank fusion: an article's score is the sum of 1/(K + its rank) over the lists that returned it. */
const RRF_K = 60;
function fuse(lists: { source: RetrievalSource; articles: number[] }[], limit: number) {
  const score = new Map<number, number>();
  const sources = new Map<number, Set<RetrievalSource>>();
  for (const { source, articles } of lists) {
    articles.forEach((n, i) => {
      score.set(n, (score.get(n) ?? 0) + 1 / (RRF_K + i + 1));
      (sources.get(n) ?? sources.set(n, new Set()).get(n)!).add(source);
    });
  }
  const ORDER: RetrievalSource[] = ["question bank", "full-text", "semantic"];
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([n]) => ({ number: n, sources: ORDER.filter((s) => sources.get(n)!.has(s)) }));
}

/** Which retrieval paths were actually available for one search — see searchArticlesHybridReported. */
export type RetrievalPaths = { questionBank: boolean; fullText: boolean; dense: boolean };

/**
 * The retrieval the agent actually uses: the question bank (lexical and dense), full-text search and dense
 * article search, fused by reciprocal rank. Each component degrades to [] on its own, so the fusion still works
 * when the embedding model is missing — it is then exactly the previous bank + full-text behaviour.
 *
 * The degradation is the reason this returns the paths as well as the hits. "No `vec` among the results" has two
 * very different causes — the dense path ran and lost, or the dense path never ran — and a tool whose answer is
 * cited in legal study should not leave the caller to guess which. `found_by` on a hit says who found it; this
 * says who was even asked.
 */
export async function searchArticlesHybridReported(
  query: string,
  limit = 5,
  chapters?: string[],
): Promise<{ hits: ArticleHit[]; paths: RetrievalPaths }> {
  const vector = await embedOne(query); // embed once; both dense lookups reuse it
  // The question bank is not chapter-scoped, so a reader's topic selection is applied to the articles it maps to
  // rather than to the SQL; the article-level paths take the same selection as a WHERE clause.
  const allowed = chapters?.length
    ? new Set(
        (await prisma.article.findMany({ where: { chapterNumber: { in: chapters } }, select: { number: true } })).map(
          (a) => a.number,
        ),
      )
    : null;
  const keep = (numbers: number[]) => (allowed ? numbers.filter((n) => allowed.has(n)) : numbers);
  const [bankLexical, bankDense, fts, dense] = await Promise.all([
    searchQuestions(query, 3),
    searchQuestionsDense(query, 3, vector),
    searchArticlesSmart(query, limit, chapters),
    searchArticlesDense(query, limit, vector, chapters),
  ]);
  // Which lay question sent us to which article — what the reader is shown as the matched "model question".
  const viaQuestions = new Map<number, { id: string; text: string }[]>();
  for (const q of [...bankLexical, ...bankDense]) {
    for (const n of keep(q.articles)) {
      const list = viaQuestions.get(n) ?? [];
      if (!list.some((x) => x.id === q.id)) list.push({ id: q.id, text: q.text });
      viaQuestions.set(n, list);
    }
  }
  const ranked = fuse(
    [
      { source: "question bank", articles: keep([...new Set(bankLexical.flatMap((h) => h.articles))]) },
      { source: "question bank", articles: keep([...new Set(bankDense.flatMap((h) => h.articles))]) },
      { source: "full-text", articles: fts.map((h) => h.number) },
      { source: "semantic", articles: dense.map((h) => h.number) },
    ],
    limit,
  );
  const order = ranked.map((r) => r.number);
  const sourcesByArticle = new Map(ranked.map((r) => [r.number, r.sources]));
  // Reuse the richest description we already have for each article (a full-text snippet beats a leading slice).
  const known = new Map<number, ArticleHit>();
  for (const h of [...dense, ...fts]) known.set(h.number, h);
  const missing = order.filter((n) => !known.has(n));
  if (missing.length) {
    const rows = await prisma.article.findMany({
      where: { number: { in: missing } },
      select: { number: true, chapterNumber: true, text: true, chapter: { select: { title: true } } },
    });
    for (const r of rows) {
      known.set(r.number, {
        number: r.number,
        chapterNumber: r.chapterNumber,
        chapterTitle: r.chapter.title,
        rank: 0,
        snippet: r.text.slice(0, 240),
        mode: "hybrid",
      });
    }
  }
  const hits = order.flatMap((n) => {
    const hit = known.get(n);
    if (!hit) return [];
    const via = viaQuestions.get(n);
    return [{ ...hit, mode: "hybrid" as const, sources: sourcesByArticle.get(n) ?? [], ...(via?.length ? { viaQuestions: via } : {}) }];
  });
  return { hits, paths: { questionBank: true, fullText: true, dense: vector !== null } };
}

/** Hits only, for callers that do not report on the retrieval itself (the evaluation, the tests). */
export async function searchArticlesHybrid(query: string, limit = 5, chapters?: string[]): Promise<ArticleHit[]> {
  return (await searchArticlesHybridReported(query, limit, chapters)).hits;
}

export type TopicSuggestion = { chapter: string; title: string; score: number; articles: number[] };

/**
 * Rank the chapters a scenario is likely to sit in, so the reader can confirm or correct the topic before the
 * agent searches. This is the step the AI CLIC Recommender puts between "describe your situation" and its
 * results, and it is worth keeping: it lets a lay reader steer retrieval without knowing any legal vocabulary.
 *
 * The ranking is derived from the retrieval that would run anyway — a wider hybrid search, grouped by chapter and
 * scored by reciprocal rank — rather than from a separate classifier, so it can never disagree with the search
 * results the reader is about to see.
 */
export async function suggestTopics(query: string, limit = 3): Promise<TopicSuggestion[]> {
  const hits = await searchArticlesHybrid(query, 12);
  const byChapter = new Map<string, { title: string; score: number; articles: number[] }>();
  hits.forEach((h, i) => {
    const entry = byChapter.get(h.chapterNumber) ?? { title: h.chapterTitle, score: 0, articles: [] };
    entry.score += 1 / (i + 1);
    entry.articles.push(h.number);
    byChapter.set(h.chapterNumber, entry);
  });
  return [...byChapter.entries()]
    .map(([chapter, v]) => ({ chapter, title: v.title, score: Number(v.score.toFixed(4)), articles: v.articles }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

/** The whole study question bank (lay question → articles), for the MCP resource and the starter prompts. */
export async function listQuestions() {
  return prisma.question.findMany({
    orderBy: { id: "asc" },
    select: { id: true, text: true, articles: true, tags: true },
  });
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
