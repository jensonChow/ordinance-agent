import { describe, expect, it } from "vitest";
import { formatCitation, stripDomainStopwords } from "@/lib/law";

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
