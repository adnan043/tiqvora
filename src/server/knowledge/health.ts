import type {PrismaClient} from '../../generated/prisma/client';
import {sendJob} from '../../platform/background';

/**
 * The weekly Knowledge health run (`knowledge-health` {week}): finds what the knowledge base is
 * missing or what has gone weak, and files it as `health_issues` for a person to look at.
 * Started once per owner-local week by the tick (./tick.ts), which inserts the guard row
 * `knowledge_health_runs(week)` first. NO AI CALLS: it costs nothing but a few statements.
 *
 *   phase `gaps`      ONE tagged statement: the week's unanswered / low-confidence questions,
 *                     grouped by a bag of stemmed words (or by the weak article), the 90-day
 *                     snooze, the upsert and the phase advance, all together.
 *   phase `articles`  keyset batches of published articles (stale ≥ 180 days unreviewed, low
 *                     rated ≥ 10 votes and ≥ 30 % not helpful), one statement per batch, at most
 *                     MAX_BATCHES per job; more → the next job carries on from the cursor.
 *
 * At-least-once: every phase ends with a CONDITIONAL update of the run row (week + phase + cursor
 * as read), so a duplicate delivery finds nothing to advance and stops; every insert is an upsert
 * on the open partial unique index (type, fingerprint), so a repeat writes nothing new. A refresh
 * replaces the run's own evidence but keeps what a draft added (summary, missingFacts,
 * noDraftReason), so the draft shown still has its notes.
 */

