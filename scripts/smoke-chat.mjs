#!/usr/bin/env node
/**
 * Keyless end-to-end smoke test for the agent loop.
 * Start the app with MODEL_PROVIDER=mock (e.g. `MODEL_PROVIDER=mock npm run dev -- -p 3100`), then:
 *   node scripts/smoke-chat.mjs http://127.0.0.1:3100
 * It creates a conversation, sends two turns through /api/chat, and prints the UI-message stream chunks
 * (tool calls, tool results, text). Exit code 1 if the expected tools were not called.
 */
const base = process.argv[2] ?? "http://127.0.0.1:3000";

async function turn(conversationId, id, text, history) {
  const messages = [...history, { id, role: "user", parts: [{ type: "text", text }] }];
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, conversationId }),
  });
  if (!res.ok) throw new Error(`/api/chat ${res.status}: ${await res.text()}`);
  const chunks = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      chunks.push(JSON.parse(payload));
    }
  }
  return chunks;
}

function summarise(chunks) {
  const tools = chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolName);
  const outputs = chunks.filter((c) => c.type === "tool-output-available").length;
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
  const finish = chunks.find((c) => c.type === "finish");
  return { tools, outputs, text, finish: finish?.finishReason ?? null, chunkTypes: [...new Set(chunks.map((c) => c.type))] };
}

const conv = await fetch(`${base}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
console.log("conversation", conv.id);

const t1 = summarise(await turn(conv.id, "u1", "Who qualifies as a permanent resident under Article 24?", []));
console.log("turn 1", JSON.stringify(t1, null, 1));
const t2 = summarise(
  await turn(conv.id, "u2", "Save a note: revise Article 39 before the tutorial.", [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Who qualifies as a permanent resident under Article 24?" }] },
  ]),
);
console.log("turn 2", JSON.stringify(t2, null, 1));

const t3 = summarise(
  await turn(conv.id, "u3", "Do I pay customs duty on goods I bring into Hong Kong?", []),
);
console.log("turn 3", JSON.stringify(t3, null, 1));

// Turn 3 walks the question-bank path and, by design, names one article it never read (Article 106) so the
// unverified-citation guard has something to catch. See src/lib/mock-model.ts and src/lib/citations.ts.
const namesUnread = t3.text.includes("Article 106");

const ok =
  t1.tools.includes("search_articles") && t1.tools.includes("get_article") && t1.outputs >= 2 && t1.text.includes("Article 24") &&
  t2.tools.includes("save_note") && t2.outputs >= 1 &&
  t3.tools.includes("find_questions") && t3.tools.includes("get_article") && t3.text.includes("Article 114") && namesUnread;
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
