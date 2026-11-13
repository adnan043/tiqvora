-- Phase 4: Knowledge health and Test Lab. One transaction (docs/agent/database.md).
-- The partial indexes below (health_issues_open_key, test_runs_one_running_key,
-- tickets_draft_unchecked_idx) and the CHECKs are not in schema.prisma: open every later
-- --create-only migration and delete any DROP INDEX of them.
BEGIN;

-- The owner's time zone for the weekly check (src/lib/time-zone.ts validates it with Intl).
ALTER TABLE "helpdesk_settings" ADD COLUMN "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC';
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_time_zone_check"
  CHECK ("time_zone" ~ '^[A-Za-z0-9_+/-]{1,64}$');

-- Article drafts from solved tickets: what the job has finished with.
ALTER TABLE "tickets" ADD COLUMN "draft_checked_at" TIMESTAMPTZ(3);
-- Tickets solved before this phase get no draft (and stay out of the partial index below).
UPDATE "tickets" SET "draft_checked_at" = "solved_at" WHERE "solved_at" IS NOT NULL;
CREATE INDEX "tickets_draft_unchecked_idx" ON "tickets" ("solved_at")
  WHERE "solved_at" IS NOT NULL AND "draft_checked_at" IS NULL;

CREATE TABLE "health_issues" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(9) NOT NULL,
    "article_id" INTEGER,
    "source_ticket_id" INTEGER,
    "fingerprint" VARCHAR(64) NOT NULL,
    "week" DATE,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "suggested_title" VARCHAR(160) NOT NULL DEFAULT '',
    "suggested_body" TEXT NOT NULL DEFAULT '',
    "draft_state" VARCHAR(8) NOT NULL DEFAULT 'none',
    "draft_error" VARCHAR(8),
    "draft_attempts" SMALLINT NOT NULL DEFAULT 0,
    "state" VARCHAR(9) NOT NULL DEFAULT 'open',
    "accepted_article_id" INTEGER,
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "health_issues_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "health_issues"
  ADD CONSTRAINT "health_issues_type_check" CHECK ("type" IN ('gap', 'stale', 'conflict', 'low_rated')),
  ADD CONSTRAINT "health_issues_state_check" CHECK ("state" IN ('open', 'accepted', 'dismissed')),
  ADD CONSTRAINT "health_issues_draft_state_check" CHECK ("draft_state" IN ('none', 'pending', 'ready', 'failed')),
  ADD CONSTRAINT "health_issues_draft_error_check" CHECK ("draft_error" IS NULL OR "draft_error" IN ('off', 'cap', 'failed')),
  ADD CONSTRAINT "health_issues_draft_attempts_check" CHECK ("draft_attempts" BETWEEN 0 AND 3),
  -- Stale and low-rated issues are always about an article when found; a draft is a gap or a conflict.
  ADD CONSTRAINT "health_issues_ticket_type_check" CHECK ("source_ticket_id" IS NULL OR "type" IN ('gap', 'conflict')),
  ADD CONSTRAINT "health_issues_body_check" CHECK (char_length("suggested_body") <= 20000),
  -- Resolved rows say when; open rows don't.
  ADD CONSTRAINT "health_issues_resolved_check" CHECK (("state" = 'open') = ("resolved_at" IS NULL));

CREATE UNIQUE INDEX "health_issues_source_ticket_id_key" ON "health_issues"("source_ticket_id");
CREATE INDEX "health_issues_state_id_idx" ON "health_issues"("state", "id");
CREATE INDEX "health_issues_state_type_id_idx" ON "health_issues"("state", "type", "id");
CREATE INDEX "health_issues_article_id_idx" ON "health_issues"("article_id");
CREATE INDEX "health_issues_type_fingerprint_resolved_at_idx" ON "health_issues"("type", "fingerprint", "resolved_at");
-- One OPEN issue per finding: the weekly run upserts into it (ON CONFLICT ... WHERE "state" = 'open').
CREATE UNIQUE INDEX "health_issues_open_key" ON "health_issues"("type", "fingerprint") WHERE "state" = 'open';

