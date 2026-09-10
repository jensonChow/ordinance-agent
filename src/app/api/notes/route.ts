import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const notes = await prisma.note.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json(notes);
}
