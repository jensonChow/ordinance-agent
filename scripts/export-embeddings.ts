/**
 * Export the vector index so a deployment can load it without a Postgres connection from here.
 *
 *   npm run embed && npm run embed:export        # writes data/embeddings.json
 *
 * Why a file. The hosted database is reachable from this machine only over HTTPS — a raw PostgreSQL connection
 * opens and then hangs — so `npm run embed` cannot be pointed at production. The corpus itself was loaded the same
 * way: the repository is public, so the database fetches `data/*.json` from GitHub with the `http` extension and
 * writes the rows itself. Nothing has to pass through a laptop, and what production is running stays inspectable in
 * the repository instead of living only in a database.
 *
 * The file carries the model and precision that produced the vectors, and a digest of the exact corpus text they
 * were computed from. The loader recomputes that digest in SQL and refuses the file if it disagrees — otherwise a
 * corpus edit would leave production scoring queries against vectors of the previous wording, silently.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBEDDING_DIMS, EMBEDDING_DTYPE, EMBEDDING_MODEL } from "../src/lib/embeddings";
import { prisma } from "../src/lib/prisma";

/** Must match the SQL in deploy/supabase/load-embeddings.sql exactly: id, newline, text; rows joined by a blank line. */
function digest(rows: { key: string; text: string }[]) {
  const joined = rows.map((r) => `${r.key}\n${r.text}`).join("\n\n");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

async function main() {
  const articles = await prisma.article.findMany({
    select: { number: true, text: true, embedding: true },
    orderBy: { number: "asc" },
  });
  const questions = await prisma.question.findMany({
    select: { id: true, text: true, embedding: true },
    orderBy: { id: "asc" },
  });

  const missing = [
    ...articles.filter((a) => a.embedding.length !== EMBEDDING_DIMS).map((a) => `article ${a.number}`),
    ...questions.filter((q) => q.embedding.length !== EMBEDDING_DIMS).map((q) => `question ${q.id}`),
  ];
  if (missing.length) throw new Error(`${missing.length} rows have no ${EMBEDDING_DIMS}-dim vector — run npm run embed first`);

  const payload = {
    model: EMBEDDING_MODEL,
    dtype: EMBEDDING_DTYPE,
    dims: EMBEDDING_DIMS,
    builtAt: new Date().toISOString().slice(0, 10),
    articleDigest: digest(articles.map((a) => ({ key: String(a.number), text: a.text }))),
    questionDigest: digest(questions.map((q) => ({ key: q.id, text: q.text }))),
    articles: Object.fromEntries(articles.map((a) => [a.number, a.embedding])),
    questions: Object.fromEntries(questions.map((q) => [q.id, q.embedding])),
  };

  const path = resolve(__dirname, "../data/embeddings.json");
  writeFileSync(path, JSON.stringify(payload));
  const bytes = JSON.stringify(payload).length;
  console.log(`wrote data/embeddings.json — ${articles.length} articles, ${questions.length} questions, ${(bytes / 1e6).toFixed(2)} MB`);
  console.log(`model: ${payload.model} ${payload.dtype} (${payload.dims} dims)`);
  console.log(`article digest:  ${payload.articleDigest}`);
  console.log(`question digest: ${payload.questionDigest}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