ALTER TABLE "health_issues" ADD CONSTRAINT "health_issues_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "kb_articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "health_issues" ADD CONSTRAINT "health_issues_source_ticket_id_fkey"
  FOREIGN KEY ("source_ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "knowledge_health_runs" (
    "week" DATE NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "phase" VARCHAR(8) NOT NULL DEFAULT 'gaps',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "state" VARCHAR(7) NOT NULL DEFAULT 'running',
    "gaps_found" INTEGER NOT NULL DEFAULT 0,
    "stale_found" INTEGER NOT NULL DEFAULT 0,
    "low_rated_found" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "knowledge_health_runs_pkey" PRIMARY KEY ("week"),
    CONSTRAINT "knowledge_health_runs_phase_check" CHECK ("phase" IN ('gaps', 'articles', 'done')),
    CONSTRAINT "knowledge_health_runs_state_check" CHECK ("state" IN ('running', 'done', 'failed')),
    CONSTRAINT "knowledge_health_runs_window_check" CHECK ("window_end" > "window_start")
);

CREATE TABLE "test_cases" (
    "id" SERIAL NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "question_key" VARCHAR(500) NOT NULL,
    "expect" VARCHAR(8) NOT NULL DEFAULT 'answer',
    "expected_article_id" INTEGER,
    "last_answer" VARCHAR(1200),
    "last_confidence" VARCHAR(8),
    "last_sources" JSONB,
    "last_outcome" VARCHAR(16),
    "last_passed" BOOLEAN,
    "last_run_at" TIMESTAMPTZ(3),
    "last_run_id" INTEGER,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_cases_question_check" CHECK (char_length(btrim("question")) BETWEEN 3 AND 500),
    CONSTRAINT "test_cases_expect_check" CHECK ("expect" IN ('answer', 'handoff')),
    -- A hand-off case has no expected article.
    CONSTRAINT "test_cases_expect_article_check" CHECK ("expect" = 'answer' OR "expected_article_id" IS NULL),
    CONSTRAINT "test_cases_confidence_check" CHECK ("last_confidence" IS NULL OR "last_confidence" IN ('high', 'medium', 'low', 'none')),
    CONSTRAINT "test_cases_outcome_check" CHECK ("last_outcome" IS NULL OR "last_outcome" IN
      ('pass', 'handoff', 'person', 'no_source', 'wrong_source', 'answered_instead', 'cap', 'error'))
);
CREATE UNIQUE INDEX "test_cases_question_key_key" ON "test_cases"("question_key");
CREATE INDEX "test_cases_expected_article_id_idx" ON "test_cases"("expected_article_id");
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_expected_article_id_fkey"
  FOREIGN KEY ("expected_article_id") REFERENCES "kb_articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "test_runs" (
    "id" SERIAL NOT NULL,
    "state" VARCHAR(9) NOT NULL DEFAULT 'running',
    "stop_reason" VARCHAR(12),
    "total" INTEGER NOT NULL,
    "max_case_id" INTEGER NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "started_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_runs_state_check" CHECK ("state" IN ('running', 'done', 'cancelled', 'stopped', 'failed')),
    CONSTRAINT "test_runs_stop_reason_check" CHECK ("stop_reason" IS NULL OR "stop_reason" IN
      ('cap', 'ai_off', 'not_started', 'stalled', 'error')),
    CONSTRAINT "test_runs_counts_check" CHECK ("total" >= 0 AND "done" BETWEEN 0 AND "total" AND "passed" BETWEEN 0 AND "done")
);
-- "Run all" twice: only one run may be running (the second insert conflicts).
CREATE UNIQUE INDEX "test_runs_one_running_key" ON "test_runs"("state") WHERE "state" = 'running';

COMMIT;
