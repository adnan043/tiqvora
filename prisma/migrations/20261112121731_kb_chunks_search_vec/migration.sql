-- Stored full-text search vector for kb_chunks: ranking read the expression index's
-- to_tsvector() again for every matching row (259 ms at 9,840 chunks; 26 ms stored).
-- The column is kept by a trigger, so app code, the seed and imports write heading/text only.
-- Safe for the previous code: it still queries the old expression (unindexed for a moment).
BEGIN;

-- AlterTable
ALTER TABLE "kb_chunks" ADD COLUMN     "search_vec" tsvector;

-- The one place the vector is computed (KB_SEARCH_VECTOR in src/server/kb/search.ts reads it).
CREATE FUNCTION "kb_chunks_search_vec_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."search_vec" :=
    setweight(to_tsvector('simple', NEW."heading"), 'A') || setweight(to_tsvector('simple', NEW."text"), 'B');
  RETURN NEW;
END
$$;

CREATE TRIGGER "kb_chunks_search_vec_trg"
  BEFORE INSERT OR UPDATE OF "heading", "text" ON "kb_chunks"
  FOR EACH ROW EXECUTE FUNCTION "kb_chunks_search_vec_fn"();

-- Backfill the rows already there.
UPDATE "kb_chunks"
SET "search_vec" = setweight(to_tsvector('simple', "heading"), 'A') || setweight(to_tsvector('simple', "text"), 'B');

-- CreateIndex
CREATE INDEX "kb_chunks_search_vec_idx" ON "kb_chunks" USING GIN ("search_vec");

-- The expression index it replaces (ours, migration 20261112110356).
DROP INDEX IF EXISTS "kb_chunks_search_idx";

COMMIT;
