"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  citationStatus,
  explainProvenance,
  messageCitations,
  unwrapToolOutput,
  type ArticleProvenance,
  type CitationStatus,
} from "@/lib/citations";

type ToolPart = {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type ArticleView = { number: number; citation: string; chapter: string; section: string | null; text: string; notes: string[] };

/** What the article panel is currently showing, and which answer it was opened from (so a rating can be attributed). */
type Focus = { number: number; messageId: string | null; provenance?: ArticleProvenance };

/**
 * Display shorthands for the chapter titles, which run up to eleven words and do not fit in a chip row. The full
 * title is always the chip's tooltip and is what the sidebar and the article panel show.
 */
const CHAPTER_SHORT: Record<string, string> = {
  I: "General principles",
  II: "Central authorities",
  III: "Rights and duties",
  IV: "Political structure",
  V: "Economy",
  VI: "Education and labour",
  VII: "External affairs",
  VIII: "Interpretation",
  IX: "Supplementary",
};

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
  const marks = [
    found.some((f) => f.includes("question bank")) ? "qb" : null,
    found.some((f) => f.startsWith("full-text")) ? "fts" : null,
    found.some((f) => f.startsWith("semantic")) ? "vec" : null,
  ].filter(Boolean);
  return marks.length ? marks.join("·") : null;
}

