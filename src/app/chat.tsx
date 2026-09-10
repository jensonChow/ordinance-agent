"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

const STARTERS = [
  "Who qualifies as a permanent resident under Article 24?",
  "What does the Basic Law say about freedom of speech and assembly?",
  "How can the Basic Law be interpreted or amended? Cite the articles.",
  "Save a note: revise Article 39 and the ICCPR point before Friday's tutorial.",
];

type ToolPart = {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function pretty(value: unknown): string {
  // MCP tool results arrive as { content: [{ type: "text", text: "<json>" }] } — unwrap for display.
  const v = value as { content?: { type: string; text?: string }[] } | undefined;
  const textBlock = v?.content?.find((c) => c.type === "text")?.text;
  if (textBlock) {
    try {
      return JSON.stringify(JSON.parse(textBlock), null, 2);
    } catch {
      return textBlock;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolCard({ part }: { part: ToolPart }) {
  const name = getToolName(part as never);
  const isMcp = part.type === "dynamic-tool";
  const label =
    part.state === "output-available" ? "done" : part.state === "output-error" ? "error" : "running";
  return (
    <details className="my-2 rounded-md border border-neutral-200 bg-neutral-50 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="cursor-pointer select-none px-3 py-2 font-mono">
        <span className={isMcp ? "text-violet-700 dark:text-violet-300" : "text-emerald-700 dark:text-emerald-300"}>
          {isMcp ? "mcp" : "local"}
        </span>{" "}
        · {name} · <span className="text-neutral-500">{label}</span>
      </summary>
      <div className="grid gap-2 px-3 pb-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-neutral-500">input</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 dark:bg-black">{pretty(part.input)}</pre>
        </div>
        <div>
          <div className="mb-1 text-neutral-500">output</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 dark:bg-black">
            {part.state === "output-error" ? part.errorText : pretty(part.output)}
          </pre>
        </div>
      </div>
    </details>
  );
}

function MessageView({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const meta = message.metadata as { provider?: string; model?: string } | undefined;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser ? "bg-neutral-900 text-white dark:bg-white dark:text-black" : "bg-neutral-100 dark:bg-neutral-900"
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            );
          }
          if (isToolUIPart(part)) {
            return <ToolCard key={i} part={part as unknown as ToolPart} />;
          }
          return null;
        })}
        {!isUser && meta?.model ? (
          <div className="mt-2 text-[10px] uppercase tracking-wide text-neutral-400">
            {meta.provider} · {meta.model}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Chat({ conversationId, initialMessages }: { conversationId: string; initialMessages: UIMessage[] }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { conversationId } }),
    [conversationId],
  );
  const { messages, sendMessage, status, error, stop } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
    onFinish: () => router.refresh(), // refresh server-rendered notes / counters
  });
  const busy = status === "submitted" || status === "streaming";

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage({ text: t });
    setInput("");
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        {messages.length === 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="rounded-lg border border-neutral-200 p-3 text-left text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
        {error ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error.message}
          </div>
        ) : null}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the Basic Law…"
          className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-black"
        />
        {busy ? (
          <button type="button" onClick={() => stop()} className="rounded-lg border px-4 py-2 text-sm">
            Stop
          </button>
        ) : (
          <button type="submit" className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
            Send
          </button>
        )}
      </form>
    </div>
  );
}
