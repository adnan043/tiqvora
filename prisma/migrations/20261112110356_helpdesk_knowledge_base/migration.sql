-- Help desk, Phase 1: settings and the knowledge base, and the "Support agent"
-- role. One transaction: if any statement fails, none apply (docs/agent/database.md).
BEGIN;

-- CreateTable
CREATE TABLE "helpdesk_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "assistant_name" VARCHAR(60) NOT NULL DEFAULT 'Assistant',
    "greeting" VARCHAR(300) NOT NULL DEFAULT 'Hi! Ask me anything about our products and orders.',
    "tone" VARCHAR(10) NOT NULL DEFAULT 'friendly',
    "confidence_threshold" VARCHAR(10) NOT NULL DEFAULT 'medium',
    "provider" VARCHAR(12) NOT NULL DEFAULT 'anthropic',
    "model" VARCHAR(60) NOT NULL DEFAULT '',
    "monthly_cap_cents" INTEGER NOT NULL DEFAULT 2000,
    "launcher_label" VARCHAR(30) NOT NULL DEFAULT 'Support',
    "business_hours" VARCHAR(200) NOT NULL DEFAULT '',
    "help_title" VARCHAR(120) NOT NULL DEFAULT 'How can we help?',
    "help_intro" VARCHAR(300) NOT NULL DEFAULT 'Search our guides, or ask the assistant.',
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helpdesk_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_quick_replies" (
    "id" SERIAL NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helpdesk_quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helpdesk_human_topics" (
    "id" SERIAL NOT NULL,
    "keyword" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helpdesk_human_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300) NOT NULL DEFAULT '',
    "icon" VARCHAR(30) NOT NULL DEFAULT 'book',
    "position" INTEGER NOT NULL DEFAULT 0,
    "article_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "body" TEXT NOT NULL,
    "excerpt" VARCHAR(300) NOT NULL DEFAULT '',
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(3),
    "last_reviewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "not_helpful_count" INTEGER NOT NULL DEFAULT 0,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "updated_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_snippets" (
    "id" SERIAL NOT NULL,
    "question" VARCHAR(300) NOT NULL,
    "answer" VARCHAR(2000) NOT NULL,
    "created_by" INTEGER NOT NULL,
    "updated_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_snippets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunks" (
    "id" SERIAL NOT NULL,
    "article_id" INTEGER,
    "snippet_id" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "heading" VARCHAR(200) NOT NULL DEFAULT '',
    "text" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "helpdesk_quick_replies_position_id_idx" ON "helpdesk_quick_replies"("position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "helpdesk_human_topics_keyword_key" ON "helpdesk_human_topics"("keyword");

-- CreateIndex
CREATE UNIQUE INDEX "kb_categories_slug_key" ON "kb_categories"("slug");

-- CreateIndex
CREATE INDEX "kb_categories_position_id_idx" ON "kb_categories"("position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_slug_key" ON "kb_articles"("slug");

-- CreateIndex
CREATE INDEX "kb_articles_category_id_status_id_idx" ON "kb_articles"("category_id", "status", "id");

-- CreateIndex
CREATE INDEX "kb_articles_status_id_idx" ON "kb_articles"("status", "id");

-- CreateIndex
CREATE INDEX "kb_articles_status_view_count_id_idx" ON "kb_articles"("status", "view_count" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "kb_chunks_article_id_position_idx" ON "kb_chunks"("article_id", "position");

-- CreateIndex
CREATE INDEX "kb_chunks_snippet_id_idx" ON "kb_chunks"("snippet_id");

-- AddForeignKey
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "kb_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "kb_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_snippet_id_fkey" FOREIGN KEY ("snippet_id") REFERENCES "kb_snippets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Small fixed sets and counters (the validators check them first).
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_single_row" CHECK ("id" = 1);
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_tone_check" CHECK ("tone" IN ('friendly', 'neutral', 'formal'));
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_threshold_check" CHECK ("confidence_threshold" IN ('low', 'medium', 'high'));
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_provider_check" CHECK ("provider" IN ('anthropic', 'openai'));
ALTER TABLE "helpdesk_settings" ADD CONSTRAINT "helpdesk_settings_cap_check" CHECK ("monthly_cap_cents" >= 0);
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_counts_check"
  CHECK ("helpful_count" >= 0 AND "not_helpful_count" >= 0 AND "view_count" >= 0);
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_count_check" CHECK ("article_count" >= 0);
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_source_check" CHECK (("article_id" IS NULL) <> ("snippet_id" IS NULL));

-- Full-text search over chunks. An expression index, not a generated column, so
-- later `prisma migrate dev` runs never try to drop a column the schema can't
-- describe. The query must use EXACTLY this expression (src/server/kb/search.ts).
-- If a later --create-only migration contains DROP INDEX "kb_chunks_search_idx", delete that line.
CREATE INDEX "kb_chunks_search_idx" ON "kb_chunks" USING GIN (
  (setweight(to_tsvector('simple', "heading"), 'A') || setweight(to_tsvector('simple', "text"), 'B'))
);

-- The settings row every read expects.
INSERT INTO "helpdesk_settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;

-- The "Support agent" role, before the catalogue entries that name it in `roles`
-- (granted once when those codenames first sync; docs/agent/roles-and-permissions.md).
INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at")
VALUES ('agent', 'Support agent', 'Works the help desk inbox and edits the knowledge base.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

COMMIT;
