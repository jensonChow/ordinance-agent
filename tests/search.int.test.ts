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
