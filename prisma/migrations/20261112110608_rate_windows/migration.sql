-- Per-minute request counters for public routes (help-center search, later the
-- assistant). One transaction (docs/agent/database.md).
BEGIN;

-- CreateTable
CREATE TABLE "rate_windows" (
    "bucket" VARCHAR(40) NOT NULL,
    "minute" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_windows_pkey" PRIMARY KEY ("bucket","minute")
);

ALTER TABLE "rate_windows" ADD CONSTRAINT "rate_windows_count_check" CHECK ("count" >= 0);

COMMIT;
