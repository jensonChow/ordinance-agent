#!/usr/bin/env node
/**
 * Is /api/chat actually streaming to the client, or arriving in one lump at the end?
 *
 *   node scripts/stream-timing.mjs http://127.0.0.1:3100      # straight at the app
 *   node scripts/stream-timing.mjs http://127.0.0.1:8080      # through the Apache reverse proxy
 *
 * A reverse proxy that buffers the response body is invisible to every other check in this repo: the same bytes
 * arrive, the same answer renders, the tests pass — and the user watches a blank screen until the tool loop has
 * finished. So this measures when each network chunk arrives, and calls the result buffered when everything lands
 * in effectively one moment at the end.
 *
 * The measure is deliberately scale-free: **how early the first chunk lands as a fraction of when the last one
 * does**. An absolute threshold does not survive contact with reality here — against the scripted model a whole
 * answer can be finished in 50 ms, and at that speed "arrived over 30 ms" and "arrived at once" are the same
 * picture. A body the proxy held back, by contrast, has its first byte and its last byte in the same instant
 * whatever the total took, so the ratio separates the two cases at any speed. (This replaced a first attempt that
 * called a 40 ms spread "buffered"; the finding is in VERIFICATION.md, because the false alarm is instructive.)
 *
 * Exit code 1 if the stream was not incremental, so it can sit in a check script.
 */
const base = process.argv[2] ?? "http://127.0.0.1:3100";
// A broad question: the scripted model answers it in three tool steps, so there is something to stream.
const question = process.argv[3] ?? "I want to understand what rights residents have here";
/** Above this, the first chunk arrived at effectively the same moment as the last: nothing was streamed. */
const FRONT_LOADED = 0.9;

const conversation = await fetch(`${base}/api/conversations`, { method: "POST" }).then((r) => r.json());
const conversationId = conversation.id ?? conversation.conversationId;
if (!conversationId) throw new Error(`could not create a conversation: ${JSON.stringify(conversation)}`);

const t0 = performance.now();
const res = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    conversationId,
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: question }] }],
  }),
});
if (!res.ok) throw new Error(`/api/chat ${res.status}: ${await res.text()}`);

const arrivals = [];
const reader = res.body.getReader();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  arrivals.push({ ms: Math.round(performance.now() - t0), bytes: value.byteLength });
}

const first = arrivals[0]?.ms ?? 0;
const last = arrivals.at(-1)?.ms ?? 0;
const ratio = last > 0 ? first / last : 1;
const incremental = arrivals.length > 1 && ratio <= FRONT_LOADED;

console.log(
  JSON.stringify(
    {
      base,
      transferEncoding: res.headers.get("transfer-encoding"),
      contentEncoding: res.headers.get("content-encoding"),
      via: res.headers.get("via") ?? res.headers.get("server"),
      chunks: arrivals.length,
      bytes: arrivals.reduce((n, a) => n + a.bytes, 0),
      firstChunkMs: first,
      lastChunkMs: last,
      arrivalsMs: arrivals.map((a) => a.ms),
      firstByteFraction: Number(ratio.toFixed(2)),
      verdict: incremental ? "incremental" : "buffered — the first chunk arrived with the last",
    },
    null,
    1,
  ),
);
process.exit(incremental ? 0 : 1);
