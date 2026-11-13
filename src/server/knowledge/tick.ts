import type {PrismaClient} from '../../generated/prisma/client';
import {canonicalTimeZone, weeklyCheckSlot} from '../../lib/time-zone';
import {JobRejected, sendJob} from '../../platform/background';
import {queueArticleDraft} from './drafts';

/**
 * The Knowledge health tick (`knowledge-health-tick`, every 30 minutes, UTC; background.json's
 * `knowledge-health` schedule). A schedule's time zone is fixed at Publish, so the owner's zone
 * (helpdesk_settings.time_zone) is applied here instead:
 *
 *   1. weekly guard   now ≥ Monday 07:30 owner-local and no run row for that local week → insert
 *                     the row (ON CONFLICT DO NOTHING: two ticks at once, one wins) and send
 *                     `knowledge-health` {week}. A refused send deletes the row: the next tick tries
 *                     again. A paused schedule or an outage still gets its run later that week.
 *   2. housekeeping   ONE statement: weekly runs silent for 2 h → failed; solved tickets older than
 *                     48 h with no draft check → given up (≤ 100); health drafts still `pending`
 *                     after 15 min → failed (its job died or gave up without saying so); Test Lab
 *                     runs silent for 15 min → failed/stalled; run rows older than 26 weeks → deleted.
 *   3. draft sweep    ≤ 3 solved tickets (15 min – 48 h) whose `article-drafts` job never ran →
 *                     queueArticleDraft (its key dedupes); stops at the first refusal. The tickets
 *                     are read together with the settings (one round trip): the housekeeping only
 *                     gives up on tickets older than 48 h, so it never changes this list.
 *
 * Bounded: ≤ 4 statements in 3 round trips (2 when the week isn't due) and ≤ 4 sends per tick. Safe to repeat.
 */

/** Tickets the draft sweep sends per tick (the jobs-per-minute limit is 10). */
export const DRAFT_SWEEP = 3;
/** Old unchecked tickets given up per tick (keeps the partial index small). */
export const DRAFT_GIVE_UP = 100;

export interface TickResult {
  /** The week a run was started for, or null. */
  started: string | null;
  draftsQueued: number;
}

export async function runKnowledgeTick(db: PrismaClient, siteUrl: string | URL, now: Date): Promise<TickResult> {
  const [settings, due] = await Promise.all([
    db.$queryRaw<{timeZone: string}[]>`
      SELECT "time_zone" AS "timeZone" FROM "helpdesk_settings" WHERE "id" = 1`,
    // Solved-ticket drafts whose job was refused at solve time (the key dedupes one that was sent).
    db.$queryRaw<{id: number; number: number}[]>`
      SELECT "id", "number" FROM "tickets"
      WHERE "solved_at" IS NOT NULL AND "draft_checked_at" IS NULL
        AND "solved_at" < now() - interval '15 minutes' AND "solved_at" > now() - interval '48 hours'
      ORDER BY "solved_at" LIMIT ${DRAFT_SWEEP}::int`,
  ]);
  const stored = settings[0]?.timeZone ?? 'UTC';
  let tz = canonicalTimeZone(stored);
  if (!tz) {
    console.warn('[knowledge] unknown time zone, using UTC');
    tz = 'UTC';
  }

  let started: string | null = null;
  const slot = weeklyCheckSlot(now, tz);
  if (slot.due) {
    const won = await db.$queryRaw<{week: unknown}[]>`
      INSERT INTO "knowledge_health_runs" ("week", "time_zone", "window_start", "window_end")
      VALUES (${slot.week}::date, ${tz}, ${slot.windowStart}::timestamptz, ${slot.windowEnd}::timestamptz)
      ON CONFLICT ("week") DO NOTHING
      RETURNING "week"`;
    if (won.length > 0) {
      try {
        await sendJob(siteUrl, 'knowledge-health', {week: slot.week}, {key: `kh-${slot.week}`, label: `Knowledge health · week of ${slot.week}`});
        started = slot.week;
      } catch (error) {
        // A code only. The row goes, so the next tick tries again (it never got past `gaps`).
        console.warn(`[knowledge] weekly run not sent: ${error instanceof JobRejected ? error.code : 'error'}`);
        await db.$executeRaw`
          DELETE FROM "knowledge_health_runs"
          WHERE "week" = ${slot.week}::date AND "phase" = 'gaps' AND "state" = 'running'`;
      }
    }
  }

  await db.$queryRaw`
    WITH stalled_runs AS (
      UPDATE "knowledge_health_runs" SET "state" = 'failed', "updated_at" = now()
      WHERE "state" = 'running' AND "updated_at" < now() - interval '2 hours'
      RETURNING 1
    ), gave_up AS (
      UPDATE "tickets" SET "draft_checked_at" = now()
      WHERE "id" IN (
        SELECT "id" FROM "tickets"
        WHERE "solved_at" IS NOT NULL AND "draft_checked_at" IS NULL AND "solved_at" <= now() - interval '48 hours'
        ORDER BY "solved_at" LIMIT ${DRAFT_GIVE_UP}::int
      ) AND "draft_checked_at" IS NULL
      RETURNING 1
    ), stalled_drafts AS (
      UPDATE "health_issues" SET "draft_state" = 'failed', "draft_error" = 'failed', "updated_at" = now()
      WHERE "state" = 'open' AND "draft_state" = 'pending' AND "updated_at" < now() - interval '15 minutes'
      RETURNING 1
    ), stalled_tests AS (
      UPDATE "test_runs" SET "state" = 'failed', "stop_reason" = 'stalled', "finished_at" = now(), "updated_at" = now()
      WHERE "state" = 'running' AND "updated_at" < now() - interval '15 minutes'
      RETURNING 1
    ), pruned AS (
      DELETE FROM "knowledge_health_runs" WHERE "week" < current_date - 26 * 7
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM stalled_runs)::int AS "stalledRuns", (SELECT count(*) FROM gave_up)::int AS "gaveUp",
      (SELECT count(*) FROM stalled_drafts)::int AS "stalledDrafts", (SELECT count(*) FROM stalled_tests)::int AS "stalledTests", (SELECT count(*) FROM pruned)::int AS "pruned"`;

  let draftsQueued = 0;
  for (const ticket of due) {
    if (!(await queueArticleDraft(siteUrl, ticket.id, ticket.number))) break;
    draftsQueued++;
  }
  return {started, draftsQueued};
}
