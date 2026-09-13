// Pure string helpers shared by the search layer, the MCP server and the tests. No database, no side effects.

/**
 * Words that appear in almost every article ("Basic Law", "Hong Kong", "Region", "government", "law" …) carry no
 * signal for loose matching and let short generic articles outrank the relevant one, so loose queries drop them.
 * Strict (websearch) queries are left exactly as the caller wrote them.
 */
const DOMAIN_STOP_PHRASES = [
  "hong kong special administrative region", "special administrative region", "people's republic of china", "people’s republic of china",
  "basic law", "hong kong", "hksar", "the region", "region", "government", "governments", "laws", "law", "legal",
  "article", "articles", "provision", "provisions", "does", "say", "says", "mention", "what", "which", "who", "how", "can", "may", "must",
];
export function stripDomainStopwords(query: string): string {
  let q = ` ${query.toLowerCase().replace(/[’']s\b/g, "").replace(/[?!.,;:"()]/g, " ")} `;
  for (const phrase of DOMAIN_STOP_PHRASES) q = q.split(` ${phrase} `).join(" ");
  q = q.replace(/\s+/g, " ").trim();
  return q || query;
}

export function formatCitation(article: number, paragraph?: number | null) {
  return paragraph ? `Basic Law, art. ${article}(${paragraph})` : `Basic Law, art. ${article}`;
}

export type ParsedCitation = { article: number; paragraph: number | null; raw: string };

/** "Article", "Articles", "art.", "arts", "BL" — immediately followed by a number. */
const LEAD_IN = /\b(?:articles?|arts?\.?|bl)\.?\s*(?=\d)/gi;
/** A number with an optional paragraph in brackets: 24, 24(2). */
const NUMBER = /^(\d{1,3})(?:\s*\((\d{1,2})\))?/;
/** What may join two numbers in one citation chain: "24, 39 and 45", "24 to 27". */
const SEPARATOR = /^\s*(?:,\s*)?(and|to|through|,|-|–|—)\s*(?=\d)/i;
const RANGE = /^(to|through|-|–|—)$/i;

/**
 * Pull Basic Law citations out of free text: "see BL art 24(2), Articles 39 and 41, and Articles 45 to 47".
 *
 * Deliberately lexical and small — the same rules are implemented in services/citation-py so the Python service
 * and the local fallback agree. Numbers outside 1–160 are dropped; results are de-duplicated on article+paragraph.
 */
export function parseCitations(input: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  const seen = new Set<string>();
  const push = (article: number, paragraph: number | null, raw: string) => {
    if (!Number.isInteger(article) || article < 1 || article > 160) return;
    const key = `${article}:${paragraph ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ article, paragraph, raw });
  };

  for (const lead of input.matchAll(LEAD_IN)) {
    let cursor = lead.index! + lead[0].length;
    let previous: number | null = null;
    let connector: string | null = null;
    for (;;) {
      const rest = input.slice(cursor);
      const num = NUMBER.exec(rest);
      if (!num) break;
      const article = Number(num[1]);
      const paragraph = num[2] ? Number(num[2]) : null;
      if (previous !== null && connector && RANGE.test(connector) && article > previous) {
        for (let n = previous + 1; n < article; n++) push(n, null, `${previous}–${article}`);
      }
      push(article, paragraph, num[0].trim());
      previous = article;
      cursor += num[0].length;
      const sep = SEPARATOR.exec(input.slice(cursor));
      if (!sep) break;
      connector = sep[1];
      cursor += sep[0].length;
    }
  }
  return out;
}
