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
