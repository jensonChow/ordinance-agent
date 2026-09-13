import { describe, expect, it } from "vitest";
import { formatCitation, parseCitations, stripDomainStopwords } from "@/lib/text";

describe("formatCitation", () => {
  it("formats article and paragraph", () => {
    expect(formatCitation(24)).toBe("Basic Law, art. 24");
    expect(formatCitation(24, 2)).toBe("Basic Law, art. 24(2)");
  });
});

describe("stripDomainStopwords", () => {
  it("drops phrases that appear in almost every article and possessives", () => {
    expect(stripDomainStopwords("Are Hong Kong's finances separate from the mainland's?")).toBe("are finances separate from the mainland");
    // leftover function words ("the", "about") are dropped later by PostgreSQL's english dictionary
    expect(stripDomainStopwords("What does the Basic Law say about the Chief Executive?")).toBe("the about the chief executive");
  });
  it("never returns an empty query", () => {
    expect(stripDomainStopwords("Hong Kong law")).toBe("Hong Kong law");
  });
});

describe("parseCitations", () => {
  it("reads single citations, paragraph numbers, lists and ranges", () => {
    expect(parseCitations("see BL art 24(2), Articles 39 and 41, and Articles 45 to 47")).toEqual([
      { article: 24, paragraph: 2, raw: "24(2)" },
      { article: 39, paragraph: null, raw: "39" },
      { article: 41, paragraph: null, raw: "41" },
      { article: 45, paragraph: null, raw: "45" },
      { article: 46, paragraph: null, raw: "45–47" },
      { article: 47, paragraph: null, raw: "47" },
    ]);
  });
  it("drops numbers outside 1–160 and de-duplicates", () => {
    expect(parseCitations("Article 999, Article 24, art. 24 again").map((c) => c.article)).toEqual([24]);
  });
  it("returns nothing when there is no citation", () => {
    expect(parseCitations("The particles were 5 nanometres across.")).toEqual([]);
  });
});
