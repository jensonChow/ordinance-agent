import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * A reader's 0-5 relevance judgement on one cited article, upserted so re-scoring replaces the previous value.
 *
 * The AI CLIC Recommender asks the same question under every recommendation it makes. Collecting it here is what
 * lets /eval put human judgements next to the offline question-bank benchmark: the benchmark measures whether
 * retrieval finds the article the bank says is right, this measures whether a reader agreed it was useful.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { messageId?: unknown; article?: unknown; value?: unknown } | null;
  const messageId = typeof body?.messageId === "string" ? body.messageId : null;
  const article = Number(body?.article);
  const value = Number(body?.value);

  if (!messageId || !Number.isInteger(article) || !Number.isInteger(value)) {
    return NextResponse.json({ error: "messageId, article and value are required" }, { status: 400 });
  }
  if (value < 0 || value > 5) return NextResponse.json({ error: "value must be 0-5" }, { status: 400 });
  if (article < 1 || article > 160) return NextResponse.json({ error: "article must be 1-160" }, { status: 400 });

  // Rate only an answer that was actually persisted, so a rating can never point at a message nobody can reread.
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  if (!message) return NextResponse.json({ error: "unknown message" }, { status: 404 });

  const rating = await prisma.rating.upsert({
    where: { messageId_articleNumber: { messageId, articleNumber: article } },
    create: { messageId, articleNumber: article, value },
    update: { value },
  });
  return NextResponse.json({ ok: true, article, value: rating.value });
}

/** The scores already given inside one answer, so the stars come back filled in after a reload. */
export async function GET(req: Request) {
  const messageId = new URL(req.url).searchParams.get("messageId");
  if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  const rows = await prisma.rating.findMany({ where: { messageId }, select: { articleNumber: true, value: true } });
  return NextResponse.json({ ratings: Object.fromEntries(rows.map((r) => [r.articleNumber, r.value])) });
}
