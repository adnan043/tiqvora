import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {LOW_RATED_MIN_VOTES, TOP_SIZE} from '../../lib/helpdesk-report-types';
import {weekKey} from './state';

/**
 * The Tickets and Knowledge tabs' numbers (Analytics), worked out once a night: the existing
 * `helpdesk-counters` handler (daily 04:00 UTC, src/server/background.ts) runs
 * `recountHelpdeskCounters(db)` and then `runWeeklyStats(db)`. Idempotent: a second run (or a
 * retry after a throw) writes the same rows.
 *
 * `helpdesk_stats_weekly` — the LAST 3 UTC weeks (current, previous, and the one before) are
 * recomputed from `tickets`: a customer can reopen a ticket, or confirm a team-solved one, for
 * 14 days after `solved_at`, which can reach back two weeks. Older rows are frozen history,
 * deleted after 53 weeks. Per week (a Monday 00:00 UTC to the next):
 *   - created: tickets created in it (`tickets(created_at)` index);
 *   - solved / confirmed / assumed: tickets whose `solved_at` is in it and that are still solved,
 *     by `conversations.resolution` (owner decision 1: the same rule as the Overview counters);
 *   - first responses: tickets CREATED in it that got a first team reply, and the median wait;
 *   - CSAT: ratings given in it (`csat_at`, on the partial index `tickets_csat_at_idx`). Shown
 *     apart from resolutions, never mixed in.
 *
 * `helpdesk_top_weekly` — rankings for the current and the previous week (≤ 10 rows a list):
 *   - `unanswered`: `no_source` questions asked in the week, grouped by `normalizeQuestion`
 *     (case, spaces, trailing punctuation); the newest wording shown. Reads ≤ 5,000 a week.
 *   - `used`: published articles that were the best match of `answered` questions in the week.
 *   - `low_rated`: published articles with ≥ 5 thumbs, most "not helpful" share first. The thumbs
 *     are all time, so it is a snapshot: written for the CURRENT week only; the previous week
 *     keeps what its own last run wrote (final after Monday's run).
 * Rankings older than the previous week are deleted (the screen reads only these two).
 *
 * Every run writes all 3 weeks' `helpdesk_stats_weekly` rows (zeros included), so a week's
 * `updated_at` there says "this week was worked out", even when it has no ranking rows: the
 * Rankings read (`GET /reports/top`) takes its `updatedAt` from it.
 *
 * Round trips: 1 stats upsert, 2 reads (Promise.all), 2 ranking writes, 1 clean-up.
 */

const DAY_MS = 86_400_000;
/** Weeks recomputed each night (the 14-day reopen / confirm window reaches back two weeks). */
export const RECOMPUTE_WEEKS = 3;
/** Weekly rows kept, the current week included (a year: the 13-week view and some history). */
export const KEEP_WEEKS = 53;
/** `no_source` questions read per week for the ranking (newest first). */
const UNANSWERED_READ = 5000;