function Chip({ n, status, provenance, onOpen }: { n: number; status: CitationStatus; provenance?: ArticleProvenance; onOpen: () => void }) {
  const mark = pathMark(provenance?.found ?? []);
  const question = provenance?.modelQuestions?.[0];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${explainProvenance(n, provenance)}${question ? `\n\nMatched question: ${question}` : ""}`}
      className={`rounded-full border px-2 py-0.5 font-mono text-[11px] hover:bg-neutral-200 dark:hover:bg-neutral-800 ${CHIP_STYLE[status]}`}
    >
      Art. {n}
      {status === "unverified" ? <span className="ml-1 not-italic">⚠</span> : null}
      {mark ? <span className="ml-1 opacity-60">{mark}</span> : null}
    </button>
  );
}

type TopicHit = { chapter: string; title: string; score: number; articles: number[] };

/** Topics the agent proposed in this message, if it called suggest_topics. */
function suggestedTopics(message: UIMessage): TopicHit[] {
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    const p = part as unknown as { state: string; output?: unknown };
    if (p.state !== "output-available" || getToolName(part) !== "suggest_topics") continue;
    const out = unwrapToolOutput(p.output) as { topics?: TopicHit[] } | undefined;
    if (out?.topics?.length) return out.topics;
  }
  return [];
}

function MessageView({
  message,
  selected,
  onOpen,
  onPickTopics,
}: {
  message: UIMessage;
  selected: string[];
  onOpen: (focus: Focus) => void;
  onPickTopics: (chapters: string[]) => void;
}) {
  const isUser = message.role === "user";
  const meta = message.metadata as { provider?: string; model?: string } | undefined;
  const cites = isUser ? null : messageCitations(message);
  const topics = isUser ? [] : suggestedTopics(message);
  // Chip row = every article the answer stands on: read in full, or named in the text.
  const chips = cites
    ? [...new Set([...cites.read, ...cites.mentioned])]
        .sort((a, b) => a - b)
        .map((n) => ({ n, status: citationStatus(cites.provenance[n]), provenance: cites.provenance[n] }))
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

        {/* The agent proposed chapters; the reader confirms one before the next turn. */}
        {topics.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-200 pt-2 text-[11px] dark:border-neutral-800">
            <span className="text-neutral-500">Narrow to</span>
            {topics.map((t) => {
              const on = selected.includes(t.chapter);
              return (
                <button
                  key={t.chapter}
                  type="button"
                  onClick={() => onPickTopics(on ? selected.filter((c) => c !== t.chapter) : [...selected, t.chapter])}
                  title={`Chapter ${t.chapter} — ${t.title} (articles ${t.articles.slice(0, 6).join(", ")})`}
                  className={`rounded-full border px-2 py-0.5 ${
                    on
                      ? "border-violet-400 bg-violet-100 text-violet-900 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200"
                      : "border-neutral-300 hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  }`}
                >
                  {t.chapter} · {CHAPTER_SHORT[t.chapter] ?? t.title}
                </button>
              );
            })}
          </div>
        ) : null}

        {cites && (chips.length > 0 || cites.toolCalls > 0) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-200 pt-2 text-[11px] text-neutral-500 dark:border-neutral-800">
            {chips.length > 0 ? <span className="mr-1">Sources</span> : null}
            {chips.map((c) => (
              <Chip
                key={c.n}
                n={c.n}
                status={c.status}
                provenance={c.provenance}
                onOpen={() => onOpen({ number: c.n, messageId: message.id, provenance: c.provenance })}
              />
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

/**
 * Relevance feedback on one cited article, 0 (not relevant) to 5 (exactly right).
 *
 * This is the one place a human grades the machine. The offline benchmark in /eval measures whether retrieval
 * finds the article the question bank says is right; these scores measure whether a reader agreed it helped,
 * which is the judgement an automatic metric cannot make.
 */
function RelevanceRating({ messageId, article }: { messageId: string; article: number }) {
  const [value, setValue] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Keyed by message + article at the call site, so a different citation remounts this with fresh state and the
  // effect only ever sets state from the response.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ratings?messageId=${encodeURIComponent(messageId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ratings?: Record<string, number> } | null) => {
        if (!cancelled && d?.ratings?.[article] != null) setValue(d.ratings[article]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [messageId, article]);

  const save = async (v: number) => {
    setValue(v);
    setState("saving");
    try {
      const res = await fetch("/api/ratings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, article, value: v }),
      });
      setState(res.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-emerald-200 pt-2 text-xs dark:border-emerald-900">
      <span className="text-neutral-600 dark:text-neutral-400">Was this article relevant to your question?</span>
      {[0, 1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => void save(v)}
          aria-label={`Rate ${v} of 5`}
          aria-pressed={value === v}
          className={`h-6 w-6 rounded border font-mono text-[11px] ${
            value === v
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          }`}
        >
          {v}
        </button>
      ))}
      <span className="text-neutral-500">
        {state === "saving" ? "saving…" : state === "saved" ? "saved" : state === "error" ? "could not save" : "0 = no, 5 = exactly right"}
      </span>
    </div>
  );
}

function ArticlePanel({
  article,
  focus,
  onClose,
  onOpen,
}: {
  article: ArticleView;
  focus: Focus;
  onClose: () => void;
  onOpen: (focus: Focus) => void;
}) {
  const move = (n: number) => onOpen({ number: n, messageId: focus.messageId }); // a neighbour carries no provenance from this answer
  const questions = focus.provenance?.modelQuestions ?? [];
  const excerpt = focus.provenance?.excerpt;
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-emerald-800 dark:text-emerald-200">{article.citation}</span>
        <span className="text-xs text-neutral-500">
          Chapter {article.chapter}
          {article.section ? ` · ${article.section}` : ""}
        </span>
        <span className="ml-auto flex gap-1">
          <a href={`/article/${article.number}`} className="rounded border px-2 text-xs" title="Permanent link to this article">
            ↗
          </a>
          <button type="button" onClick={() => article.number > 1 && move(article.number - 1)} className="rounded border px-2 text-xs" aria-label="previous article">
            ‹
          </button>
          <button type="button" onClick={() => article.number < 160 && move(article.number + 1)} className="rounded border px-2 text-xs" aria-label="next article">
            ›
          </button>
          <button type="button" onClick={onClose} className="rounded border px-2 text-xs" aria-label="close">
            ×
          </button>
        </span>
      </div>

      {/* Which lay question the retrieval matched — the unit the CLIC Recommender presents its results in. */}
      {questions.length ? (
        <p className="mb-2 rounded bg-white/70 px-2 py-1 text-xs text-neutral-600 dark:bg-black/40 dark:text-neutral-400">
          Matched study question: <span className="italic">“{questions[0]}”</span>
          {questions.length > 1 ? ` (+${questions.length - 1} more)` : ""}
        </p>
      ) : null}

      <p className="whitespace-pre-wrap leading-relaxed">{article.text}</p>

      {excerpt ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none text-neutral-600 dark:text-neutral-400">Matched passage</summary>
          <p
            className="mt-1 rounded bg-white/70 p-2 leading-relaxed dark:bg-black/40"
            // The snippet is ts_headline output: the article's own words with **…** around the matched terms.
            dangerouslySetInnerHTML={{ __html: excerpt.replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>") }}
          />
          <p className="mt-1 text-neutral-500">
            This is the passage retrieval matched on, not an answer to your question. The full article is above.
          </p>
        </details>
      ) : null}

      {article.notes.length ? (
        <ul className="mt-2 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          {article.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}

      {focus.messageId ? (
        <RelevanceRating key={`${focus.messageId}:${article.number}`} messageId={focus.messageId} article={article.number} />
      ) : null}
    </div>
  );
}

export function Chat({
  conversationId,
  initialMessages,
  starters,
  chapters,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  starters: string[];
  chapters: { number: string; title: string }[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [focus, setFocus] = useState<Focus | null>(null);
  const [article, setArticle] = useState<ArticleView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
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

  const open = useCallback((next: Focus) => {
    setFocus(next);
    setArticle(null);
  }, []);

  useEffect(() => {
    if (focus == null) return;
    let cancelled = false;
    fetch(`/api/articles/${focus.number}`)
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
  }, [focus]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    // The chapter selection travels with the turn, so the server can both tell the model and filter the SQL.
    void sendMessage({ text: t }, { body: { chapters: selected } });
    setInput("");
  };

  const toggle = (ch: string) => setSelected((s) => (s.includes(ch) ? s.filter((x) => x !== ch) : [...s, ch]));

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
          messages.map((m) => (
            <MessageView key={m.id} message={m} selected={selected} onOpen={open} onPickTopics={setSelected} />
          ))
        )}
        {busy ? <div className="text-xs text-neutral-400">Thinking with tools…</div> : null}
        {error ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error.message}
          </div>
        ) : null}
      </div>

      {article && focus ? <ArticlePanel article={article} focus={focus} onClose={() => setFocus(null)} onOpen={open} /> : null}

      {/* Topic narrowing: the reader picks the chapters to search in, the way the CLIC Recommender has them
          confirm a topic before it returns anything. Empty selection searches all nine. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-neutral-500">Search in</span>
        {chapters.map((ch) => {
          const on = selected.includes(ch.number);
          return (
            <button
              key={ch.number}
              type="button"
              onClick={() => toggle(ch.number)}
              title={`Chapter ${ch.number} — ${ch.title}`}
              aria-pressed={on}
              className={`rounded-full border px-2 py-0.5 ${
                on
                  ? "border-violet-400 bg-violet-100 text-violet-900 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200"
                  : "border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900"
              }`}
            >
              {ch.number} · {CHAPTER_SHORT[ch.number] ?? ch.title}
            </button>
          );
        })}
        {selected.length ? (
          <button type="button" onClick={() => setSelected([])} className="text-neutral-500 underline underline-offset-2">
            all chapters
          </button>
        ) : (
          <span className="text-neutral-400">all nine</span>
        )}
      </div>

      <form
        className="mt-2 flex gap-2"
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
