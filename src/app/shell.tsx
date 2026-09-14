"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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

/* ------------------------------------------------------------------ types */

export type Mode = "ask" | "read" | "quiz" | "notes" | "eval";

export type ShellData = {
  conversationId: string;
  initialMessages: UIMessage[];
  chapters: { number: string; title: string; from: number | null; to: number | null }[];
  starters: string[];
  notes: { id: string; articleNumber: number | null; body: string }[];
  conversations: { id: string; label: string; count: number }[];
  counts: { articles: number; questions: number; annexes: number; toolCalls: number; ratings: number };
  quiz: { id: string; text: string; answer: number; options: { n: number; preview: string }[] }[];
  /**
   * State of the dense (vector) retrieval path, measured server-side. The two percentages are read from the
   * evaluation's own JSON and passed in rather than written into this file, so a notice about what is running can
   * never quote a number the benchmark no longer produces.
   */
  dense: {
    /**
     * How this deployment is *configured*. Deliberately not "is the model loaded": retrieval runs in another
     * serverless function, and each search reports its own live paths (`paths_run`, and the `vec` label on a hit).
     */
    enabled: boolean;
    /** What the retrieval function last reported about itself — an observation, not a setting. Null before any search. */
    observed: { ran: boolean; detail: string } | null;
    withVectors: string;
    withoutVectors: string;
    index: string | null;
  };
};

type ArticleView = {
  number: number;
  citation: string;
  chapter: string;
  section: string | null;
  text: string;
  notes: string[];
};

/* ------------------------------------------------------ shared type scales */

const serif = (size: number, weight = 600): CSSProperties => ({
  font: `${weight} ${size}px/1.25 'Noto Serif SC', serif`,
});
const sans = (size: number, weight = 400, lh = 1.6): CSSProperties => ({
  font: `${weight} ${size}px/${lh} 'Noto Sans SC', sans-serif`,
});
const mono = (size: number, weight = 400): CSSProperties => ({
  font: `${weight} ${size}px/1.4 'Geist Mono', ui-monospace, monospace`,
  letterSpacing: ".08em",
});

const MODES: { id: Mode; zh: string; en: string }[] = [
  { id: "ask", zh: "問答", en: "ASK" },
  { id: "read", zh: "讀條文", en: "READ" },
  { id: "quiz", zh: "自測", en: "QUIZ" },
  { id: "notes", zh: "筆記", en: "NOTES" },
  { id: "eval", zh: "評測", en: "EVAL" },
];

/** What the one side panel is called in each mode — it always names the thing it reveals. */
const PANEL_LABEL: Record<Mode, string> = {
  ask: "證據",
  read: "對照",
  quiz: "掌握度",
  notes: "標籤",
  eval: "部署",
};

/* --------------------------------------------------------- retrieval trace */

type Stage = { label: string; done: boolean };

/**
 * The retrieval trace, derived from the tool calls the agent actually made in this turn — not a scripted
 * animation. Each stage lights when its tool has been called, so what the reader watches is the real pipeline.
 */
/**
 * `on` contributed a hit · `off` ran and returned nothing that survived fusion · `down` was not running at all.
 * Keeping `down` separate is the point: a greyed-out `vec` that means "the model is not loaded here" and one that
 * means "vectors lost to full-text on this question" are different facts about the answer above it.
 */
type LaneState = "on" | "off" | "down";

function traceStages(message: UIMessage | undefined, busy: boolean): { stages: Stage[]; lanes: Record<string, LaneState> } {
  const called = new Set<string>();
  const lanes: Record<string, LaneState> = { qb: "off", fts: "off", vec: "off" };
  for (const part of message?.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    const p = part as unknown as { state: string; output?: unknown };
    const name = getToolName(part);
    called.add(name);
    if (p.state !== "output-available") continue;
    if (name === "search_articles") {
      const out = unwrapToolOutput(p.output) as
        | { hits?: { found_by?: string[] }[]; paths_run?: string[]; dense_path?: string }
        | undefined;
      // The tool says which of its paths were live; older outputs (before it reported that) have no such field, and
      // are left to the per-hit evidence rather than being reported as a path that was down.
      if (out?.paths_run && !out.paths_run.includes("dense")) lanes.vec = "down";
      for (const h of out?.hits ?? []) {
        for (const f of h.found_by ?? []) {
          if (f.includes("question bank")) lanes.qb = "on";
          if (f.startsWith("full-text")) lanes.fts = "on";
          if (f.startsWith("semantic")) lanes.vec = "on";
        }
      }
    }
    if (name === "find_questions") lanes.qb = "on";
  }
  const stages: Stage[] = [
    { label: "收到提問，準備檢索", done: true },
    { label: "推斷相關章節", done: called.has("suggest_topics") },
    { label: "比對 80 道學習題", done: called.has("find_questions") || lanes.qb === "on" },
    { label: "全文檢索與倒數排名融合", done: called.has("search_articles") },
    { label: "讀取命中條文全文", done: called.has("get_article") || called.has("get_articles") },
  ];
  if (!busy) for (const s of stages) s.done = s.done || false;
  return { stages, lanes };
}

/* ------------------------------------------------------------- small parts */

function Rule({ double = false }: { double?: boolean }) {
  return (
    <div
      style={{
        borderTop: double ? "3px double var(--rule2)" : "1px solid var(--rule)",
        margin: "10px 0",
      }}
    />
  );
}

