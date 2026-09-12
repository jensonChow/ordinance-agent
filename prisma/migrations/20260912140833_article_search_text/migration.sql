-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '';

-- Loose full-text search index over the de-boilerplated article text (src/lib/law.ts searchArticlesLoose).
CREATE INDEX IF NOT EXISTS "Article_searchText_fts_idx"
  ON "Article" USING GIN (to_tsvector('english', "searchText"));
