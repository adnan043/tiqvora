-- Help desk analytics: daily totals of the assistant's questions, kept on write.
-- Reports read at most ~180 small rows instead of counting `question_logs` per request
-- (docs/agent/performance.md: no aggregates on growing tables per request).
-- The totals are kept by a trigger, so the ask and helpful routes (one statement each) need no
-- change and can't forget it. A deleted log row leaves its day as it was: totals outlive the log.
-- One transaction (docs/agent/database.md).
BEGIN;

-- CreateTable
CREATE TABLE "question_stats_daily" (
    "day" DATE NOT NULL,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "handed_off" INTEGER NOT NULL DEFAULT 0,
    "no_source" INTEGER NOT NULL DEFAULT 0,
    "ai_off" INTEGER NOT NULL DEFAULT 0,
    "helpful_up" INTEGER NOT NULL DEFAULT 0,
    "helpful_down" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_stats_daily_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "question_logs_outcome_id_idx" ON "question_logs"("outcome", "id");

-- CreateIndex
CREATE INDEX "question_logs_helpful_id_idx" ON "question_logs"("helpful", "id");

-- The one place the totals change. The day is the question's UTC day, for the insert and for
-- a later thumbs up/down alike, so a vote lands on the day its question was asked.
CREATE FUNCTION "question_stats_daily_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d date := (NEW."created_at" AT TIME ZONE 'UTC')::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "question_stats_daily" AS s
      ("day", "questions", "answered", "handed_off", "no_source", "ai_off", "helpful_up", "helpful_down", "cost_micros", "updated_at")
    VALUES (
      d, 1,
      (NEW."outcome" = 'answered')::int,
      (NEW."outcome" = 'handed_off')::int,
      (NEW."outcome" = 'no_source')::int,
      (NEW."outcome" = 'ai_off')::int,
      (NEW."helpful" IS TRUE)::int,
      (NEW."helpful" IS FALSE)::int,
      NEW."cost_micros",
      now())
    ON CONFLICT ("day") DO UPDATE SET
      "questions"    = s."questions" + 1,
      "answered"     = s."answered" + EXCLUDED."answered",
      "handed_off"   = s."handed_off" + EXCLUDED."handed_off",
      "no_source"    = s."no_source" + EXCLUDED."no_source",
      "ai_off"       = s."ai_off" + EXCLUDED."ai_off",
      "helpful_up"   = s."helpful_up" + EXCLUDED."helpful_up",
      "helpful_down" = s."helpful_down" + EXCLUDED."helpful_down",
      "cost_micros"  = s."cost_micros" + EXCLUDED."cost_micros",
      "updated_at"   = now();
  ELSIF NEW."helpful" IS DISTINCT FROM OLD."helpful" THEN
    -- The day's row exists: the insert made it. GREATEST keeps a hand-edited row from going negative.
    UPDATE "question_stats_daily" SET
      "helpful_up"   = GREATEST(0, "helpful_up" + (NEW."helpful" IS TRUE)::int - (OLD."helpful" IS TRUE)::int),
      "helpful_down" = GREATEST(0, "helpful_down" + (NEW."helpful" IS FALSE)::int - (OLD."helpful" IS FALSE)::int),
      "updated_at"   = now()
    WHERE "day" = d;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "question_stats_daily_ins_trg"
  AFTER INSERT ON "question_logs"
  FOR EACH ROW EXECUTE FUNCTION "question_stats_daily_fn"();

CREATE TRIGGER "question_stats_daily_helpful_trg"
  AFTER UPDATE OF "helpful" ON "question_logs"
  FOR EACH ROW EXECUTE FUNCTION "question_stats_daily_fn"();

-- Backfill the questions already logged (once, here; never per request).
INSERT INTO "question_stats_daily"
  ("day", "questions", "answered", "handed_off", "no_source", "ai_off", "helpful_up", "helpful_down", "cost_micros", "updated_at")
SELECT
  ("created_at" AT TIME ZONE 'UTC')::date,
  count(*)::int,
  count(*) FILTER (WHERE "outcome" = 'answered')::int,
  count(*) FILTER (WHERE "outcome" = 'handed_off')::int,
  count(*) FILTER (WHERE "outcome" = 'no_source')::int,
  count(*) FILTER (WHERE "outcome" = 'ai_off')::int,
  count(*) FILTER (WHERE "helpful" IS TRUE)::int,
  count(*) FILTER (WHERE "helpful" IS FALSE)::int,
  coalesce(sum("cost_micros"), 0)::bigint,
  now()
FROM "question_logs"
GROUP BY 1;

ALTER TABLE "question_stats_daily" ADD CONSTRAINT "question_stats_daily_counts_check" CHECK (
  "questions" >= 0 AND "answered" >= 0 AND "handed_off" >= 0 AND "no_source" >= 0 AND "ai_off" >= 0
  AND "helpful_up" >= 0 AND "helpful_down" >= 0 AND "cost_micros" >= 0);

COMMIT;
