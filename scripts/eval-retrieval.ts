/**
 * Retrieval evaluation for the Basic Law corpus.
 * Queries = the paraphrases in data/question-bank.json (never the canonical questions themselves).
 * Split: variant 1 of each question = "dev" (used to tune tags / stop-words), variant 2 = "test" (never looked at while tuning).
 * Target = the first article listed for the question ("primary"); "any" = any listed article.
 * Strategies: strict FTS, loose FTS, smart (strict then loose), bank (question bank → articles), bank+smart.
 * Run: npm run eval:retrieval   (needs DATABASE_URL and a seeded database)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { searchArticles, searchArticlesLoose, searchArticlesSmart, searchQuestions } from "../src/lib/law";
import { prisma } from "../src/lib/prisma";

type Q = { id: string; question: string; variants: string[]; articles: number[] };
const bank: { questions: Q[] } = JSON.parse(readFileSync(resolve(__dirname, "../data/question-bank.json"), "utf8"));
const K = [1, 3, 5] as const;

type Strategy = (query: string) => Promise<number[]>;
const dedupe = (xs: number[]) => [...new Set(xs)];
const strategies: Record<string, Strategy> = {
  "strict FTS": async (q) => (await searchArticles(q, 5)).map((h) => h.number),
  "loose FTS": async (q) => (await searchArticlesLoose(q, 5)).map((h) => h.number),
  "smart FTS (strict→loose)": async (q) => (await searchArticlesSmart(q, 5)).map((h) => h.number),
  "question bank": async (q) => dedupe((await searchQuestions(q, 3)).flatMap((h) => h.articles)).slice(0, 5),
  "question bank → smart FTS": async (q) => {
    const fromBank = dedupe((await searchQuestions(q, 3)).flatMap((h) => h.articles));
    const fromFts = (await searchArticlesSmart(q, 5)).map((h) => h.number);
    return dedupe([...fromBank, ...fromFts]).slice(0, 5);
  },
};

async function main() {
  const cases = bank.questions.flatMap((q) =>
    q.variants.map((v, i) => ({ id: q.id, split: i === 0 ? "dev" : "test", query: v, primary: q.articles[0], any: q.articles })),
  );
  const results: Record<string, Record<string, Record<string, number>>> = {};
  const misses: Record<string, { id: string; split: string; query: string; primary: number; got: number[] }[]> = {};
  for (const [name, run] of Object.entries(strategies)) {
    const got = new Map<string, number[]>();
    for (const c of cases) got.set(c.query, await run(c.query));
    results[name] = {};
    misses[name] = [];
    for (const split of ["dev", "test", "all"]) {
      const subset = cases.filter((c) => split === "all" || c.split === split);
      const r: Record<string, number> = {};
      for (const k of K) {
        r[`primary@${k}`] = subset.filter((c) => got.get(c.query)!.slice(0, k).includes(c.primary)).length / subset.length;
        r[`any@${k}`] = subset.filter((c) => got.get(c.query)!.slice(0, k).some((n) => c.any.includes(n))).length / subset.length;
      }
      results[name][split] = r;
    }
    for (const c of cases) {
      const g = got.get(c.query)!;
      if (!g.slice(0, 5).includes(c.primary)) misses[name].push({ id: c.id, split: c.split, query: c.query, primary: c.primary, got: g.slice(0, 5) });
    }
  }
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const table = (split: string) => {
    const header = `| strategy (${split}, n=${cases.filter((c) => split === "all" || c.split === split).length}) | primary@1 | primary@3 | primary@5 | any@1 | any@3 | any@5 |\n|---|---|---|---|---|---|---|`;
    const rows = Object.entries(results).map(([n, r]) => {
      const s = r[split];
      return `| ${n} | ${pct(s["primary@1"])} | ${pct(s["primary@3"])} | ${pct(s["primary@5"])} | ${pct(s["any@1"])} | ${pct(s["any@3"])} | ${pct(s["any@5"])} |`;
    });
    return `${header}\n${rows.join("\n")}`;
  };
  const md = `# Retrieval evaluation\n\nDate: ${new Date().toISOString().slice(0, 10)} · corpus: 160 articles · ${bank.questions.length} study questions, each with two paraphrases: paraphrase 1 = **dev** (used to tune tags and stop-words), paraphrase 2 = **test** (never inspected while tuning). The canonical questions themselves are never used as queries.\n\n"primary" = the first article listed for the question is in the top-k; "any" = any listed article is.\n\n## test\n\n${table("test")}\n\n## dev\n\n${table("dev")}\n\n## all\n\n${table("all")}\n`;
  mkdirSync(resolve(__dirname, "../eval"), { recursive: true });
  writeFileSync(resolve(__dirname, "../eval/RESULTS.md"), md);
  writeFileSync(resolve(__dirname, "../eval/retrieval-results.json"), JSON.stringify({ cases: cases.length, results, misses }, null, 2));
  console.log(md);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
