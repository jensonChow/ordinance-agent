import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Create a conversation. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const conversation = await prisma.conversation.create({ data: { title: body.title ?? null } });
  return NextResponse.json(conversation, { status: 201 });
}

/** List recent conversations with message counts. */
export async function GET() {
  const rows = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 20,
    include: { _count: { select: { messages: true } } },
  });
  return NextResponse.json(rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, messages: r._count.messages })));
}
