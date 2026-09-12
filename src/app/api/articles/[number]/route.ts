import { NextResponse } from "next/server";
import { formatCitation, getArticle } from "@/lib/law";

export const runtime = "nodejs";

/** One article as JSON — used by the chat UI's article panel when a citation chip is clicked. */
export async function GET(_req: Request, ctx: { params: Promise<{ number: string }> }) {
  const { number } = await ctx.params;
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 160) return NextResponse.json({ error: "article must be 1–160" }, { status: 400 });
  const a = await getArticle(n);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    number: a.number,
    citation: formatCitation(a.number),
    chapter: `${a.chapter.number} ${a.chapter.title}`,
    section: a.section ? `Section ${a.section.number} ${a.section.title}` : null,
    text: a.text,
    notes: a.notes,
  });
}
