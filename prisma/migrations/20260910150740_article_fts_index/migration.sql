-- Full-text search index over article text (used by src/lib/law.ts searchArticles).
CREATE INDEX IF NOT EXISTS "Article_text_fts_idx"
  ON "Article" USING GIN (to_tsvector('english', "text"));
