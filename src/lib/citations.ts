import { getToolName, isToolUIPart, type UIMessage, type UIMessagePart } from "ai";

/** Unwrap an MCP tool result ({ content: [{ type: "text", text: "<json>" }] }) or return the value as-is. */
export function unwrapToolOutput(value: unknown): unknown {
  const v = value as { content?: { type: string; text?: string }[] } | undefined;
  const textBlock = v?.content?.find((c) => c.type === "text")?.text;
  if (textBlock) {
    try {
      return JSON.parse(textBlock);
    } catch {
      return textBlock;
    }
  }
  return value;
}

export type MessageCitations = {
  /** Articles whose full text the agent read (get_article / get_articles). */
  read: number[];
  /** Articles the assistant named in its answer ("Article 24", "Art. 24(2)"). */
  mentioned: number[];
  /** Tool-call counts for the trace line. */
  toolCalls: number;
  mcpCalls: number;
};

/** Derive citation chips and trace counts for one assistant message, purely from its UI parts. */
export function messageCitations(message: UIMessage): MessageCitations {
  const read = new Set<number>();
  const mentioned = new Set<number>();
  let toolCalls = 0;
  let mcpCalls = 0;
  for (const part of message.parts as UIMessagePart<never, never>[]) {
    if (part.type === "text") {
      for (const m of part.text.matchAll(/\bArt(?:icle|\.)\s*(\d{1,3})\b/gi)) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 160) mentioned.add(n);
      }
      continue;
    }
    if (!isToolUIPart(part)) continue;
    toolCalls++;
    const p = part as unknown as { type: string; state: string; output?: unknown };
    if (p.type === "dynamic-tool") mcpCalls++;
    if (p.state !== "output-available") continue;
    const name = getToolName(part);
    if (name !== "get_article" && name !== "get_articles") continue;
    const out = unwrapToolOutput(p.output) as { article?: number; articles?: { article: number }[] } | undefined;
    if (out?.article) read.add(out.article);
    for (const a of out?.articles ?? []) if (a?.article) read.add(a.article);
  }
  return {
    read: [...read].sort((a, b) => a - b),
    mentioned: [...mentioned].sort((a, b) => a - b),
    toolCalls,
    mcpCalls,
  };
}
