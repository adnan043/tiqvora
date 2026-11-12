-- Help desk, Phase 2: the assistant's question log and monthly AI spend.
-- One transaction (docs/agent/database.md).
BEGIN;

-- CreateTable
CREATE TABLE "question_logs" (
    "id" BIGSERIAL NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "language" VARCHAR(16) NOT NULL DEFAULT '',
    "page_path" VARCHAR(300) NOT NULL DEFAULT '',
    "top_article_id" INTEGER,
    "confidence" VARCHAR(8) NOT NULL DEFAULT 'none',
    "outcome" VARCHAR(12) NOT NULL,
    "helpful" BOOLEAN,
    "model" VARCHAR(60) NOT NULL DEFAULT '',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "month" DATE NOT NULL,
    "spent_micros" BIGINT NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("month")
);

-- CreateIndex
CREATE INDEX "question_logs_created_at_id_idx" ON "question_logs"("created_at", "id");

ALTER TABLE "question_logs" ADD CONSTRAINT "question_logs_confidence_check" CHECK ("confidence" IN ('high', 'medium', 'low', 'none'));
ALTER TABLE "question_logs" ADD CONSTRAINT "question_logs_outcome_check" CHECK ("outcome" IN ('answered', 'no_source', 'handed_off', 'ai_off'));
ALTER TABLE "question_logs" ADD CONSTRAINT "question_logs_counts_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micros" >= 0);
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_counts_check" CHECK ("spent_micros" >= 0 AND "requests" >= 0);

-- The assistant's model: the settings column starts empty; set the default explicitly.
UPDATE "helpdesk_settings" SET "model" = 'claude-opus-5-5' WHERE "id" = 1 AND "model" = '';

COMMIT;
