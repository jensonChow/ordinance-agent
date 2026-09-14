import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { citationStatus, explainProvenance, messageCitations, unwrapToolOutput } from "@/lib/citations";
import { citedArticles, toolTraces } from "@/lib/trace";

const mcpOutput = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

const assistant: UIMessage = {
  id: "a_1",
  role: "assistant",
  parts: [
    { type: "dynamic-tool", toolName: "search_articles", toolCallId: "c1", state: "output-available", input: { query: "x" }, output: mcpOutput({ hits: [{ article: 24 }, { article: 31 }] }) },
    { type: "dynamic-tool", toolName: "get_article", toolCallId: "c2", state: "output-available", input: { number: 24 }, output: mcpOutput({ article: 24, text: "…" }) },
    { type: "tool-save_note", toolCallId: "c3", state: "output-available", input: { body: "n" }, output: { saved: true } },
    { type: "text", text: "Under Article 24(2) … see also Art. 39 and Article 999." },
  ] as UIMessage["parts"],
};

describe("unwrapToolOutput", () => {
  it("parses the JSON inside an MCP text content block", () => {
    expect(unwrapToolOutput(mcpOutput({ a: 1 }))).toEqual({ a: 1 });
  });
  it("returns non-MCP values unchanged", () => {
    expect(unwrapToolOutput({ saved: true })).toEqual({ saved: true });
  });
});

describe("messageCitations", () => {
  it("separates articles the agent read from articles it merely mentioned, and ignores out-of-range numbers", () => {
    const c = messageCitations(assistant);
    expect(c.read).toEqual([24]);
    expect(c.mentioned).toEqual([24, 39]);
    expect(c.toolCalls).toBe(3);
    expect(c.mcpCalls).toBe(2);
  });

  it("records which retrieval path surfaced each article", () => {
    const message: UIMessage = {
      id: "a_2",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "find_questions",
          toolCallId: "q1",
          state: "output-available",
          input: { query: "customs duty" },
          output: mcpOutput({ questions: [{ id: "qb-055", articles: [114] }] }),
        },
        {
          type: "dynamic-tool",
          toolName: "search_articles",
          toolCallId: "s1",
          state: "output-available",
          input: { query: "customs duty" },
          output: mcpOutput({
            hits: [
              { article: 114, match: "hybrid", found_by: ["question bank", "semantic"] },
              { article: 89, match: "hybrid", found_by: ["full-text"] },
            ],
          }),
        },
        {
          type: "dynamic-tool",
          toolName: "get_article",
          toolCallId: "g1",
          state: "output-available",
          input: { number: 114 },
          output: mcpOutput({ article: 114, text: "…" }),
        },
        { type: "text", text: "Article 114 makes Hong Kong a free port. See also Article 106." },
      ] as UIMessage["parts"],
    };
    const c = messageCitations(message);
    expect(c.provenance[114]).toEqual({
      read: true,
      mentioned: true,
      found: ["question bank (qb-055)", "the question bank", "semantic search"],
    });
    // surfaced by search but never read or named
    expect(c.provenance[89]).toEqual({ read: false, mentioned: false, found: ["full-text search"] });
    // named in the answer with no tool ever returning it
    expect(c.provenance[106]).toEqual({ read: false, mentioned: true, found: [] });
  });
});

describe("citationStatus / explainProvenance", () => {
  it("flags an article the model named but never looked up", () => {
    const p = { read: false, mentioned: true, found: [] };
    expect(citationStatus(p)).toBe("unverified");
    expect(explainProvenance(106, p)).toMatch(/never returned by a tool/);
  });
  it("ranks read above merely retrieved", () => {
    expect(citationStatus({ read: true, mentioned: false, found: ["question bank (qb-055)"] })).toBe("read");
    expect(citationStatus({ read: false, mentioned: false, found: ["full-text search (strict)"] })).toBe("retrieved");
    expect(explainProvenance(114, { read: true, mentioned: true, found: ["question bank (qb-055)"] })).toMatch(
      /Found via question bank \(qb-055\)/,
    );
  });
});

describe("toolTraces / citedArticles (server-side persistence)", () => {
  it("labels MCP vs local tools and extracts article numbers from Basic Law tool outputs", () => {
    const traces = toolTraces(assistant);
    expect(traces.map((t) => [t.toolName, t.source])).toEqual([
      ["search_articles", "mcp"],
      ["get_article", "mcp"],
      ["save_note", "local"],
    ]);
    expect(citedArticles(traces)).toEqual([24, 31]);
  });
});
