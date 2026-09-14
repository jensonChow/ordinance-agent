/**
 * Write sentence embeddings for the corpus into PostgreSQL.
 *
 *   npm run embed
 *
 * Embeds the 160 articles (full text) and the 80 canonical study questions. The held-out paraphrases in
 * `variants` are never embedded — they are the evaluation queries, and indexing them would leak the test set.
 *
 * Idempotent: re-running overwrites the vectors. Takes well under a minute on a laptop; the model itself is
 * downloaded once and cached by @huggingface/transformers.
 */
import "dotenv/config";
import { embed, EMBEDDING_DIMS, EMBEDDING_MODEL } from "../src/lib/embeddings";
import { prisma } from "../src/lib/prisma";

const BATCH = 32;

async function embedAll(rows: { key: string | number; text: string }[]) {
  const vectors: number[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const batch = await embed(slice.map((r) => r.text));
    if (!batch) throw new Error("embedding model unavailable — cannot build the index (is DENSE_RETRIEVAL=off?)");
    for (const v of batch) {
      if (v.length !== EMBEDDING_DIMS) throw new Error(`expected ${EMBEDDING_DIMS} dims, got ${v.length}`);
      vectors.push(v);
    }
    process.stdout.write(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  return vectors;
}

async function main() {
  console.log(`model: ${EMBEDDING_MODEL} (${EMBEDDING_DIMS} dims)`);

  const articles = await prisma.article.findMany({ select: { number: true, text: true }, orderBy: { number: "asc" } });
  console.log(`articles: ${articles.length}`);
  const articleVectors = await embedAll(articles.map((a) => ({ key: a.number, text: a.text })));
  await prisma.$transaction(
    articles.map((a, i) => prisma.article.update({ where: { number: a.number }, data: { embedding: articleVectors[i] } })),
  );
  console.log(`articles embedded: ${articles.length}`);

  // Canonical question text only. `variants` is the held-out evaluation set and must stay out of the index.
  const questions = await prisma.question.findMany({ select: { id: true, text: true }, orderBy: { id: "asc" } });
  console.log(`questions: ${questions.length}`);
  const questionVectors = await embedAll(questions.map((q) => ({ key: q.id, text: q.text })));
  await prisma.$transaction(
    questions.map((q, i) => prisma.question.update({ where: { id: q.id }, data: { embedding: questionVectors[i] } })),
  );
  console.log(`questions embedded: ${questions.length}`);

  const [{ articles: withArticle, questions: withQuestion }] = await prisma.$queryRawUnsafe<
    { articles: bigint; questions: bigint }[]
  >(`SELECT (SELECT count(*) FROM "Article" WHERE cardinality(embedding) = ${EMBEDDING_DIMS}) AS articles,
            (SELECT count(*) FROM "Question" WHERE cardinality(embedding) = ${EMBEDDING_DIMS}) AS questions`);
  console.log(`stored: ${withArticle} articles, ${withQuestion} questions with ${EMBEDDING_DIMS}-dim vectors`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
