"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { citationStatus, explainProvenance, messageCitations, unwrapToolOutput, type CitationStatus } from "@/lib/citations";

type ToolPart = {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type ArticleView = { number: number; citation: string; chapter: string; section: string | null; text: string; notes: string[] };

function pretty(value: unknown): string {
  const v = unwrapToolOutput(value);
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolCard({ part }: { part: ToolPart }) {
  const name = getToolName(part as never);
  const isMcp = part.type === "dynamic-tool";
  const label = part.state === "output-available" ? "done" : part.state === "output-error" ? "error" : "running";
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

const CHIP_STYLE: Record<CitationStatus, string> = {
  read: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  retrieved: "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-black dark:text-neutral-300",
  unverified: "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
};

/** Short marker for the retrieval path that surfaced the article: question bank, full-text search, or nothing. */
function pathMark(found: string[]): string | null {
  if (found.some((f) => f.startsWith("question bank"))) return "qb";
  if (found.some((f) => f.startsWith("full-text"))) return "fts";
  return null;
}

function Chip({
  n,
  status,
  found,
  onOpen,
}: {
  n: number;
  status: CitationStatus;
  found: string[];
  onOpen: (n: number) => void;
}) {
  const mark = pathMark(found);
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      title={explainProvenance(n, { read: status === "read", mentioned: true, found })}
      className={`rounded-full border px-2 py-0.5 font-mono text-[11px] hover:bg-neutral-200 dark:hover:bg-neutral-800 ${CHIP_STYLE[status]}`}
    >
      Art. {n}
      {status === "unverified" ? <span className="ml-1 not-italic">⚠</span> : null}
      {mark ? <span className="ml-1 opacity-60">{mark}</span> : null}
    </button>
  );
}

function MessageView({ message, onOpen }: { message: UIMessage; onOpen: (n: number) => void }) {
  const isUser = message.role === "user";
  const meta = message.metadata as { provider?: string; model?: string } | undefined;
  const cites = isUser ? null : messageCitations(message);
  // Chip row = every article the answer stands on: read in full, or named in the text.
  const chips = cites
    ? [...new Set([...cites.read, ...cites.mentioned])]
        .sort((a, b) => a - b)
        .map((n) => {
          const p = cites.provenance[n];
          return { n, status: citationStatus(p), found: p?.found ?? [] };
        })
    : [];
  const unverified = chips.filter((c) => c.status === "unverified").length;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser ? "bg-neutral-900 text-white dark:bg-white dark:text-black" : "bg-neutral-100 dark:bg-neutral-900"
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return isUser ? (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            ) : (
              <div key={i} className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-li:my-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
              </div>
            );
          }
          if (isToolUIPart(part)) {
            return <ToolCard key={i} part={part as unknown as ToolPart} />;
          }
          return null;
        })}
        {cites && (chips.length > 0 || cites.toolCalls > 0) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-200 pt-2 text-[11px] text-neutral-500 dark:border-neutral-800">
            {chips.length > 0 ? <span className="mr-1">Sources</span> : null}
            {chips.map((c) => (
              <Chip key={c.n} n={c.n} status={c.status} found={c.found} onOpen={onOpen} />
            ))}
            {cites.toolCalls > 0 ? (
              <span className="ml-auto">
                {cites.toolCalls} tool call{cites.toolCalls === 1 ? "" : "s"}
                {cites.mcpCalls ? ` · ${cites.mcpCalls} via MCP` : ""}
                {meta?.model ? ` · ${meta.provider} / ${meta.model}` : ""}
              </span>
            ) : null}
            {unverified > 0 ? (
              <p className="basis-full text-amber-700 dark:text-amber-300">
                ⚠ {unverified} article{unverified === 1 ? "" : "s"} named in this answer {unverified === 1 ? "was" : "were"}{" "}
                never returned by a tool.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ArticlePanel({ article, onClose, onOpen }: { article: ArticleView; onClose: () => void; onOpen: (n: number) => void }) {
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-emerald-800 dark:text-emerald-200">{article.citation}</span>
        <span className="text-xs text-neutral-500">
          Chapter {article.chapter}
          {article.section ? ` · ${article.section}` : ""}
        </span>
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={() => article.number > 1 && onOpen(article.number - 1)} className="rounded border px-2 text-xs" aria-label="previous article">
            ‹
          </button>
          <button type="button" onClick={() => article.number < 160 && onOpen(article.number + 1)} className="rounded border px-2 text-xs" aria-label="next article">
            ›
          </button>
          <button type="button" onClick={onClose} className="rounded border px-2 text-xs" aria-label="close">
            ×
          </button>
        </span>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{article.text}</p>
      {article.notes.length ? (
        <ul className="mt-2 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          {article.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Chat({
  conversationId,
  initialMessages,
  starters,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  starters: string[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [openArticle, setOpenArticle] = useState<number | null>(null);
  const [article, setArticle] = useState<ArticleView | null>(null);
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { conversationId } }),
    [conversationId],
  );
  const { messages, sendMessage, status, error, stop } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
    onFinish: () => router.refresh(), // refresh server-rendered notes / counters / conversation list
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (openArticle == null) return;
    let cancelled = false;
    fetch(`/api/articles/${openArticle}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a: ArticleView | null) => {
        if (!cancelled) setArticle(a);
      })
      .catch(() => {
        if (!cancelled) setArticle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openArticle]);

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
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-400">Try a question from the study bank</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {starters.map((s) => (
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
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} onOpen={setOpenArticle} />)
        )}
        {busy ? <div className="text-xs text-neutral-400">Thinking with tools…</div> : null}
        {error ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error.message}
          </div>
        ) : null}
      </div>
      {article && openArticle != null ? (
        <ArticlePanel
          article={article}
          onClose={() => {
            setOpenArticle(null);
            setArticle(null);
          }}
          onOpen={setOpenArticle}
        />
      ) : null}
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
          placeholder="Ask about the Basic Law in your own words…"
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
