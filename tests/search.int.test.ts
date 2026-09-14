/* Integration tests against a seeded PostgreSQL (DATABASE_URL). Skipped when the database is not configured. */
import "dotenv/config";
import { describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("search over the seeded corpus", () => {
  it("strict search finds Article 24 for the legal wording", async () => {
    const { searchArticles } = await import("@/lib/law");
    const hits = await searchArticles("permanent resident seven years", 3);
    expect(hits[0]?.number).toBe(24);
    expect(hits[0]?.mode).toBe("strict");
  });

  it("smart search falls back to loose hits when strict search finds nothing, and the bank covers what density ranking misses", async () => {
    const { searchArticles, searchArticlesSmart, searchQuestions } = await import("@/lib/law");
    const q = "Can I be arrested without a lawful reason?";
    expect((await searchArticles(q, 5)).length).toBe(0);
    const smart = await searchArticlesSmart(q, 5);
    expect(smart.length).toBeGreaterThan(0);
    expect(smart.every((h) => h.mode === "loose")).toBe(true);
    // "unlawful arrest" stems differently from "lawful reason", so Article 28 is not in the loose top-5 — the question bank is what finds it.
    expect((await searchQuestions(q, 1))[0]?.articles).toContain(28);
  });

  it("the question bank maps an everyday question to its article", async () => {
    const { searchQuestions } = await import("@/lib/law");
    const hits = await searchQuestions("Do I pay customs duty on goods brought into Hong Kong?", 2);
    expect(hits[0]?.articles).toContain(114);
  });
});

/* Dense + hybrid retrieval. Skipped when the corpus has not been embedded (`npm run embed`). */
describe.skipIf(!hasDb)("hybrid retrieval", () => {
  it("finds the article whose wording shares no term with the question", async () => {
    const { searchArticles, searchArticlesDense, searchArticlesHybrid } = await import("@/lib/law");
    const q = "Do I pay customs duty on goods I bring into Hong Kong?";
    // The article says "free port" and "tariff", never "customs duty": strict full-text search returns nothing.
    expect((await searchArticles(q, 5)).length).toBe(0);
    const dense = await searchArticlesDense(q, 5);
    if (dense.length === 0) return; // corpus not embedded in this environment
    const hybrid = await searchArticlesHybrid(q, 5);
    expect(hybrid.map((h) => h.number)).toContain(114);
  });

  it("reports which retrieval paths found each hit", async () => {
    const { searchArticlesDense, searchArticlesHybrid } = await import("@/lib/law");
    const q = "Are foreigners bound by Hong Kong laws?";
    if ((await searchArticlesDense(q, 1)).length === 0) return;
    const hits = await searchArticlesHybrid(q, 5);
    expect(hits.map((h) => h.number)).toContain(42);
    const sources = new Set(hits.flatMap((h) => h.sources ?? []));
    expect(sources.size).toBeGreaterThan(0);
    for (const s of sources) expect(["question bank", "full-text", "semantic"]).toContain(s);
  });
});

/* Topic narrowing: the chapters a reader ticks must actually constrain retrieval, not just the prompt. */
describe.skipIf(!hasDb)("topic narrowing", () => {
  it("keeps retrieval inside the chapters the reader chose", async () => {
    const { searchArticlesHybrid } = await import("@/lib/law");
    const q = "Can I be arrested without a lawful reason?";
    const all = await searchArticlesHybrid(q, 5);
    expect(all.some((h) => h.chapterNumber === "III")).toBe(true); // where the question really belongs
    const narrowed = await searchArticlesHybrid(q, 5, ["V"]);
    expect(narrowed.every((h) => h.chapterNumber === "V")).toBe(true);
    expect(narrowed.some((h) => h.chapterNumber === "III")).toBe(false);
  });

  it("still returns hits when the chosen chapter is the right one", async () => {
    const { searchArticlesHybrid } = await import("@/lib/law");
    const hits = await searchArticlesHybrid("Does Hong Kong keep its own tax revenue?", 5, ["V"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.chapterNumber === "V")).toBe(true);
  });

  it("suggests the chapter a lay question belongs to, best first", async () => {
    const { suggestTopics } = await import("@/lib/law");
    const topics = await suggestTopics("Can I be arrested without a lawful reason?", 3);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.map((t) => t.chapter)).toContain("III");
    expect(topics[0].score).toBeGreaterThanOrEqual(topics[topics.length - 1].score);
  });

  it("names the study question that sent the agent to an article", async () => {
    const { searchArticlesHybrid } = await import("@/lib/law");
    const hits = await searchArticlesHybrid("Do I pay customs duty on goods I bring into Hong Kong?", 5);
    const hit = hits.find((h) => h.number === 114);
    expect(hit?.viaQuestions?.length ?? 0).toBeGreaterThan(0);
  });
});