/** Questions read from the week (newest first). */
export const SCAN_MAX = 20_000;
/** A group needs this many questions to be reported (singletons are noise without vectors). */
export const MIN_GROUP = 2;
/** Gap issues filed per week at most (the biggest groups). */
export const MAX_GROUPS = 50;
/** Sample questions kept in an issue's evidence (≤ 5 × 500 chars: well under 8 KB). */
export const SAMPLES = 5;
/** Published articles per `articles` statement, and statements per job run. */
export const ARTICLE_BATCH = 500;
export const MAX_BATCHES = 10;

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A run's week ('YYYY-MM-DD', a real calendar date), or null. */
export function parseWeek(value: unknown): string | null {
  if (typeof value !== 'string' || !WEEK_RE.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : value;
}

export interface HealthJob {
  attempt: number;
  maxAttempts: number;
}

interface RunRow {
  phase: string;
  cursor: number;
  state: string;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Runs (or carries on) the weekly check of `week`. Returns when the run is done, was already done
 * or failed, or when the next job was sent. Throws on a DB error (the job is tried again); on the
 * last try the run is marked `failed` first.
 */
export async function runKnowledgeHealth(
  db: PrismaClient,
  week: string,
  job: HealthJob,
  url: string | URL | null | undefined,
  limits: {articleBatch?: number; maxBatches?: number} = {}
): Promise<void> {
  try {
    await runPhases(db, week, url, limits.articleBatch ?? ARTICLE_BATCH, limits.maxBatches ?? MAX_BATCHES);
  } catch (error) {
    if (job.attempt >= job.maxAttempts) {
      await db.$executeRaw`
        UPDATE "knowledge_health_runs" SET "state" = 'failed', "updated_at" = now()
        WHERE "week" = ${week}::date AND "state" = 'running'`.catch(() => undefined);
    }
    throw error;
  }
}

async function runPhases(
  db: PrismaClient,
  week: string,
  url: string | URL | null | undefined,
  batch: number,
  maxBatches: number
): Promise<void> {
  const rows = await db.$queryRaw<RunRow[]>`
    SELECT "phase", "cursor", "state", "window_start" AS "windowStart", "window_end" AS "windowEnd"
    FROM "knowledge_health_runs" WHERE "week" = ${week}::date`;
  const run = rows[0];
  if (!run || run.state !== 'running') return;

  if (run.phase === 'gaps') {
    const advanced = await findGaps(db, week, run.windowStart, run.windowEnd);
    if (!advanced) return; // another delivery advanced it (or the run stopped meanwhile)
  } else if (run.phase !== 'articles') {
    return;
  }

  let cursor = run.phase === 'articles' ? run.cursor : 0;
  for (let i = 0; i < maxBatches; i++) {
    const next = await scanArticles(db, week, cursor, batch);
    if (!next) return; // a duplicate delivery moved the cursor first
    if (next.phase !== 'articles') return; // done
    cursor = next.cursor;
  }
  // Still more articles: the next job carries on from the cursor (its key dedupes a repeat).
  if (!url) throw new Error("The site's address is not set.");
  await sendJob(url, 'knowledge-health', {week}, {key: `kh-${week}-${cursor}`, label: `Knowledge health · week of ${week}`});
}

/**
 * Phase `gaps`: ONE statement (group, snooze filter, upsert, counts, advance). True when this
 * delivery advanced the run to `articles`.
 *
 * Cluster key: `a:<articleId>` when an article matched but the answer was weak (one edit per
 * article); otherwise `q:<stemmed words>` (stop words dropped, sorted, deduped; `english` for
 * '' / en-*, `simple` for other languages). Fingerprint = md5(key).
 */
async function findGaps(db: PrismaClient, week: string, windowStart: Date, windowEnd: Date): Promise<boolean> {
  const rows = await db.$queryRaw<{gaps: number; advanced: boolean}[]>`
    WITH win AS (
      SELECT q."id", q."question", q."language", q."top_article_id", q."confidence", q."outcome"
      FROM "question_logs" q
      WHERE q."created_at" >= ${windowStart}::timestamptz AND q."created_at" < ${windowEnd}::timestamptz
        AND (q."outcome" = 'no_source' OR q."confidence" = 'low')
      ORDER BY q."created_at" DESC, q."id" DESC
      LIMIT ${SCAN_MAX}
    ), keyed AS MATERIALIZED (
      SELECT w.*,
        CASE
          WHEN w."top_article_id" IS NOT NULL AND w."outcome" <> 'no_source' THEN 'a:' || w."top_article_id"::text
          ELSE 'q:' || array_to_string(tsvector_to_array(to_tsvector(
                 CASE WHEN w."language" = '' OR w."language" LIKE 'en%' THEN 'english'::regconfig ELSE 'simple'::regconfig END,
                 w."question")), ' ')
        END AS "cluster"
      FROM win w
    ), grouped AS (
      SELECT k."cluster", count(*)::int AS "n",
             count(*) FILTER (WHERE k."outcome" = 'no_source')::int AS "no_source",
             count(*) FILTER (WHERE k."confidence" = 'low')::int AS "low",
             (array_agg(k."question" ORDER BY k."id" DESC))[1:${SAMPLES}::int] AS "samples",
             max(k."top_article_id") FILTER (WHERE k."cluster" LIKE 'a:%') AS "article_id",
             max(k."id") AS "last_id"
      FROM keyed k
      WHERE k."cluster" NOT IN ('q:', 'a:')
      GROUP BY k."cluster"
      HAVING count(*) >= ${MIN_GROUP}::int
      ORDER BY "n" DESC, "last_id" DESC
      LIMIT ${MAX_GROUPS}
    ), found AS (
      SELECT g.*, md5(g."cluster") AS "fp", a."id" AS "live_article_id", a."title" AS "article_title"
      FROM grouped g LEFT JOIN "kb_articles" a ON a."id" = g."article_id"
      WHERE NOT EXISTS (
        SELECT 1 FROM "health_issues" h
        WHERE h."type" = 'gap' AND h."fingerprint" = md5(g."cluster") AND h."state" <> 'open'
          AND h."resolved_at" > now() - interval '90 days')
    ), up AS (
      INSERT INTO "health_issues" ("type", "article_id", "fingerprint", "week", "evidence", "suggested_title", "created_at", "updated_at")
      SELECT 'gap', f."live_article_id", f."fp", ${week}::date,
        jsonb_build_object('source', 'weekly', 'from', ${windowStart}::timestamptz, 'to', ${windowEnd}::timestamptz,
          'questions', f."n", 'noSource', f."no_source", 'lowConfidence', f."low", 'samples', to_jsonb(f."samples")),
        left(COALESCE(f."article_title", f."samples"[1]), 160), now(), now()
      FROM found f
      ON CONFLICT ("type", "fingerprint") WHERE "state" = 'open'
      DO UPDATE SET "evidence" = EXCLUDED."evidence" || jsonb_strip_nulls(jsonb_build_object(
          'summary', "health_issues"."evidence"->'summary',
          'missingFacts', "health_issues"."evidence"->'missingFacts',
          'noDraftReason', "health_issues"."evidence"->'noDraftReason')),
        "week" = EXCLUDED."week", "updated_at" = now()
      RETURNING (xmax = 0) AS "inserted"
    ), adv AS (
      UPDATE "knowledge_health_runs" SET "phase" = 'articles', "cursor" = 0,
        "gaps_found" = (SELECT count(*) FROM up)::int, "updated_at" = now()
      WHERE "week" = ${week}::date AND "phase" = 'gaps' AND "state" = 'running'
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up)::int AS "gaps", EXISTS (SELECT 1 FROM adv) AS "advanced"`;
  return rows[0]?.advanced === true;
}

/**
 * Phase `articles`: one keyset batch of published articles → stale / low-rated issues, and the
 * run's cursor moved on (or the run finished) in the same statement. Null when the run was not at
 * `cursor` any more (a duplicate delivery got there first).
 */
async function scanArticles(
  db: PrismaClient,
  week: string,
  cursor: number,
  batch: number
): Promise<{cursor: number; phase: string} | null> {
  const rows = await db.$queryRaw<{cursor: number; phase: string}[]>`
    WITH b AS (
      SELECT a."id", a."title", a."last_reviewed_at", a."helpful_count", a."not_helpful_count", a."view_count"
      FROM "kb_articles" a WHERE a."status" = 'published' AND a."id" > ${cursor}::int
      ORDER BY a."id" LIMIT ${batch}::int
    ), cand AS (
      SELECT 'stale'::text AS "type", b."id", b."title",
        jsonb_build_object('lastReviewedAt', b."last_reviewed_at", 'daysSinceReview',
          floor(extract(epoch FROM now() - b."last_reviewed_at") / 86400)::int, 'views', b."view_count") AS "evidence"
      FROM b WHERE b."last_reviewed_at" < now() - interval '180 days'
      UNION ALL
      SELECT 'low_rated'::text, b."id", b."title",
        jsonb_build_object('helpful', b."helpful_count", 'notHelpful', b."not_helpful_count",
          'rate', round(b."not_helpful_count"::numeric / (b."helpful_count" + b."not_helpful_count"), 3))
      FROM b WHERE b."helpful_count" + b."not_helpful_count" >= 10
        AND b."not_helpful_count" * 10 >= 3 * (b."helpful_count" + b."not_helpful_count")
    ), up AS (
      INSERT INTO "health_issues" ("type", "article_id", "fingerprint", "week", "evidence", "suggested_title", "created_at", "updated_at")
      SELECT c."type", c."id", 'article:' || c."id", ${week}::date, c."evidence", left(c."title", 160), now(), now()
      FROM cand c
      WHERE NOT EXISTS (SELECT 1 FROM "health_issues" h WHERE h."type" = c."type" AND h."fingerprint" = 'article:' || c."id"
                        AND h."state" <> 'open' AND h."resolved_at" > now() - interval '90 days')
      ON CONFLICT ("type", "fingerprint") WHERE "state" = 'open'
      DO UPDATE SET "evidence" = EXCLUDED."evidence" || jsonb_strip_nulls(jsonb_build_object(
          'summary', "health_issues"."evidence"->'summary',
          'missingFacts', "health_issues"."evidence"->'missingFacts',
          'noDraftReason', "health_issues"."evidence"->'noDraftReason')),
        "week" = EXCLUDED."week", "updated_at" = now()
      RETURNING "type"
    ), adv AS (
      UPDATE "knowledge_health_runs" SET
        "cursor" = COALESCE((SELECT max("id") FROM b), "cursor"),
        "phase" = CASE WHEN (SELECT count(*) FROM b) < ${batch}::int THEN 'done' ELSE 'articles' END,
        "state" = CASE WHEN (SELECT count(*) FROM b) < ${batch}::int THEN 'done' ELSE 'running' END,
        "finished_at" = CASE WHEN (SELECT count(*) FROM b) < ${batch}::int THEN now() ELSE NULL END,
        "stale_found" = "stale_found" + (SELECT count(*) FROM up WHERE "type" = 'stale')::int,
        "low_rated_found" = "low_rated_found" + (SELECT count(*) FROM up WHERE "type" = 'low_rated')::int,
        "updated_at" = now()
      WHERE "week" = ${week}::date AND "phase" = 'articles' AND "cursor" = ${cursor}::int AND "state" = 'running'
      RETURNING "cursor", "phase"
    )
    SELECT "cursor", "phase" FROM adv`;
  return rows[0] ?? null;
}
