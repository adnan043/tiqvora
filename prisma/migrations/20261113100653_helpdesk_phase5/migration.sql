-- Phase 5: Overview tiles, weekly reports, knowledge files. One transaction (docs/agent/database.md).
-- Partial indexes NOT in schema.prisma: conversations_waiting_idx, conversations_unread_idx,
-- tickets_summary_pending_idx (Phase 3), tickets_draft_unchecked_idx, health_issues_open_key,
-- test_runs_one_running_key (Phase 4), tickets_csat_at_idx (Phase 5). Open every later
-- --create-only migration and delete any DROP or RENAME of them (Prisma tried to rename
-- tickets_draft_unchecked_idx in this one).
-- CHECKs added here (also not in schema.prisma): kb_sources_kind_check, kb_sources_state_check,
-- kb_sources_text_len_check, kb_sources_counts_check, helpdesk_top_weekly_list_check,
-- helpdesk_stats_weekly_counts_check.
BEGIN;

-- AlterTable
ALTER TABLE "kb_articles" ADD COLUMN     "source_id" INTEGER;

-- CreateTable
CREATE TABLE "helpdesk_stats_weekly" (
    "week" DATE NOT NULL,
    "tickets_created" INTEGER NOT NULL DEFAULT 0,
    "tickets_solved" INTEGER NOT NULL DEFAULT 0,
    "solved_confirmed" INTEGER NOT NULL DEFAULT 0,
    "solved_assumed" INTEGER NOT NULL DEFAULT 0,
    "first_responses" INTEGER NOT NULL DEFAULT 0,
    "first_response_median_secs" INTEGER,
    "csat_count" INTEGER NOT NULL DEFAULT 0,
    "csat_sum" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_stats_weekly_pkey" PRIMARY KEY ("week")
);

-- CreateTable
CREATE TABLE "helpdesk_top_weekly" (
    "week" DATE NOT NULL,
    "list" VARCHAR(10) NOT NULL,
    "rank" SMALLINT NOT NULL,
    "article_id" INTEGER,
    "question" VARCHAR(500) NOT NULL DEFAULT '',
    "value" INTEGER NOT NULL DEFAULT 0,
    "value2" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_top_weekly_pkey" PRIMARY KEY ("week","list","rank")
);

-- CreateTable
CREATE TABLE "kb_sources" (
    "id" SERIAL NOT NULL,
    "file_id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(4) NOT NULL,
    "size" INTEGER NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'uploading',
    "category_id" INTEGER,
    "step" INTEGER NOT NULL DEFAULT 0,
    "round" SMALLINT NOT NULL DEFAULT 0,
    "pages_per_call" SMALLINT NOT NULL DEFAULT 4,
    "pages_total" INTEGER,
    "input_tokens" INTEGER,
    "text" TEXT NOT NULL DEFAULT '',
    "drafts_created" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(300) NOT NULL DEFAULT '',
    "spent_micros" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "kb_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_sources_file_id_key" ON "kb_sources"("file_id");

-- CreateIndex
CREATE INDEX "kb_sources_created_by_created_at_idx" ON "kb_sources"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "kb_sources_state_updated_at_idx" ON "kb_sources"("state", "updated_at");

-- CreateIndex
CREATE INDEX "kb_sources_category_id_idx" ON "kb_sources"("category_id");

-- CreateIndex
CREATE INDEX "kb_articles_source_id_id_idx" ON "kb_articles"("source_id", "id");

-- CreateIndex
CREATE INDEX "tickets_created_at_idx" ON "tickets"("created_at");

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "kb_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "kb_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex (full, not partial: the weekly job and the nightly recount read solved_at ranges).
-- Prisma generated `ALTER INDEX "tickets_draft_unchecked_idx" RENAME TO "tickets_solved_at_idx"`
-- here because it can't see that index is partial: deleted by hand. Keep it deleted.
CREATE INDEX "tickets_solved_at_idx" ON "tickets"("solved_at");

-- CreateIndex (partial, NOT in schema.prisma: Prisma can't express it). The weekly job's ratings
-- count reads csat_at ranges of rated tickets only.
CREATE INDEX "tickets_csat_at_idx" ON "tickets" ("csat_at") WHERE "csat" IS NOT NULL;

-- CHECKs (schema.prisma can't express them).
ALTER TABLE "kb_sources"
  ADD CONSTRAINT "kb_sources_kind_check" CHECK ("kind" IN ('pdf', 'docx', 'txt', 'md')),
  ADD CONSTRAINT "kb_sources_state_check"
    CHECK ("state" IN ('uploading', 'queued', 'extracting', 'drafted', 'failed', 'cancelled')),
  ADD CONSTRAINT "kb_sources_text_len_check" CHECK (char_length("text") <= 200000),
  ADD CONSTRAINT "kb_sources_counts_check" CHECK (
    "step" >= 0 AND "round" >= 0 AND "pages_per_call" BETWEEN 1 AND 4 AND "size" >= 0
    AND "drafts_created" >= 0 AND "spent_micros" >= 0
    AND ("pages_total" IS NULL OR "pages_total" >= 0)
    AND ("input_tokens" IS NULL OR "input_tokens" BETWEEN 1 AND 100000));
ALTER TABLE "helpdesk_top_weekly"
  ADD CONSTRAINT "helpdesk_top_weekly_list_check" CHECK ("list" IN ('unanswered', 'used', 'low_rated'));
ALTER TABLE "helpdesk_stats_weekly"
  ADD CONSTRAINT "helpdesk_stats_weekly_counts_check" CHECK (
    "tickets_created" >= 0 AND "tickets_solved" >= 0 AND "solved_confirmed" >= 0 AND "solved_assumed" >= 0
    AND "first_responses" >= 0 AND ("first_response_median_secs" IS NULL OR "first_response_median_secs" >= 0)
    AND "csat_count" >= 0 AND "csat_sum" >= 0);

-- Backfill this week's resolution counters ONCE (confirmed:/assumed: by the UTC Monday of solved_at).
-- Between Migrate and Deploy the old code moves no resolution counter; the nightly recount fixes
-- the current week.
INSERT INTO "helpdesk_counters" ("name", "value", "updated_at")
SELECT c."resolution" || ':' || to_char(date_trunc('week', t."solved_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
       count(*)::int, now()
FROM "tickets" t JOIN "conversations" c ON c."id" = t."conversation_id"
WHERE t."solved_at" >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  AND c."status" = 'solved' AND c."resolution" IN ('confirmed', 'assumed')
GROUP BY 1
ORDER BY 1
ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();

COMMIT;
