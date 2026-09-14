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

/**
 * How one article ended up in the answer.
 *
 * `found` is the audit trail that matters: an article the assistant names while `found` is empty and `read` is
 * false was never retrieved by any tool, i.e. the model produced the number from memory. The UI flags those.
 */
export type ArticleProvenance = {
  /** The agent read the full text (get_article / get_articles). */
  read: boolean;
  /** The assistant named it in the answer text ("Article 24", "Art. 24(2)"). */
  mentioned: boolean;
  /** Retrieval paths that surfaced it, in call order, e.g. "question bank (qb-055)", "full-text search (loose)". */
  found: string[];
};

/** Verdict for one article chip: read in full, surfaced by retrieval only, or named without any lookup. */
export type CitationStatus = "read" | "retrieved" | "unverified";

export type MessageCitations = {
  /** Articles whose full text the agent read (get_article / get_articles). */
  read: number[];
  /** Articles the assistant named in its answer ("Article 24", "Art. 24(2)"). */
  mentioned: number[];
  /** Article number → how it got there. Includes retrieval hits the answer never used. */
  provenance: Record<number, ArticleProvenance>;
  /** Tool-call counts for the trace line. */
  toolCalls: number;
  mcpCalls: number;
};

const inRange = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 160;

/** Human-readable retrieval paths for one search hit. Hybrid hits carry `found_by`; older shapes carry `match`. */
function searchLabels(hit: { match?: string; found_by?: string[] }): string[] {
  const NAMES: Record<string, string> = {
    "question bank": "the question bank",
    "full-text": "full-text search",
    semantic: "semantic search",
  };
  if (hit.found_by?.length) return hit.found_by.map((s) => NAMES[s] ?? s);
  if (hit.match === "strict" || hit.match === "loose") return [`full-text search (${hit.match})`];
  if (hit.match === "dense") return ["semantic search"];
  return ["full-text search"];
}

/** Derive citation chips, retrieval provenance and trace counts for one assistant message, purely from its UI parts. */
export function messageCitations(message: UIMessage): MessageCitations {
  const provenance: Record<number, ArticleProvenance> = {};
  const entry = (n: number) => (provenance[n] ??= { read: false, mentioned: false, found: [] });
  const addFound = (n: number, label: string) => {
    const e = entry(n);
    if (!e.found.includes(label)) e.found.push(label);
  };

  let toolCalls = 0;
  let mcpCalls = 0;

  for (const part of message.parts as UIMessagePart<never, never>[]) {
    if (part.type === "text") {
      for (const m of part.text.matchAll(/\bArt(?:icle|\.)\s*(\d{1,3})\b/gi)) {
        const n = Number(m[1]);
        if (inRange(n)) entry(n).mentioned = true;
      }
      continue;
    }
    if (!isToolUIPart(part)) continue;
    toolCalls++;
    const p = part as unknown as { type: string; state: string; output?: unknown };
    if (p.type === "dynamic-tool") mcpCalls++;
    if (p.state !== "output-available") continue;

    const name = getToolName(part);
    const out = unwrapToolOutput(p.output) as
      | {
          article?: number;
          articles?: { article?: number }[];
          hits?: { article?: number; match?: string; found_by?: string[] }[];
          questions?: { id?: string; articles?: number[] }[];
        }
      | undefined;
    if (!out) continue;

    if (name === "get_article" || name === "get_articles") {
      if (inRange(out.article)) entry(out.article).read = true;
      for (const a of out.articles ?? []) if (inRange(a?.article)) entry(a.article!).read = true;
      continue;
    }
    if (name === "search_articles") {
      for (const h of out.hits ?? []) {
        if (!inRange(h?.article)) continue;
        for (const label of searchLabels(h)) addFound(h.article!, label);
      }
      continue;
    }
    if (name === "find_questions") {
      for (const q of out.questions ?? []) {
        const label = q?.id ? `question bank (${q.id})` : "question bank";
        for (const n of q?.articles ?? []) if (inRange(n)) addFound(n, label);
      }
    }
  }

  const numbers = Object.keys(provenance).map(Number);
  return {
    read: numbers.filter((n) => provenance[n].read).sort((a, b) => a - b),
    mentioned: numbers.filter((n) => provenance[n].mentioned).sort((a, b) => a - b),
    provenance,
    toolCalls,
    mcpCalls,
  };
}

/** Chip verdict for one article: read in full > surfaced by retrieval > named with no lookup at all. */
export function citationStatus(p: ArticleProvenance | undefined): CitationStatus {
  if (p?.read) return "read";
  if (p?.found.length) return "retrieved";
  return "unverified";
}

/** One-line explanation of a chip, shown as its tooltip. */
export function explainProvenance(n: number, p: ArticleProvenance | undefined): string {
  const via = p?.found.length ? `Found via ${p.found.join(", then ")}.` : "";
  switch (citationStatus(p)) {
    case "read":
      return `The agent read the full text of Article ${n}. ${via}`.trim();
    case "retrieved":
      return `Article ${n} was surfaced by retrieval but its full text was not read. ${via}`.trim();
    default:
      return `Article ${n} is named in the answer but was never returned by a tool — treat it as unverified.`;
  }
}
