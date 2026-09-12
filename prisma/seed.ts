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

/** Phrases repeated in almost every article; removed from the loose-search text so they stop dominating ranking. */
const BOILERPLATE = [
  /of the Hong Kong Special Administrative Region/gi,
  /Hong Kong Special Administrative Region/gi,
  /of the People[’']s Republic of China/gi,
  /People[’']s Republic of China/gi,
];
const searchText = (text: string) => BOILERPLATE.reduce((t, re) => t.replace(re, " "), text).replace(/\s+/g, " ").trim();

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
        searchText: searchText(a.text),
        notes: a.notes ?? [],
      },
      update: { chapterNumber: a.chapter, sectionId: sectionId(a.chapter, a.section), text: a.text, searchText: searchText(a.text), notes: a.notes ?? [] },
    });
  }

  for (const x of corpus.annexes) {
    await prisma.annex.upsert({
      where: { id: x.annex },
      create: { id: x.annex, title: x.title, text: x.text },
      update: { title: x.title, text: x.text },
    });
  }

  const bank: { questions: { id: string; question: string; variants: string[]; articles: number[]; tags: string[] }[] } = JSON.parse(
    readFileSync(resolve(__dirname, "../data/question-bank.json"), "utf8"),
  );
  for (const q of bank.questions) {
    await prisma.question.upsert({
      where: { id: q.id },
      create: { id: q.id, text: q.question, variants: q.variants, articles: q.articles, tags: q.tags, searchText: `${q.question} ${q.tags.join(" ")}` },
      update: { text: q.question, variants: q.variants, articles: q.articles, tags: q.tags, searchText: `${q.question} ${q.tags.join(" ")}` },
    });
  }

  const counts = {
    questions: await prisma.question.count(),
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
