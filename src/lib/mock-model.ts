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
      // Chapters the reader ticked reach the model only through the system prompt, so read them back out here:
      // it proves the narrowing survived the trip from the chip row to the tool call.
      const system = options.prompt.find((m) => m.role === "system");
      const systemText = typeof system?.content === "string" ? system.content : "";
      const narrowed = systemText.match(/chapters: (\[[^\]]*\])/)?.[1];
      const chosen: string[] | null = narrowed ? (JSON.parse(narrowed) as string[]) : null;
      // Broad-wording branch: the chapter is not obvious from the question, so the agent offers topics first.
      const broadQuestion = /which chapter|what topic|where in the basic law/i.test(userText);
      // The one question the scripted answer below is actually about.
      const residencyQuestion = /permanent resident|right of abode|article 24/i.test(userText);
      // Article numbers any tool has already returned in this turn, read back out of the prompt. A scripted model
      // has no other way to know them, and the honest fallback below must not name an article retrieval never saw.
      const returned = [
        ...new Set(
          [
            ...JSON.stringify(options.prompt.filter((m) => m.role === "tool")).matchAll(/\\?"article\\?"\s*:\s*(\d+)/g),
          ].map((m) => Number(m[1])),
        ),
      ]
        .filter((n) => n >= 1 && n <= 160)
        .slice(0, 5);
      // Lay-wording branch: goes through the question bank, and deliberately ends by naming one article it never
      // read (Article 106). That is not a bug — it is the fixture for the unverified-citation guard in the UI
      // (src/lib/citations.ts), so the amber chip can be demonstrated without a live model.
      const layQuestion = /customs|duty|duties|import|bring in/i.test(userText);

      let parts: LanguageModelV3StreamPart[];
      if (broadQuestion && !wantsNote) {
        if (toolSteps === 0) {
          parts = toolCall("call_topics", "suggest_topics", { query: userText.slice(0, 300), limit: 3 });
        } else if (toolSteps === 1) {
          parts = toolCall("call_search_narrowed", "search_articles", {
            query: userText.slice(0, 200),
            limit: 5,
            ...(chosen?.length ? { chapters: chosen } : {}),
          });
        } else if (toolSteps === 2) {
          parts = toolCall("call_get_27", "get_article", { number: 27 });
        } else {
          parts = text(
            `This sits in Chapter III, Fundamental Rights and Duties of the Residents${
              chosen?.length ? ` (you narrowed the search to Chapter ${chosen.join(", ")})` : ""
            }. Article 27 gives Hong Kong residents “freedom of speech, of the press and of publication”, along with freedom of association, of assembly, of procession and of demonstration. Tick a different chapter above if you meant something else.`,
          );
        }
      } else if (layQuestion && !wantsNote) {
        if (toolSteps === 0) {
          parts = toolCall("call_find", "find_questions", { query: userText.slice(0, 300), limit: 3 });
        } else if (toolSteps === 1) {
          parts = toolCall("call_get_114", "get_article", { number: 114 });
        } else {
          parts = text(
            "Article 114 makes Hong Kong a free port: the Region “shall maintain the status of a free port and shall not impose any tariff unless otherwise prescribed by law”. So ordinary goods brought in are not subject to a customs tariff, though specific duties can still be imposed by ordinary legislation. Article 106 leaves the Region its own finances, which is why these decisions are made locally.",
          );
        }
      } else if (wantsNote && toolSteps === 0) {
        parts = toolCall("call_note", "save_note", { body: userText.replace(/^.*?note:?\s*/i, "").trim() || userText, article: 39 });
      } else if (wantsNote) {
        parts = text("Saved your note against Article 39. Say “list my notes” any time to review them.");
      } else if (residencyQuestion && toolSteps === 0) {
        parts = toolCall("call_search", "search_articles", { query: "permanent resident seven years", limit: 3 });
      } else if (residencyQuestion && toolSteps === 1) {
        parts = toolCall("call_get", "get_article", { number: 24 });
      } else if (residencyQuestion) {
        parts = text(
          "Under Article 24(2), permanent residents include Chinese citizens who have ordinarily resided in Hong Kong for a continuous period of not less than seven years, and under Article 24(4) non-Chinese nationals who meet the same seven-year test and have taken Hong Kong as their place of permanent residence. Note the footnote: category (3) was the subject of an NPCSC interpretation on 26 June 1999.",
        );
      } else if (toolSteps === 0) {
        // Anything this script was not written for. Run the real retrieval, then say plainly that no answer is
        // coming rather than returning a canned answer to a question nobody asked — which is what a scripted model
        // pretending to be general would do, and is exactly the failure this project is about.
        parts = toolCall("call_search_any", "search_articles", { query: userText.slice(0, 200), limit: 5 });
      } else {
        const found = returned.length ? returned.map((n) => `Article ${n}`).join(", ") : null;
        parts = text(
          `**This deployment runs a scripted stand-in, not a language model**, so it will not compose an answer to that question. Everything else on the page is real — the search above ran against all 160 articles in PostgreSQL and ${
            found
              ? `returned ${found}. Open any of them to read the full text, see which study question matched, and rate whether it was relevant; those ratings feed the evaluation page.`
              : "returned nothing it could rank, which is itself a real result rather than a scripted one."
          }\n\nSet \`OPENAI_COMPATIBLE_*\` or \`AZURE_*\` (see \`.env.example\`) and the same tool loop runs against a real model.`,
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
