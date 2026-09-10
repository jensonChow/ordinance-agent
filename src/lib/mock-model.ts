import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

/**
 * A scripted model for keyless end-to-end tests (MODEL_PROVIDER=mock).
 * It walks the same agent loop a real model would: search → read the article → answer, or save_note → answer.
 * Step number = how many tool-result messages are already in the prompt.
 */
export function createMockModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "scripted-basic-law-agent",
    doStream: async (options: LanguageModelV3CallOptions) => {
      const toolSteps = options.prompt.filter((m) => m.role === "tool").length;
      const lastUser = [...options.prompt].reverse().find((m) => m.role === "user");
      const userText =
        lastUser && Array.isArray(lastUser.content)
          ? lastUser.content.map((p) => ("text" in p ? p.text : "")).join(" ")
          : "";
      const wantsNote = /\bnote\b/i.test(userText);

      let parts: LanguageModelV3StreamPart[];
      if (wantsNote && toolSteps === 0) {
        parts = toolCall("call_note", "save_note", { body: userText.replace(/^.*?note:?\s*/i, "").trim() || userText, article: 39 });
      } else if (wantsNote) {
        parts = text("Saved your note against Article 39. Say “list my notes” any time to review them.");
      } else if (toolSteps === 0) {
        parts = toolCall("call_search", "search_articles", { query: "permanent resident seven years", limit: 3 });
      } else if (toolSteps === 1) {
        parts = toolCall("call_get", "get_article", { number: 24 });
      } else {
        parts = text(
          "Under Article 24(2), permanent residents include Chinese citizens who have ordinarily resided in Hong Kong for a continuous period of not less than seven years, and under Article 24(4) non-Chinese nationals who meet the same seven-year test and have taken Hong Kong as their place of permanent residence. Note the footnote: category (3) was the subject of an NPCSC interpretation on 26 June 1999.",
        );
      }
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  });
}

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function toolCall(id: string, toolName: string, input: Record<string, unknown>): LanguageModelV3StreamPart[] {
  const json = JSON.stringify(input);
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: json },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input: json },
    { type: "finish", usage: usage(), finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

function text(value: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: value },
    { type: "text-end", id: "t1" },
    { type: "finish", usage: usage(), finishReason: { unified: "stop", raw: undefined } },
  ];
}
