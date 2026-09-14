-- Load the vector index into a hosted PostgreSQL that this machine cannot reach on port 5432.
--
--   1. npm run embed && npm run embed:export     -- writes data/embeddings.json
--   2. commit and push (the repository is public, which is what makes step 3 possible)
--   3. run this file against the hosted database, with :ref set to the pushed commit
--
-- Run it with a commit SHA rather than a branch name, so what the database loaded is a fixed thing you can go back
-- and look at:
--
--   psql "$DATABASE_URL" -v ref=3702a34 -f deploy/supabase/load-embeddings.sql
--
-- Requires the `http` extension (Supabase: create extension http with schema extensions). The corpus itself was
-- loaded the same way — see the Deploy section of the README.
--
-- The refusals below are the point of the file. An index that does not match the corpus it was computed from, or
-- that was built by a different model than the one the deployment loads, does not fail: it returns five plausible
-- articles that are quietly worse than the right ones. Both cases abort here instead.

\set ON_ERROR_STOP on
\if :{?ref}
\else
  \set ref 'main'
\endif

BEGIN;

CREATE TEMP TABLE payload AS
SELECT (extensions.http_get(
  'https://raw.githubusercontent.com/jensonChow/ordinance-agent/' || :'ref' || '/data/embeddings.json'
)).content::jsonb AS j;

DO $$
DECLARE
  p          jsonb := (SELECT j FROM payload);
  a_digest   text;
  q_digest   text;
  n_articles int;
  n_questions int;
BEGIN
  IF p IS NULL THEN
    RAISE EXCEPTION 'the embeddings file could not be fetched';
  END IF;

  IF p->>'dims' <> '384' THEN
    RAISE EXCEPTION 'file says dims=%, this schema stores 384', p->>'dims';
  END IF;

  -- Exactly the construction in scripts/export-embeddings.ts: key, newline, text; rows joined by a blank line.
  SELECT encode(sha256(convert_to(string_agg(number::text || E'\n' || text, E'\n\n' ORDER BY number), 'utf8')), 'hex')
    INTO a_digest FROM "Article";
  SELECT encode(sha256(convert_to(string_agg(id || E'\n' || text, E'\n\n' ORDER BY id), 'utf8')), 'hex')
    INTO q_digest FROM "Question";

  IF a_digest <> p->>'articleDigest' THEN
    RAISE EXCEPTION 'article text here does not match what these vectors were computed from (% vs %)',
      left(a_digest, 12), left(p->>'articleDigest', 12);
  END IF;
  IF q_digest <> p->>'questionDigest' THEN
    RAISE EXCEPTION 'question text here does not match what these vectors were computed from (% vs %)',
      left(q_digest, 12), left(p->>'questionDigest', 12);
  END IF;

  UPDATE "Article" a
     SET embedding = (
       SELECT array_agg(e.v::text::float8 ORDER BY e.ord)
         FROM jsonb_array_elements((p->'articles')->(a.number::text)) WITH ORDINALITY AS e(v, ord)
     )
   WHERE (p->'articles') ? a.number::text;

  UPDATE "Question" q
     SET embedding = (
       SELECT array_agg(e.v::text::float8 ORDER BY e.ord)
         FROM jsonb_array_elements((p->'questions')->q.id) WITH ORDINALITY AS e(v, ord)
     )
   WHERE (p->'questions') ? q.id;

  SELECT count(*) INTO n_articles  FROM "Article"  WHERE cardinality(embedding) = 384;
  SELECT count(*) INTO n_questions FROM "Question" WHERE cardinality(embedding) = 384;
  IF n_articles <> (SELECT count(*) FROM "Article") OR n_questions <> (SELECT count(*) FROM "Question") THEN
    RAISE EXCEPTION 'only %/% articles and %/% questions were embedded',
      n_articles, (SELECT count(*) FROM "Article"), n_questions, (SELECT count(*) FROM "Question");
  END IF;

  -- Same stamp `npm run embed` writes, so /eval can compare it against the model the function loads.
  INSERT INTO "IndexMeta" (key, value, "updatedAt")
  VALUES ('embedding-index',
          format('%s@%s dims=%s articles=%s questions=%s', p->>'model', p->>'dtype', p->>'dims', n_articles, n_questions),
          now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = now();

  RAISE NOTICE 'loaded % article and % question vectors, %@%', n_articles, n_questions, p->>'model', p->>'dtype';
END $$;

COMMIT;