/** The Monday `weeks` weeks before `monday` (`YYYY-MM-DD`, UTC). */
export function mondayBefore(monday: string, weeks: number): string {
  return new Date(Date.parse(`${monday}T00:00:00Z`) - weeks * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** One character that is trimmed from either end of a question: a space or punctuation. */
const EDGE = /^[\s\p{P}]$/u;

/**
 * The key two questions share when they are "the same question": lower case, runs of spaces as
 * one, no spaces or punctuation at either end (`"Where is my order?"` = `"where is  my order"`).
 */
export function normalizeQuestion(question: string): string {
  const text = question.toLowerCase().replace(/\s+/g, ' ');
  // Linear trims: a `[\s\p{P}]+$` regex retries from every start of a long punctuation run (quadratic).
  let start = 0;
  let end = text.length;
  while (start < end) {
    const width = text.codePointAt(start)! > 0xffff ? 2 : 1;
    if (!EDGE.test(text.slice(start, start + width))) break;
    start += width;
  }
  while (end > start) {
    const low = text.charCodeAt(end - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && end - 2 >= start ? 2 : 1;
    if (!EDGE.test(text.slice(end - width, end))) break;
    end -= width;
  }
  return text.slice(start, end);
}

/**
 * The most-asked unanswered questions: groups by `normalizeQuestion`, most asked first (ties:
 * the one asked most recently first), ≤ `size`. `newestFirst` is newest first; each group shows
 * its newest wording. Pure: tested.
 */
export function rankUnanswered(newestFirst: readonly string[], size: number = TOP_SIZE): {question: string; asked: number}[] {
  const groups = new Map<string, {question: string; asked: number; order: number}>();
  newestFirst.forEach((question, order) => {
    const key = normalizeQuestion(question);
    if (!key) return;
    const group = groups.get(key);
    if (group) group.asked += 1;
    else groups.set(key, {question: question.trim().slice(0, 500), asked: 1, order});
  });
  return [...groups.values()]
    .sort((a, b) => b.asked - a.asked || a.order - b.order)
    .slice(0, size)
    .map(({question, asked}) => ({question, asked}));
}

/** `(${monday}::date)` as the UTC instant it starts. */
const startOf = (week: Prisma.Sql) => Prisma.sql`((${week})::timestamp AT TIME ZONE 'UTC')`;

/**
 * Recomputes the three weeks' ticket numbers in ONE statement (an upsert per week). Each source is
 * read ONCE for all the weeks, bounded by the oldest Monday and the next one, and grouped by week:
 *   - created + first responses: one range read of `tickets(created_at)`;
 *   - solved: one range read of `tickets(solved_at)`, each ticket's conversation by primary key
 *     (the `OFFSET 0` keeps the planner from turning it into a scan of every conversation);
 *   - CSAT: one range read on the partial index `tickets_csat_at_idx (csat_at) WHERE csat IS NOT NULL`.
 * A week with nothing in a source is zeros (LEFT JOIN + COALESCE).
 */
async function writeStats(db: PrismaClient, weeks: readonly string[]): Promise<void> {
  const values = Prisma.join(weeks.map(w => Prisma.sql`(${w}::date)`));
  const oldest = [...weeks].sort()[0]!;
  const newest = [...weeks].sort().at(-1)!;
  const from = startOf(Prisma.sql`${oldest}::date`);
  const to = startOf(Prisma.sql`${newest}::date + 7`);
  const weekOf = (column: Prisma.Sql) => Prisma.sql`(date_trunc('week', ${column} AT TIME ZONE 'UTC'))::date`;
  await db.$executeRaw`
    WITH w AS (
      SELECT v.d AS "week" FROM (VALUES ${values}) AS v(d)
    ), cr AS (
      SELECT ${weekOf(Prisma.sql`t."created_at"`)} AS "week", count(*)::int AS "created",
        (count(*) FILTER (WHERE t."first_response_at" IS NOT NULL))::int AS "fr_n",
        round(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY GREATEST(0, extract(epoch FROM t."first_response_at" - t."created_at")))
          FILTER (WHERE t."first_response_at" IS NOT NULL))::int AS "fr_median"
      FROM "tickets" t
      WHERE t."created_at" >= ${from} AND t."created_at" < ${to}
      GROUP BY 1
    ), so AS (
      SELECT ${weekOf(Prisma.sql`t."solved_at"`)} AS "week", count(*)::int AS "solved",
        (count(*) FILTER (WHERE c."resolution" = 'confirmed'))::int AS "confirmed",
        (count(*) FILTER (WHERE c."resolution" = 'assumed'))::int AS "assumed"
      FROM "tickets" t
      JOIN LATERAL (SELECT c."resolution", c."status" FROM "conversations" c WHERE c."id" = t."conversation_id" OFFSET 0) c ON TRUE
      WHERE t."solved_at" >= ${from} AND t."solved_at" < ${to} AND c."status" = 'solved'
      GROUP BY 1
    ), cs AS (
      SELECT ${weekOf(Prisma.sql`t."csat_at"`)} AS "week", count(*)::int AS "n", COALESCE(sum(t."csat"), 0)::int AS "sum"
      FROM "tickets" t
      WHERE t."csat" IS NOT NULL AND t."csat_at" >= ${from} AND t."csat_at" < ${to}
      GROUP BY 1
    ), stats AS (
      SELECT w."week", COALESCE(cr."created", 0) AS "created",
        COALESCE(so."solved", 0) AS "solved", COALESCE(so."confirmed", 0) AS "confirmed", COALESCE(so."assumed", 0) AS "assumed",
        COALESCE(cr."fr_n", 0) AS "fr_n", cr."fr_median", COALESCE(cs."n", 0) AS "csat_n", COALESCE(cs."sum", 0) AS "csat_sum"
      FROM w
      LEFT JOIN cr ON cr."week" = w."week"
      LEFT JOIN so ON so."week" = w."week"
      LEFT JOIN cs ON cs."week" = w."week"
    )
    INSERT INTO "helpdesk_stats_weekly" ("week", "tickets_created", "tickets_solved", "solved_confirmed", "solved_assumed",
      "first_responses", "first_response_median_secs", "csat_count", "csat_sum", "updated_at")
    SELECT "week", "created", "solved", "confirmed", "assumed", "fr_n", "fr_median", "csat_n", "csat_sum", now() FROM stats
    ON CONFLICT ("week") DO UPDATE SET
      "tickets_created" = EXCLUDED."tickets_created",
      "tickets_solved" = EXCLUDED."tickets_solved",
      "solved_confirmed" = EXCLUDED."solved_confirmed",
      "solved_assumed" = EXCLUDED."solved_assumed",
      "first_responses" = EXCLUDED."first_responses",
      "first_response_median_secs" = EXCLUDED."first_response_median_secs",
      "csat_count" = EXCLUDED."csat_count",
      "csat_sum" = EXCLUDED."csat_sum",
      "updated_at" = now()`;
}

/**
 * The week's `no_source` questions, newest first: walks `question_logs(outcome, id)` backward from
 * the newest and stops after `UNANSWERED_READ` (ids grow with `created_at`), never every no_source
 * row of all time.
 */
function readUnanswered(db: PrismaClient, monday: string): Promise<{question: string}[]> {
  const from = new Date(`${monday}T00:00:00Z`);
  return db.questionLog.findMany({
    where: {outcome: 'no_source', createdAt: {gte: from, lt: new Date(from.getTime() + 7 * DAY_MS)}},
    orderBy: {id: 'desc'},
    take: UNANSWERED_READ,
    select: {question: true},
  });
}

/**
 * Writes one week's rankings in ONE statement: ranks 1…n upserted, any rank of those lists not
 * written this time deleted (the DELETE sees the rows as they were before the statement and skips
 * the ones the upsert touches, so no row is changed twice). `withLowRated` false leaves that
 * list as it was.
 */
async function writeTop(
  db: PrismaClient,
  monday: string,
  unanswered: {question: string; asked: number}[],
  withLowRated: boolean
): Promise<void> {
  const weekStart = startOf(Prisma.sql`${monday}::date`);
  const weekEnd = startOf(Prisma.sql`${monday}::date + 7`);
  const asked = unanswered.length
    ? Prisma.sql`SELECT v."rank", v."question", v."value" FROM (VALUES ${Prisma.join(
        unanswered.map((row, i) => Prisma.sql`(${i + 1}::int, ${row.question}::text, ${row.asked}::int)`)
      )}) AS v("rank", "question", "value")`
    : Prisma.sql`SELECT NULL::int AS "rank", NULL::text AS "question", NULL::int AS "value" WHERE FALSE`;
  const lowRated = withLowRated
    ? Prisma.sql`
      SELECT 'low_rated'::text AS "list", (row_number() OVER (
               ORDER BY a."not_helpful_count"::float8 / (a."helpful_count" + a."not_helpful_count") DESC,
                        a."helpful_count" + a."not_helpful_count" DESC, a."id"))::int AS "rank",
             a."id" AS "article_id", ''::text AS "question", a."not_helpful_count" AS "value", a."helpful_count" AS "value2"
      FROM "kb_articles" a
      WHERE a."status" = 'published' AND a."helpful_count" + a."not_helpful_count" >= ${LOW_RATED_MIN_VOTES}::int
      ORDER BY 2 LIMIT ${TOP_SIZE}::int`
    : Prisma.sql`SELECT NULL::text AS "list", NULL::int AS "rank", NULL::int AS "article_id", NULL::text AS "question",
        NULL::int AS "value", NULL::int AS "value2" WHERE FALSE`;
  const lists = withLowRated ? Prisma.sql`'unanswered', 'used', 'low_rated'` : Prisma.sql`'unanswered', 'used'`;

  await db.$executeRaw`
    WITH used AS (
      SELECT q."top_article_id" AS "article_id", count(*)::int AS "n"
      FROM "question_logs" q
      WHERE q."created_at" >= ${weekStart} AND q."created_at" < ${weekEnd}
        AND q."outcome" = 'answered' AND q."top_article_id" IS NOT NULL
      GROUP BY q."top_article_id"
    ), ranked AS (
      SELECT 'unanswered'::text AS "list", a."rank", NULL::int AS "article_id", a."question", a."value", 0 AS "value2"
      FROM (${asked}) a
      UNION ALL
      SELECT * FROM (
        SELECT 'used'::text AS "list", (row_number() OVER (ORDER BY u."n" DESC, u."article_id"))::int AS "rank",
               u."article_id", ''::text AS "question", u."n" AS "value", 0 AS "value2"
        FROM used u JOIN "kb_articles" k ON k."id" = u."article_id" AND k."status" = 'published'
        ORDER BY 2 LIMIT ${TOP_SIZE}::int
      ) top_used
      UNION ALL
      SELECT * FROM (${lowRated}) top_low
    ), up AS (
      INSERT INTO "helpdesk_top_weekly" ("week", "list", "rank", "article_id", "question", "value", "value2", "updated_at")
      SELECT ${monday}::date, r."list", r."rank", r."article_id", r."question", r."value", r."value2", now() FROM ranked r
      ON CONFLICT ("week", "list", "rank") DO UPDATE SET
        "article_id" = EXCLUDED."article_id", "question" = EXCLUDED."question",
        "value" = EXCLUDED."value", "value2" = EXCLUDED."value2", "updated_at" = now()
      RETURNING "list", "rank"
    )
    DELETE FROM "helpdesk_top_weekly" t
    WHERE t."week" = ${monday}::date AND t."list" IN (${lists})
      AND NOT EXISTS (SELECT 1 FROM up WHERE up."list" = t."list" AND up."rank" = t."rank")`;
}

/** Recomputes the weekly numbers and rankings (see the file comment). Safe to repeat. */
export async function runWeeklyStats(db: PrismaClient, now: Date = new Date()): Promise<void> {
  const current = weekKey(now);
  const previous = mondayBefore(current, 1);
  const weeks = Array.from({length: RECOMPUTE_WEEKS}, (_, i) => mondayBefore(current, i));

  await writeStats(db, weeks);

  const [thisWeek, lastWeek] = await Promise.all([readUnanswered(db, current), readUnanswered(db, previous)]);
  await writeTop(
    db,
    current,
    rankUnanswered(thisWeek.map(row => row.question)),
    true
  );
  await writeTop(
    db,
    previous,
    rankUnanswered(lastWeek.map(row => row.question)),
    false
  );

  // History: weekly rows for a year, rankings for the two weeks the screen shows.
  await db.$executeRaw`
    WITH old_stats AS (
      DELETE FROM "helpdesk_stats_weekly" WHERE "week" < ${mondayBefore(current, KEEP_WEEKS - 1)}::date RETURNING 1
    )
    DELETE FROM "helpdesk_top_weekly" WHERE "week" < ${previous}::date`;
}
