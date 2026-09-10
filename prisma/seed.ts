/* Seeds the Basic Law corpus (data/basic-law.en.json) into PostgreSQL. Run: npm run db:seed */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

type Corpus = {
  chapters: { number: string; title: string; sections: { number: number; title: string }[] }[];
  articles: {
    article: number;
    chapter: string;
    section: number | null;
    text: string;
    notes?: string[];
  }[];
  annexes: { annex: string; title: string; text: string }[];
};

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9 };

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  const corpus: Corpus = JSON.parse(readFileSync(resolve(__dirname, "../data/basic-law.en.json"), "utf8"));

  for (const ch of corpus.chapters) {
    await prisma.chapter.upsert({
      where: { number: ch.number },
      create: { number: ch.number, ordinal: ROMAN[ch.number], title: ch.title },
      update: { ordinal: ROMAN[ch.number], title: ch.title },
    });
    for (const s of ch.sections) {
      await prisma.section.upsert({
        where: { chapterNumber_number: { chapterNumber: ch.number, number: s.number } },
        create: { chapterNumber: ch.number, number: s.number, title: s.title },
        update: { title: s.title },
      });
    }
  }

  const sections = await prisma.section.findMany();
  const sectionId = (chapter: string, number: number | null) =>
    number == null ? null : (sections.find((s) => s.chapterNumber === chapter && s.number === number)?.id ?? null);

  for (const a of corpus.articles) {
    await prisma.article.upsert({
      where: { number: a.article },
      create: {
        number: a.article,
        chapterNumber: a.chapter,
        sectionId: sectionId(a.chapter, a.section),
        text: a.text,
        notes: a.notes ?? [],
      },
      update: { chapterNumber: a.chapter, sectionId: sectionId(a.chapter, a.section), text: a.text, notes: a.notes ?? [] },
    });
  }

  for (const x of corpus.annexes) {
    await prisma.annex.upsert({
      where: { id: x.annex },
      create: { id: x.annex, title: x.title, text: x.text },
      update: { title: x.title, text: x.text },
    });
  }

  const counts = {
    chapters: await prisma.chapter.count(),
    sections: await prisma.section.count(),
    articles: await prisma.article.count(),
    annexes: await prisma.annex.count(),
  };
  console.log("seeded", counts);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
