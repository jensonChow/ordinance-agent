-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "variants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "articles" INTEGER[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "searchText" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- Full-text index over question text + tags ("searchText", filled by the seed) — used by src/lib/law.ts searchQuestions.
CREATE INDEX IF NOT EXISTS "Question_searchText_fts_idx"
  ON "Question" USING GIN (to_tsvector('english', "searchText"));