function SectionHeading({ zh, en }: { zh: string; en?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <span style={{ ...serif(14, 600), letterSpacing: ".04em" }}>{zh}</span>
      {en ? <span style={{ ...mono(9.5), color: "var(--ink4)", textTransform: "uppercase" }}>{en}</span> : null}
    </div>
  );
}

const CHIP_TONE: Record<CitationStatus, CSSProperties> = {
  read: { borderColor: "var(--okrule)", background: "var(--okbg)", color: "var(--ok)" },
  retrieved: { borderColor: "var(--rule2)", background: "var(--sheet)", color: "var(--ink2)" },
  unverified: { borderColor: "var(--sealrule)", background: "var(--sealbg)", color: "var(--seal)" },
};

function pathMark(found: string[]): string | null {
  const marks = [
    found.some((f) => f.includes("question bank")) ? "qb" : null,
    found.some((f) => f.startsWith("full-text")) ? "fts" : null,
    found.some((f) => f.startsWith("semantic")) ? "vec" : null,
  ].filter(Boolean);
  return marks.length ? marks.join("·") : null;
}

/* ------------------------------------------------------------------- shell */

export function Shell(data: ShellData) {
  const router = useRouter();
  const hdrRef = useRef<HTMLElement | null>(null);

  // The pre-paint script in layout.tsx has already put the stored choice on <html>; read it back rather than
  // re-deciding here, so the button's label matches the page it is sitting on.
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document === "undefined" || document.documentElement.dataset.theme !== "dark" ? "light" : "dark",
  );
  const [mode, setMode] = useState<Mode>("ask");
  const [leftOverride, setLeftOverride] = useState<boolean | null>(null);
  const [rightOverride, setRightOverride] = useState<boolean | null>(null);
  const [notice, setNotice] = useState(true);
  const [rawJson, setRawJson] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ number: number; messageId: string | null; provenance?: ArticleProvenance } | null>(null);
  const [article, setArticle] = useState<ArticleView | null>(null);
  const [input, setInput] = useState("");
  const [chapters, setChapters] = useState<string[]>([]);

  /* The theme lives on <html>, not on this subtree, so /eval and /article/[n] stay in the same theme when the
     reader navigates to them. */
  const applyTheme = (next: "light" | "dark") => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("bl-theme", next);
    } catch {
      /* private mode: the toggle still works for this page load */
    }
  };

  /* The sticky header re-wraps by width and grows when the notice opens, so its height is measured, not assumed.
     Everything positioned under it reads --hdr. */
  useEffect(() => {
    const el = hdrRef.current;
    if (!el) return;
    const write = () =>
      document.documentElement.style.setProperty("--hdr", `${Math.round(el.getBoundingClientRect().height)}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { conversationId: data.conversationId } }),
    [data.conversationId],
  );
  const { messages, sendMessage, status, error, stop } = useChat({
    id: data.conversationId,
    transport,
    messages: data.initialMessages,
    onFinish: () => router.refresh(),
  });
  const busy = status === "submitted" || status === "streaming";

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const { stages, lanes } = traceStages(lastAssistant, busy);

  /* One rail at a time: three columns never fit, so each mode has a default and opening one closes the other. */
  const leftDefault = leftOverride ?? (mode === "read" || mode === "notes");
  const rightDefault = rightOverride ?? !(mode === "read" || mode === "notes");
  const go = (m: Mode) => {
    setMode(m);
    setLeftOverride(null);
    setRightOverride(null);
  };

  const open = useCallback((next: { number: number; messageId: string | null; provenance?: ArticleProvenance }) => {
    setFocus(next);
    setArticle(null);
  }, []);

  useEffect(() => {
    if (!focus) return;
    let cancelled = false;
    fetch(`/api/articles/${focus.number}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a: ArticleView | null) => !cancelled && setArticle(a))
      .catch(() => !cancelled && setArticle(null));
    return () => {
      cancelled = true;
    };
  }, [focus]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage({ text: t }, { body: { chapters } });
    setInput("");
    setMode("ask");
  };

  const railBox: CSSProperties = {
    position: "sticky",
    top: "var(--hdr)",
    maxHeight: "calc(100vh - var(--hdr))",
    flex: "0 0 auto",
    background: "var(--sheet)",
    border: "1px solid var(--rule)",
    padding: "14px 15px",
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--paper)", color: "var(--ink)" }}>
      <header
        ref={hdrRef}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "var(--paper)",
          borderBottom: "3px double var(--rule2)",
        }}
      >
        <div
          style={{
            maxWidth: 1560,
            margin: "0 auto",
            padding: "14px 26px 11px",
            display: "flex",
            alignItems: "flex-end",
            gap: 26,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-end", gap: 11, flex: "0 0 auto" }}>
            <span style={{ ...serif(31, 600), letterSpacing: ".06em", lineHeight: 1 }}>基本法研讀</span>
            <span
              style={{
                ...mono(10.5),
                letterSpacing: ".16em",
                color: "var(--ink3)",
                textTransform: "uppercase",
                paddingBottom: 3,
                lineHeight: 1.5,
              }}
            >
              Basic&nbsp;Law
              <br />
              Study&nbsp;Agent
            </span>
          </div>

          <nav
            style={{
              display: "flex",
              marginLeft: 6,
              border: "1px solid var(--rule2)",
              borderRadius: 2,
              overflow: "hidden",
              flex: "0 0 auto",
            }}
          >
            {MODES.map((m, i) => {
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => go(m.id)}
                  aria-pressed={on}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 1,
                    padding: "7px 15px 6px",
                    border: 0,
                    borderRight: i < MODES.length - 1 ? "1px solid var(--rule)" : undefined,
                    background: on ? "var(--ink)" : "transparent",
                    color: on ? "var(--paper)" : "var(--ink2)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ ...sans(13.5, 500, 1.2), color: "inherit" }}>{m.zh}</span>
                  <span style={{ ...mono(10.5), letterSpacing: ".11em", color: on ? "var(--paper)" : "var(--ink4)" }}>
                    {m.en}
                  </span>
                </button>
              );
            })}
          </nav>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setNotice((v) => !v)}
              style={{
                ...mono(10.5),
                padding: "5px 10px",
                border: "1px solid var(--rule2)",
                background: notice ? "var(--sheet2)" : "transparent",
                cursor: "pointer",
                color: "var(--ink2)",
              }}
            >
              免責聲明
            </button>
            <button
              type="button"
              onClick={() => (leftDefault ? setLeftOverride(false) : (setLeftOverride(true), setRightOverride(false)))}
              style={{
                ...mono(10.5),
                padding: "5px 10px",
                border: "1px solid var(--rule2)",
                background: leftDefault ? "var(--sheet2)" : "transparent",
                cursor: "pointer",
                color: "var(--ink2)",
              }}
            >
              條文樹
            </button>
            <button
              type="button"
              onClick={() => (rightDefault ? setRightOverride(false) : (setRightOverride(true), setLeftOverride(false)))}
              style={{
                ...mono(10.5),
                padding: "5px 10px",
                border: "1px solid var(--rule2)",
                background: rightDefault ? "var(--sheet2)" : "transparent",
                cursor: "pointer",
                color: "var(--ink2)",
              }}
            >
              {PANEL_LABEL[mode]}
            </button>
            <button
              type="button"
              onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
              style={{
                ...mono(10.5),
                padding: "5px 10px",
                border: "1px solid var(--rule2)",
                background: "transparent",
                cursor: "pointer",
                color: "var(--ink2)",
              }}
            >
              <span suppressHydrationWarning>{theme === "dark" ? "☾ 暗" : "☀ 亮"}</span>
            </button>
          </div>
        </div>

        {notice ? (
          <div style={{ borderTop: "1px solid var(--rule)", background: "var(--sealbg)" }}>
            <div style={{ maxWidth: 1560, margin: "0 auto", padding: "9px 26px", ...sans(11.5, 400, 1.65), color: "var(--seal)" }}>
              <strong style={{ fontWeight: 700 }}>本站是學習輔助，不是法律意見。</strong>
              　答案只依據《基本法》正文，可能不完整或有誤；具體事務請諮詢律師。每個回答都會列出讀過的條文，並把「答案提到、但工具從未返回」的條文標紅。
              條文正文為政府英文版小冊子原文，界面為中文。
            </div>
          </div>
        ) : null}
      </header>

      <div style={{ maxWidth: 1560, margin: "0 auto", padding: "18px 26px 40px", display: "flex", gap: 18, alignItems: "flex-start" }}>
        {leftDefault ? (
          <aside style={{ ...railBox, width: 230 }} data-scroll>
            <SectionHeading zh="條文樹" en="corpus" />
            <p style={{ ...sans(11, 400, 1.6), color: "var(--ink4)", margin: "0 0 10px" }}>
              {data.counts.articles} 條 · {data.counts.annexes} 附件 · {data.counts.questions} 學習題
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.chapters.map((c) => (
                <li key={c.number} style={{ marginBottom: 7 }}>
                  <a
                    href={c.from ? `/article/${c.from}` : "#"}
                    style={{ display: "block", ...sans(12, 400, 1.5), color: "var(--ink2)" }}
                  >
                    <span style={{ ...mono(10), color: "var(--ink4)", marginRight: 6 }}>{c.number}</span>
                    {c.title}
                    {c.from && c.to ? (
                      <span style={{ ...mono(9.5), color: "var(--ink4)", display: "block", marginLeft: 22 }}>
                        art. {c.from}–{c.to}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <main style={{ flex: "1 1 520px", minWidth: 0 }}>
          {mode === "ask" ? (
            <AskMode
              messages={messages}
              busy={busy}
              error={error?.message}
              stages={stages}
              starters={data.starters}
              input={input}
              setInput={setInput}
              submit={submit}
              stop={stop}
              chapters={chapters}
              setChapters={setChapters}
              allChapters={data.chapters}
              hover={hover}
              setHover={setHover}
              onOpen={open}
            />
          ) : null}
          {mode === "read" ? <ReadMode article={article} focus={focus} onOpen={open} chapters={data.chapters} /> : null}
          {mode === "quiz" ? <QuizMode quiz={data.quiz} onOpen={open} /> : null}
          {mode === "notes" ? <NotesMode notes={data.notes} conversations={data.conversations} current={data.conversationId} /> : null}
          {mode === "eval" ? <EvalMode dense={data.dense} counts={data.counts} /> : null}
        </main>

        {rightDefault ? (
          <aside style={{ ...railBox, width: 340 }} data-scroll>
            <SectionHeading zh={PANEL_LABEL[mode]} en={mode} />
            {mode === "ask" ? (
              <EvidenceRail
                message={lastAssistant}
                lanes={lanes}
                hover={hover}
                setHover={setHover}
                onOpen={open}
                rawJson={rawJson}
                setRawJson={setRawJson}
                article={article}
                focus={focus}
              />
            ) : null}
            {mode === "quiz" ? <MasteryRail counts={data.counts} /> : null}
            {mode === "eval" ? <DeployRail dense={data.dense} /> : null}
            {mode === "read" || mode === "notes" ? (
              <p style={{ ...sans(11.5, 400, 1.7), color: "var(--ink3)" }}>
                切換到「問答」後，這一欄會顯示每個答案讀過哪些條文、經由哪條檢索路徑找到。
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- ask mode */

function AskMode(props: {
  messages: UIMessage[];
  busy: boolean;
  error?: string;
  stages: Stage[];
  starters: string[];
  input: string;
  setInput: (v: string) => void;
  submit: (t: string) => void;
  stop: () => void;
  chapters: string[];
  setChapters: (v: string[]) => void;
  allChapters: { number: string; title: string }[];
  hover: number | null;
  setHover: (n: number | null) => void;
  onOpen: (f: { number: number; messageId: string | null; provenance?: ArticleProvenance }) => void;
}) {
  const { messages, busy, stages } = props;
  const toggle = (ch: string) =>
    props.setChapters(props.chapters.includes(ch) ? props.chapters.filter((c) => c !== ch) : [...props.chapters, ch]);

  return (
    <div>
      {messages.length === 0 ? (
        <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "18px 20px" }}>
          <SectionHeading zh="從題庫挑一題開始" en="starters" />
          <div style={{ display: "grid", gap: 8 }}>
            {props.starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => props.submit(s)}
                style={{
                  ...sans(12.5, 400, 1.55),
                  textAlign: "left",
                  padding: "10px 12px",
                  border: "1px solid var(--rule)",
                  background: "var(--paper)",
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {messages.map((m) => (
            <Turn key={m.id} message={m} hover={props.hover} setHover={props.setHover} onOpen={props.onOpen} />
          ))}
        </div>
      )}

      {busy ? <TracePanel stages={stages} /> : null}

      {props.error ? (
        <div
          style={{
            marginTop: 12,
            ...sans(12, 400, 1.6),
            color: "var(--seal)",
            background: "var(--sealbg)",
            border: "1px solid var(--sealrule)",
            padding: "10px 12px",
          }}
        >
          {props.error}
        </div>
      ) : null}

      <div style={{ marginTop: 16, background: "var(--sheet)", border: "1px solid var(--rule)", padding: "12px 14px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <span style={{ ...mono(9.5), color: "var(--ink4)", textTransform: "uppercase" }}>限定章節</span>
          {props.allChapters.map((c) => {
            const on = props.chapters.includes(c.number);
            return (
              <button
                key={c.number}
                type="button"
                onClick={() => toggle(c.number)}
                title={c.title}
                aria-pressed={on}
                style={{
                  ...mono(10),
                  padding: "3px 8px",
                  border: `1px solid ${on ? "var(--rule3)" : "var(--rule)"}`,
                  background: on ? "var(--ink)" : "transparent",
                  color: on ? "var(--paper)" : "var(--ink3)",
                  cursor: "pointer",
                }}
              >
                {c.number}
              </button>
            );
          })}
          {props.chapters.length ? (
            <button
              type="button"
              onClick={() => props.setChapters([])}
              style={{ ...mono(10), border: 0, background: "transparent", color: "var(--ink4)", cursor: "pointer", textDecoration: "underline" }}
            >
              全部九章
            </button>
          ) : (
            <span style={{ ...mono(10), color: "var(--ink4)" }}>全部九章</span>
          )}
        </div>
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            props.submit(props.input);
          }}
        >
          <input
            value={props.input}
            onChange={(e) => props.setInput(e.target.value)}
            placeholder="用自己的話問《基本法》…"
            style={{
              flex: 1,
              ...sans(13, 400, 1.5),
              padding: "9px 11px",
              border: "1px solid var(--rule2)",
              background: "var(--paper)",
              outline: "none",
            }}
          />
          {busy ? (
            <button
              type="button"
              onClick={props.stop}
              style={{ ...sans(12.5, 500, 1), padding: "9px 16px", border: "1px solid var(--rule2)", background: "transparent", cursor: "pointer" }}
            >
              停
            </button>
          ) : (
            <button
              type="submit"
              style={{ ...sans(12.5, 500, 1), padding: "9px 18px", border: "1px solid var(--rule3)", background: "var(--ink)", color: "var(--paper)", cursor: "pointer" }}
            >
              提問
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

/** The live pipeline, one row per stage, derived from the tools the agent has actually called this turn. */
function TracePanel({ stages }: { stages: Stage[] }) {
  const done = stages.filter((s) => s.done).length;
  return (
    <div style={{ marginTop: 14, background: "var(--sheet)", border: "1px solid var(--rule)", padding: "12px 14px" }} data-anim>
      <SectionHeading zh="檢索過程" en="trace" />
      <div style={{ height: 2, background: "var(--sunk)", marginBottom: 10 }}>
        <div style={{ height: 2, width: `${(done / stages.length) * 100}%`, background: "var(--seal)", transition: "width .3s ease" }} />
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
        {stages.map((s, i) => (
          <li key={i} data-lane={s.done ? "on" : "off"} style={{ ...sans(11.5, 400, 1.5), color: "var(--ink2)", display: "flex", gap: 8 }}>
            <span style={{ ...mono(10), color: s.done ? "var(--ok)" : "var(--ink4)" }}>{s.done ? "✓" : "·"}</span>
            {s.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Turn({
  message,
  hover,
  setHover,
  onOpen,
}: {
  message: UIMessage;
  hover: number | null;
  setHover: (n: number | null) => void;
  onOpen: (f: { number: number; messageId: string | null; provenance?: ArticleProvenance }) => void;
}) {
  const isUser = message.role === "user";
  const cites = isUser ? null : messageCitations(message);
  const chips = cites
    ? [...new Set([...cites.read, ...cites.mentioned])].sort((a, b) => a - b).map((n) => ({ n, p: cites.provenance[n] }))
    : [];
  const unverified = chips.filter((c) => citationStatus(c.p) === "unverified").length;

  if (isUser) {
    return (
      <div style={{ borderLeft: "3px solid var(--rule3)", paddingLeft: 14 }}>
        <div style={{ ...mono(9.5), color: "var(--ink4)", textTransform: "uppercase", marginBottom: 3 }}>你的提問</div>
        {message.parts.map((p, i) => (p.type === "text" ? <p key={i} style={{ ...serif(17, 500), margin: 0 }}>{p.text}</p> : null))}
      </div>
    );
  }

  return (
    <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "16px 18px" }} data-anim>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div
              key={i}
              className="prose prose-sm max-w-none prose-p:my-2 prose-li:my-0"
              style={{ ...sans(13.5, 400, 1.9), color: "var(--ink)" }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const p = part as unknown as { state: string };
          return (
            <div key={i} style={{ ...mono(10), color: "var(--ink4)", margin: "3px 0" }}>
              {getToolName(part)} · {p.state === "output-available" ? "done" : p.state === "output-error" ? "error" : "…"}
            </div>
          );
        }
        return null;
      })}

      {chips.length ? (
        <>
          <Rule />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span style={{ ...mono(9.5), color: "var(--ink4)", textTransform: "uppercase", marginRight: 2 }}>依據</span>
            {chips.map(({ n, p }) => {
              const st = citationStatus(p);
              const mark = pathMark(p?.found ?? []);
              const hot = hover === n;
              return (
                <button
                  key={n}
                  type="button"
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onOpen({ number: n, messageId: message.id, provenance: p })}
                  title={`${explainProvenance(n, p)}${p?.modelQuestions?.[0] ? `\n\n對應學習題：${p.modelQuestions[0]}` : ""}`}
                  style={{
                    ...mono(10.5),
                    padding: "2px 8px",
                    border: "1px solid",
                    cursor: "pointer",
                    ...CHIP_TONE[st],
                    ...(hot ? { background: "var(--mark)" } : {}),
                  }}
                >
                  art. {n}
                  {st === "unverified" ? " ⚠" : ""}
                  {mark ? <span style={{ opacity: 0.6 }}> {mark}</span> : null}
                </button>
              );
            })}
          </div>
          {unverified > 0 ? (
            <p style={{ ...sans(11, 400, 1.6), color: "var(--seal)", margin: "8px 0 0" }}>
              ⚠ 這個回答提到 {unverified} 條條文，但任何工具都沒有返回過它們 —— 當作未經查證。
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- evidence rail */

function EvidenceRail(props: {
  message: UIMessage | undefined;
  lanes: Record<string, LaneState>;
  hover: number | null;
  setHover: (n: number | null) => void;
  onOpen: (f: { number: number; messageId: string | null; provenance?: ArticleProvenance }) => void;
  rawJson: boolean;
  setRawJson: (v: boolean) => void;
  article: ArticleView | null;
  focus: { number: number; messageId: string | null; provenance?: ArticleProvenance } | null;
}) {
  const cites = props.message ? messageCitations(props.message) : null;
  const entries = cites
    ? Object.keys(cites.provenance)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => ({ n, p: cites.provenance[n] }))
    : [];

  if (!entries.length) {
    return (
      <p style={{ ...sans(11.5, 400, 1.7), color: "var(--ink3)" }}>
        還沒有答案。提問之後，這一欄會列出每條被檢索到的條文、它經由哪條路徑進入回答，以及是否被完整讀過。
      </p>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {(["qb", "fts", "vec"] as const).map((k) => {
          const state = props.lanes[k];
          return (
            <span
              key={k}
              data-lane={state}
              title={
                state === "down"
                  ? "這條路沒有在跑：檢索工具回報本次沒有向量路徑，結果只來自題庫與全文檢索"
                  : state === "on"
                    ? "這條路貢獻了至少一條命中"
                    : "這條路跑了，但沒有結果進入融合後的前幾名"
              }
              style={{
                ...mono(9.5),
                padding: "2px 7px",
                border: "1px solid var(--rule2)",
                color: "var(--ink2)",
                textDecoration: state === "down" ? "line-through" : "none",
              }}
            >
              {k}
            </span>
          );
        })}
      </div>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {entries.map(({ n, p }) => {
          const st = citationStatus(p);
          const hot = props.hover === n;
          return (
            <li
              key={n}
              onMouseEnter={() => props.setHover(n)}
              onMouseLeave={() => props.setHover(null)}
              style={{
                border: "1px solid var(--rule)",
                background: hot ? "var(--mark)" : "var(--paper)",
                padding: "8px 10px",
                cursor: "pointer",
              }}
              onClick={() => props.onOpen({ number: n, messageId: props.message?.id ?? null, provenance: p })}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ ...mono(11, 500), color: CHIP_TONE[st].color as string }}>art. {n}</span>
                <span style={{ ...mono(9.5), color: "var(--ink4)" }}>
                  {st === "read" ? "讀過全文" : st === "retrieved" ? "檢索到" : "未經查證"}
                </span>
              </div>
              {p?.modelQuestions?.[0] ? (
                <p style={{ ...sans(11, 400, 1.55), color: "var(--ink3)", margin: "4px 0 0" }}>「{p.modelQuestions[0]}」</p>
              ) : null}
              {p?.found?.length ? (
                <p style={{ ...mono(9.5), color: "var(--ink4)", margin: "4px 0 0" }}>{pathMark(p.found)}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {props.article && props.focus ? (
        <ArticleCard article={props.article} focus={props.focus} />
      ) : null}

      <Rule />
      <button
        type="button"
        onClick={() => props.setRawJson(!props.rawJson)}
        style={{ ...mono(10), border: 0, background: "transparent", color: "var(--ink3)", cursor: "pointer", textDecoration: "underline", padding: 0 }}
      >
        {props.rawJson ? "收起原始 JSON" : "看原始 JSON"}
      </button>
      {props.rawJson ? (
        <pre
          style={{
            ...mono(9.5),
            marginTop: 8,
            maxHeight: 260,
            overflow: "auto",
            background: "var(--sunk)",
            padding: 8,
            whiteSpace: "pre-wrap",
            color: "var(--ink2)",
          }}
        >
          {JSON.stringify(cites?.provenance ?? {}, null, 1)}
        </pre>
      ) : null}
    </div>
  );
}

/** The opened article, with the passage retrieval matched on and the 0-5 relevance judgement. */
function ArticleCard({
  article,
  focus,
}: {
  article: ArticleView;
  focus: { number: number; messageId: string | null; provenance?: ArticleProvenance };
}) {
  return (
    <div style={{ marginTop: 12, border: "1px solid var(--okrule)", background: "var(--okbg)", padding: "10px 12px" }} data-anim>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ ...mono(10.5, 500), color: "var(--ok)" }}>{article.citation}</span>
        <a href={`/article/${article.number}`} style={{ ...mono(9.5), color: "var(--ink4)", marginLeft: "auto" }}>
          ↗
        </a>
      </div>
      {focus.provenance?.modelQuestions?.[0] ? (
        <p style={{ ...sans(10.5, 400, 1.55), color: "var(--ink3)", margin: "0 0 6px" }}>
          對應學習題：「{focus.provenance.modelQuestions[0]}」
        </p>
      ) : null}
      <p lang="en" style={{ ...sans(11.5, 400, 1.8), color: "var(--ink)", margin: 0, whiteSpace: "pre-wrap" }}>
        {article.text}
      </p>
      {focus.provenance?.excerpt ? (
        <details style={{ marginTop: 6 }}>
          <summary style={{ ...mono(9.5), color: "var(--ink3)", cursor: "pointer" }}>檢索匹配到的段落</summary>
          <p
            lang="en"
            style={{ ...sans(10.5, 400, 1.7), color: "var(--ink2)", margin: "5px 0 0" }}
            dangerouslySetInnerHTML={{
              __html: focus.provenance.excerpt.replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>"),
            }}
          />
          <p style={{ ...sans(10, 400, 1.6), color: "var(--ink4)", margin: "4px 0 0" }}>
            這是檢索匹配到的段落，不是答案本身。
          </p>
        </details>
      ) : null}
      {focus.messageId ? <Rating key={`${focus.messageId}:${article.number}`} messageId={focus.messageId} article={article.number} /> : null}
    </div>
  );
}

function Rating({ messageId, article }: { messageId: string; article: number }) {
  const [value, setValue] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

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
    <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px solid var(--okrule)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
      <span style={{ ...sans(10.5, 400, 1.4), color: "var(--ink3)" }}>這條對你的問題有用嗎？</span>
      {[0, 1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => void save(v)}
          aria-pressed={value === v}
          style={{
            ...mono(10),
            width: 21,
            height: 21,
            border: "1px solid var(--rule2)",
            background: value === v ? "var(--ok)" : "transparent",
            color: value === v ? "var(--paper)" : "var(--ink2)",
            cursor: "pointer",
          }}
        >
          {v}
        </button>
      ))}
      <span style={{ ...mono(9.5), color: "var(--ink4)" }}>
        {state === "saving" ? "保存中…" : state === "saved" ? "已保存" : "0 = 無關，5 = 正是"}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- read mode */

function ReadMode({
  article,
  focus,
  onOpen,
  chapters,
}: {
  article: ArticleView | null;
  focus: { number: number; messageId: string | null } | null;
  onOpen: (f: { number: number; messageId: string | null }) => void;
  chapters: { number: string; title: string; from: number | null; to: number | null }[];
}) {
  const n = focus?.number ?? null;
  return (
    <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "18px 22px" }}>
      <SectionHeading zh="讀條文" en="read" />
      {!article ? (
        <div>
          <p style={{ ...sans(12, 400, 1.7), color: "var(--ink3)" }}>從左邊的條文樹選一章，或直接輸入條號。</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {chapters.map((c) =>
              c.from ? (
                <button
                  key={c.number}
                  type="button"
                  onClick={() => onOpen({ number: c.from!, messageId: null })}
                  style={{ ...mono(10), padding: "4px 9px", border: "1px solid var(--rule2)", background: "transparent", cursor: "pointer", color: "var(--ink2)" }}
                >
                  {c.number} · art. {c.from}
                </button>
              ) : null,
            )}
          </div>
        </div>
      ) : (
        <article>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <h2 style={{ ...serif(22, 600), margin: 0 }}>{article.citation}</h2>
            <span style={{ ...sans(11, 400, 1.5), color: "var(--ink4)" }}>
              {article.chapter}
              {article.section ? ` · ${article.section}` : ""}
            </span>
          </div>
          <p lang="en" style={{ ...sans(14, 400, 2), whiteSpace: "pre-wrap", margin: 0 }}>
            {article.text}
          </p>
          {article.notes.length ? (
            <>
              <Rule />
              <ul style={{ ...sans(11, 400, 1.7), color: "var(--ink3)", margin: 0, paddingLeft: 16 }}>
                {article.notes.map((x, i) => (
                  <li key={i} lang="en">
                    {x}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Rule />
          <div style={{ display: "flex", gap: 8 }}>
            {n && n > 1 ? (
              <button type="button" onClick={() => onOpen({ number: n - 1, messageId: null })} style={{ ...mono(10), border: "1px solid var(--rule2)", background: "transparent", padding: "4px 10px", cursor: "pointer", color: "var(--ink2)" }}>
                ‹ 上一條
              </button>
            ) : null}
            {n && n < 160 ? (
              <button type="button" onClick={() => onOpen({ number: n + 1, messageId: null })} style={{ ...mono(10), border: "1px solid var(--rule2)", background: "transparent", padding: "4px 10px", cursor: "pointer", marginLeft: "auto", color: "var(--ink2)" }}>
                下一條 ›
              </button>
            ) : null}
          </div>
        </article>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- quiz mode */

function QuizMode({
  quiz,
  onOpen,
}: {
  quiz: { id: string; text: string; answer: number; options: { n: number; preview: string }[] }[];
  onOpen: (f: { number: number; messageId: string | null }) => void;
}) {
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const q = quiz[i];

  if (!q) return <p style={{ ...sans(12, 400, 1.7), color: "var(--ink3)" }}>題庫還沒載入。</p>;

  const correct = pick === q.answer;
  return (
    <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "18px 22px" }}>
      <SectionHeading zh="自測" en="quiz" />
      <p style={{ ...mono(9.5), color: "var(--ink4)", margin: "0 0 6px" }}>{q.id}</p>
      <p style={{ ...serif(18, 500), margin: "0 0 14px" }}>{q.text}</p>
      <div style={{ display: "grid", gap: 7 }}>
        {q.options.map(({ n, preview }) => {
          const chosen = pick === n;
          const tone = !chosen ? null : n === q.answer ? "ok" : "bad";
          return (
            <button
              key={n}
              type="button"
              onClick={() => setPick(n)}
              style={{
                ...sans(12.5, 400, 1.5),
                textAlign: "left",
                padding: "9px 12px",
                border: "1px solid var(--rule)",
                background: tone === "ok" ? "var(--okbg)" : tone === "bad" ? "var(--sealbg)" : "var(--paper)",
                boxShadow: tone === "ok" ? "inset 3px 0 0 var(--ok)" : tone === "bad" ? "inset 3px 0 0 var(--seal)" : undefined,
                cursor: "pointer",
              }}
            >
              <span style={{ ...mono(10.5), color: "var(--ink4)", marginRight: 8 }}>art. {n}</span>
              {/* The option has to be answerable: a bare article number is a memory test, not a comprehension one. */}
              <span lang="en" style={{ color: "var(--ink2)" }}>{preview}</span>
            </button>
          );
        })}
      </div>
      {pick != null ? (
        <p style={{ ...sans(12, 500, 1.6), color: correct ? "var(--ok)" : "var(--seal)", marginTop: 12 }} data-anim>
          {correct
            ? `✓ 對了 —— 正解是第 ${q.answer} 條，題庫為 ${q.id} 標注的答案。`
            : `✗ 你選了第 ${pick} 條；正解是第 ${q.answer} 條。`}{" "}
          <button
            type="button"
            onClick={() => onOpen({ number: q.answer, messageId: null })}
            style={{ ...mono(10), border: 0, background: "transparent", color: "inherit", textDecoration: "underline", cursor: "pointer" }}
          >
            讀第 {q.answer} 條
          </button>
        </p>
      ) : null}
      <Rule />
      <button
        type="button"
        onClick={() => {
          setPick(null);
          setI((v) => (v + 1) % quiz.length);
        }}
        style={{ ...sans(12, 500, 1), padding: "7px 16px", border: "1px solid var(--rule3)", background: "var(--ink)", color: "var(--paper)", cursor: "pointer" }}
      >
        下一題
      </button>
    </div>
  );
}

function MasteryRail({ counts }: { counts: ShellData["counts"] }) {
  return (
    <div>
      <p style={{ ...sans(11.5, 400, 1.7), color: "var(--ink3)", marginTop: 0 }}>
        題庫共 {counts.questions} 題，每題都標注了答案所在的條文。自測直接用這份標注判分 —— 和離線檢索評測用的是同一份真值。
      </p>
      <Rule />
      <p style={{ ...sans(11, 400, 1.7), color: "var(--ink4)" }}>
        讀者已在本站給出 {counts.ratings} 條相關性評分，聚合在「評測」頁。
      </p>
    </div>
  );
}

/* ------------------------------------------------------- notes / eval mode */

function NotesMode({
  notes,
  conversations,
  current,
}: {
  notes: ShellData["notes"];
  conversations: ShellData["conversations"];
  current: string;
}) {
  return (
    <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "18px 22px" }}>
      <SectionHeading zh="筆記" en="notes" />
      {notes.length === 0 ? (
        <p style={{ ...sans(12, 400, 1.7), color: "var(--ink3)" }}>還沒有筆記。在問答裡對助手說「幫我記一條…」即可。</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {notes.map((n) => (
            <li key={n.id} style={{ border: "1px solid var(--rule)", background: "var(--paper)", padding: "9px 11px", ...sans(12, 400, 1.6) }}>
              {n.articleNumber ? <span style={{ ...mono(10), color: "var(--ink4)", marginRight: 7 }}>art. {n.articleNumber}</span> : null}
              {n.body}
            </li>
          ))}
        </ul>
      )}
      <Rule double />
      <SectionHeading zh="對話" en="threads" />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
        {conversations.map((c) => (
          <li key={c.id}>
            <a
              href={`/?c=${c.id}`}
              style={{
                display: "block",
                ...sans(11.5, c.id === current ? 500 : 400, 1.5),
                color: c.id === current ? "var(--ink)" : "var(--ink3)",
                padding: "3px 0",
              }}
            >
              {c.label || "（空）"} <span style={{ ...mono(9.5), color: "var(--ink4)" }}>· {c.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvalMode({ dense, counts }: { dense: ShellData["dense"]; counts: ShellData["counts"] }) {
  return (
    <div style={{ background: "var(--sheet)", border: "1px solid var(--rule)", padding: "18px 22px" }}>
      <SectionHeading zh="評測" en="eval" />
      <p style={{ ...sans(12.5, 400, 1.85), margin: "0 0 12px" }}>
        回答的好壞，先取決於交給模型的是不是對的條文。80 道學習題各有兩個改寫：改寫一用來調參（dev），改寫二從不看（test）。
        完整的表在評測頁，含每一條漏檢。
      </p>
      <a
        href="/eval"
        style={{ ...sans(12.5, 500, 1), display: "inline-block", padding: "8px 16px", border: "1px solid var(--rule3)", background: "var(--ink)", color: "var(--paper)" }}
      >
        打開評測頁 →
      </a>
      {dense.enabled && dense.observed?.ran !== false ? null : (
        <p style={{ ...sans(11.5, 400, 1.7), color: "var(--seal)", background: "var(--sealbg)", border: "1px solid var(--sealrule)", padding: "9px 11px", marginTop: 14 }}>
          {dense.enabled ? (
            <>
              設定是開的，但<strong>檢索行程最近一次實跑沒能載入向量模型</strong>（<span lang="en">{dense.observed?.detail}</span>）。
            </>
          ) : (
            <>
              這個部署關閉了向量檢索（<code style={mono(10)}>DENSE_RETRIEVAL=off</code>）。
            </>
          )}{" "}
          所以跑的是「題庫 + 全文檢索」那條管線，test 集 primary@5 為 <strong>{dense.withoutVectors}</strong>，不是表裡的{" "}
          {dense.withVectors}。
        </p>
      )}
      <Rule />
      <p style={{ ...sans(11, 400, 1.7), color: "var(--ink4)" }}>
        語料 {counts.articles} 條 · {counts.questions} 學習題 · 讀者評分 {counts.ratings} 條 · 本對話工具調用 {counts.toolCalls} 次
      </p>
    </div>
  );
}

function DeployRail({ dense }: { dense: ShellData["dense"] }) {
  return (
    <div style={{ ...sans(11.5, 400, 1.75), color: "var(--ink3)" }}>
      <p style={{ marginTop: 0 }}>
        Next.js 於 Vercel（函式固定 <code style={mono(10)}>sin1</code>），PostgreSQL 於 Supabase <code style={mono(10)}>ap-southeast-1</code> —— 同區，因為每一輪要往返資料庫數次。
      </p>
      <Rule />
      <p>MCP 服務端在 <code style={mono(10)}>/api/mcp</code>，七個工具，任何 MCP 客戶端可直接連。</p>
      <Rule />
      <p>
        {dense.enabled && dense.observed?.ran === false ? (
          <>向量檢索：設定開著，但檢索行程實跑時載入不了模型 —— <span lang="en">{dense.observed.detail}</span></>
        ) : dense.enabled ? (
          <>
            向量檢索：{dense.observed?.ran ? "實跑確認開啟" : "已啟用（尚無實跑記錄）"} —— 模型隨部署打包（
            <code style={mono(10)}>models/</code>），請求路徑上不向 huggingface.co 取任何檔案
            {dense.index ? (
              <>
                。索引 <span lang="en">{dense.index}</span>
              </>
            ) : null}
            。每一次檢索到底有沒有跑向量，看那次結果上的 <code style={mono(10)}>vec</code> 標籤 —— 檢索工具每次都會回報哪幾條路是活的，並把結果記下來給這一行用。
          </>
        ) : (
          "向量檢索：關閉"
        )}
      </p>
    </div>
  );
}
