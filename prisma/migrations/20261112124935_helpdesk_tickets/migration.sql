-- Help desk, Phase 3: conversations, messages, tickets, who-is-viewing, tile counters and
-- saved replies. One transaction (docs/agent/database.md).
BEGIN;

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "status" VARCHAR(8) NOT NULL DEFAULT 'waiting',
    "resolution" VARCHAR(9) NOT NULL DEFAULT 'none',
    "page_path" VARCHAR(300) NOT NULL DEFAULT '',
    "language" VARCHAR(16) NOT NULL DEFAULT '',
    "request_key" VARCHAR(64) NOT NULL,
    "customer_unread" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "sender" VARCHAR(8) NOT NULL,
    "author_user_id" INTEGER,
    "body" VARCHAR(4000) NOT NULL,
    "cited_articles" JSONB,
    "confidence" VARCHAR(8),
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "number" SERIAL NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "priority" VARCHAR(6) NOT NULL DEFAULT 'normal',
    "assignee_id" INTEGER,
    "ai_summary" VARCHAR(1200),
    "ai_summary_state" VARCHAR(11) NOT NULL DEFAULT 'pending',
    "ai_sources" JSONB,
    "solved_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "csat" SMALLINT,
    "csat_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_views" (
    "ticket_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "viewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_views_pkey" PRIMARY KEY ("ticket_id","user_id")
);

-- CreateTable
CREATE TABLE "helpdesk_counters" (
    "name" VARCHAR(32) NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_counters_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "helpdesk_canned_replies" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "updated_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helpdesk_canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_user_id_id_idx" ON "conversations"("user_id", "id");

-- CreateIndex
CREATE INDEX "conversations_status_last_message_at_id_idx" ON "conversations"("status", "last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_user_id_request_key_key" ON "conversations"("user_id", "request_key");

-- CreateIndex
CREATE INDEX "messages_conversation_id_id_idx" ON "messages"("conversation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_conversation_id_key" ON "tickets"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");

-- CreateIndex
CREATE INDEX "tickets_assignee_id_solved_at_id_idx" ON "tickets"("assignee_id", "solved_at", "id");

-- CreateIndex
CREATE INDEX "ticket_views_user_id_idx" ON "ticket_views"("user_id");

-- CreateIndex
CREATE INDEX "helpdesk_canned_replies_position_id_idx" ON "helpdesk_canned_replies"("position", "id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_views" ADD CONSTRAINT "ticket_views_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_views" ADD CONSTRAINT "ticket_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ticket numbers start at #1001.
ALTER SEQUENCE "tickets_number_seq" RESTART WITH 1001;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_status_check"
  CHECK ("status" IN ('ai', 'waiting', 'open', 'pending', 'solved'));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_resolution_check"
  CHECK ("resolution" IN ('confirmed', 'assumed', 'none'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_check"
  CHECK ("sender" IN ('customer', 'ai', 'agent', 'note'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_confidence_check"
  CHECK ("confidence" IS NULL OR "confidence" IN ('high', 'medium', 'low', 'none'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_check" CHECK (length("body") >= 1);
ALTER TABLE "messages" ADD CONSTRAINT "messages_counts_check" CHECK ("tokens" >= 0 AND "cost_micros" >= 0);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priority_check"
  CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ai_summary_state_check"
  CHECK ("ai_summary_state" IN ('pending', 'ready', 'unavailable'));
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_csat_check" CHECK ("csat" IS NULL OR "csat" BETWEEN 1 AND 5);
ALTER TABLE "helpdesk_counters" ADD CONSTRAINT "helpdesk_counters_value_check" CHECK ("value" >= 0);

-- Partial indexes (Prisma can't hold them; if a later --create-only migration drops one, delete that line).
-- Waiting on us (status waiting|open), oldest first.
CREATE INDEX "conversations_waiting_idx" ON "conversations" ("last_message_at", "id")
  WHERE "status" IN ('waiting', 'open');
-- My support badge: my conversations with an unread agent reply.
CREATE INDEX "conversations_unread_idx" ON "conversations" ("user_id") WHERE "customer_unread";
-- The summary sweep: tickets still waiting for a summary.
CREATE INDEX "tickets_summary_pending_idx" ON "tickets" ("id") WHERE "ai_summary_state" = 'pending';

INSERT INTO "helpdesk_counters" ("name", "value") VALUES ('unsolved', 0), ('waiting_on_us', 0)
  ON CONFLICT ("name") DO NOTHING;

COMMIT;
