import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { messageCitations, unwrapToolOutput } from "@/lib/citations";
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
