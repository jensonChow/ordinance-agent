import { getToolName, isToolUIPart, type UIMessage, type UIMessagePart } from "ai";

export type ToolTrace = {
  toolCallId: string;
  toolName: string;
  source: "mcp" | "local";
  state: string;
  input: unknown;
  output: unknown;
};

/** Pull every tool invocation out of a UI message (both dynamic MCP tools and statically typed local tools). */
export function toolTraces(message: UIMessage): ToolTrace[] {
  const traces: ToolTrace[] = [];
  for (const part of message.parts as UIMessagePart<never, never>[]) {
    if (!isToolUIPart(part)) continue;
    const p = part as unknown as { toolCallId: string; state: string; input?: unknown; output?: unknown; type: string };
    traces.push({
      toolCallId: p.toolCallId,
      toolName: getToolName(part),
      source: p.type === "dynamic-tool" ? "mcp" : "local",
      state: p.state,
      input: p.input ?? null,
      output: p.output ?? null,
    });
  }
  return traces;
}

/** Article numbers surfaced by Basic Law tools (get_article / get_articles / search_articles). */
export function citedArticles(traces: ToolTrace[]): number[] {
  const found = new Set<number>();
  for (const t of traces) {
    if (!/^(get_article|get_articles|search_articles)$/.test(t.toolName)) continue;
    const blob = JSON.stringify(t.output ?? "");
    for (const m of blob.matchAll(/\\?"article\\?":(\d{1,3})/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 160) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}
