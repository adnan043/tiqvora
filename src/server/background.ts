import type {PrismaClient} from '../generated/prisma/client';
import {defineBackground, DontRetry, type JobInfo} from '../platform/background';
import {config} from '../platform/config';
import {getDb} from '../platform/db';
import {runSummaryJob, sweepPendingSummaries} from './helpdesk/summary';
import {runWeeklyStats} from './helpdesk/weekly';
import {runKbExtractJob, sweepKbSources} from './kb/sources/pipeline';
import {runArticleDraftJob, runHealthDraftJob} from './knowledge/drafts';
import {parseWeek, runKnowledgeHealth} from './knowledge/health';
import {runTestLabBatch} from './knowledge/test-lab';
import {runKnowledgeTick} from './knowledge/tick';
import {deleteOldRateWindows} from './rate-window';

function siteDb(): PrismaClient {
  const db = getDb();
  if (!db) throw new Error('The Site Database is off.');
  return db;
}

/** The largest id a column (INT) holds. */
const INT_MAX = 2147483647;

/** A positive id from a job's data (1 … 2^31−1, an INT column), or null. */
function posInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= INT_MAX ? value : null;
}

/** One field of a job's data (data is any JSON). */
function field(data: unknown, name: string): unknown {
  return data && typeof data === 'object' ? (data as Record<string, unknown>)[name] : undefined;
}

/**
 * The site's address, for handlers that send the next job. Locally (Preview, tests) `sendJob`
 * runs the handler in this process and never uses it, so a stand-in is fine there.
 */
function jobSiteUrl(job: JobInfo): string | null {
  return config.siteUrl ?? (job.local ? 'http://localhost' : null);
}

function requireSiteUrl(job: JobInfo): string {
  const url = jobSiteUrl(job);
  if (!url) throw new Error("The site's address is not set.");
  return url;
}

/** Old presence rows deleted per statement, and statements per nightly run (bounded). */
const VIEWS_BATCH = 5000;
const VIEWS_MAX_BATCHES = 10;

/** A non-negative INT from a job's data (0 … 2^31−1), or null. */
function nonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= INT_MAX ? value : null;
}

/**
 * The nightly safety net for the Overview tiles (`helpdesk_counters`, kept on every write by
 * src/server/helpdesk/state.ts): recounts `unsolved`, `waiting_on_us` and this UTC week's
 * `solved:YYYY-MM-DD`, `confirmed:YYYY-MM-DD` and `assumed:YYYY-MM-DD` in ONE statement (two
 * counts on the status indexes, one on tickets(solved_at) joined to conversations), writes only the
 * rows that drifted, then prunes `solved:`/`confirmed:`/`assumed:` weeks older than 8 and presence
 * rows older than 7 days (bounded batches). Safe to repeat: a second run changes nothing.
 *
 * The recount runs in a short transaction that FIRST locks those five counter rows (FOR UPDATE,
 * ORDER BY name: the same order `transition()` uses after its conversation/ticket locks). A status
 * change that wants to move them waits until the recount commits, then applies its delta to the
 * recounted value; one that committed before the lock is already in the counts. So a concurrent
 * change is never overwritten. A missing row can't be locked: it is created by the upsert (ON
 * CONFLICT keeps that safe too).
 */
async function recountHelpdeskCounters(db: PrismaClient): Promise<void> {
  await db.$transaction(
    async tx => {
      await tx.$executeRaw`
        SELECT "name" FROM "helpdesk_counters"
        WHERE "name" IN ('unsolved', 'waiting_on_us',
          'solved:' || to_char(date_trunc('week', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
          'confirmed:' || to_char(date_trunc('week', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
          'assumed:' || to_char(date_trunc('week', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD'))
        ORDER BY "name"
        FOR UPDATE`;
      await tx.$executeRaw`
        WITH week AS (
          SELECT date_trunc('week', now() AT TIME ZONE 'UTC') AS start
        ), resolutions AS (
          -- Driven from tickets(solved_at) (this week's few rows), each conversation by its primary
          -- key: OFFSET 0 keeps the planner from turning it into a scan of all conversations.
          SELECT count(*) FILTER (WHERE c."resolution" = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE c."resolution" = 'assumed')::int AS assumed
          FROM week, "tickets" t
          JOIN LATERAL (
            SELECT cv."resolution", cv."status" FROM "conversations" cv WHERE cv."id" = t."conversation_id" OFFSET 0
          ) c ON true
          WHERE t."solved_at" >= week.start AT TIME ZONE 'UTC' AND c."status" = 'solved'
        ), counts AS (
          SELECT 'unsolved'::text AS name,
            (SELECT count(*) FROM "conversations" WHERE "status" IN ('waiting', 'open', 'pending'))::int AS value
          UNION ALL
          SELECT 'waiting_on_us', (SELECT count(*) FROM "conversations" WHERE "status" IN ('waiting', 'open'))::int
          UNION ALL
          SELECT 'solved:' || to_char(week.start, 'YYYY-MM-DD'),
            (SELECT count(*) FROM "tickets" WHERE "solved_at" >= week.start AT TIME ZONE 'UTC')::int
          FROM week
          UNION ALL
          SELECT v.prefix || to_char(week.start, 'YYYY-MM-DD'), v.value
          FROM week, resolutions,
            LATERAL (VALUES ('confirmed:', resolutions.confirmed), ('assumed:', resolutions.assumed)) AS v(prefix, value)
        )
        INSERT INTO "helpdesk_counters" ("name", "value", "updated_at")
        SELECT name, value, now() FROM counts ORDER BY name
        ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now()
        WHERE "helpdesk_counters"."value" <> EXCLUDED."value"`;
    },
    // Three index counts and a write; status changes queue behind the row locks meanwhile.
    {maxWait: 5_000, timeout: 20_000}
  );
  // '<prefix>:YYYY-MM-DD' sorts by date within a prefix: older than 8 weeks goes (a few rows a year).
  await db.$executeRaw`
    WITH cutoff AS (
      SELECT to_char(date_trunc('week', now() AT TIME ZONE 'UTC') - interval '8 weeks', 'YYYY-MM-DD') AS week
    )
    DELETE FROM "helpdesk_counters" USING cutoff
    WHERE ("name" LIKE 'solved:%' AND "name" < 'solved:' || cutoff.week)
       OR ("name" LIKE 'confirmed:%' AND "name" < 'confirmed:' || cutoff.week)
       OR ("name" LIKE 'assumed:%' AND "name" < 'assumed:' || cutoff.week)`;
  for (let i = 0; i < VIEWS_MAX_BATCHES; i++) {
    const deleted = await db.$executeRaw`
      DELETE FROM "ticket_views" WHERE ctid IN (
        SELECT ctid FROM "ticket_views" WHERE "viewed_at" < now() - interval '7 days' LIMIT ${VIEWS_BATCH}
      )`;
    if (deleted < VIEWS_BATCH) break;
  }
}

/**
 * This site's BACKGROUND JOBS: one handler per list (docs/agent/background-jobs.md).
 *
 *   send:      sendJob(c.req.url, 'booking-reminders', {bookingId}, {at, key: `remind-${id}`, label})
 *   schedule:  background.json  {"schedules": {"daily-summary": {"every": "day", "at": "07:00", "tz": "Europe/London"}}}
 *
 * A handler gets the job's data (JSON) and returns when done. Throw to try again later;
 * throw `DontRetry` (from ../platform/background) when trying again cannot help. It may run more
 * than once: make it safe to repeat. Load what you need by id from the Site Database here; never
 * put a whole record (or a secret) in the data.
 */
export const background = defineBackground({
  // 'booking-reminders': async ({bookingId}, job) => { ... },

  /**
   * Hourly (background.json): deletes rate-limit minutes older than an hour (src/server/rate-window.ts),
   * in bounded batches. Idempotent: running it twice deletes nothing more. Anything left over
   * (a huge backlog) goes on the next run.
   */
  'rate-windows-cleanup': async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    await deleteOldRateWindows(db);
  },

  /**
   * One ticket's AI summary (sent by POST /helpdesk/conversations when the call in the request
   * failed, and by the sweep). Safe to repeat: a ticket gone or no longer `pending` is done, and
   * the write is conditional on `pending`. No key / cap reached → `unavailable` now; a failed
   * call is tried again, and the last try gives up (`unavailable`).
   */
  'ticket-summaries': async (data, job) => {
    const ticketId = data && typeof data === 'object' ? (data as {ticketId?: unknown}).ticketId : undefined;
    if (typeof ticketId !== 'number' || !Number.isSafeInteger(ticketId) || ticketId <= 0) throw new DontRetry('Bad ticket id.');
    const outcome = await runSummaryJob(siteDb(), ticketId, job.attempt >= job.maxAttempts);
    if (outcome === 'retry') throw new Error('The assistant could not summarize this ticket yet.');
  },

  /**
   * Every 15 minutes (background.json): gives up on summaries pending over 24 h, then sends jobs for
   * the ones the request and its job missed. Without SITE_URL the give-up still runs and the sends
   * are skipped (the run succeeds; the next one sends once the address is set).
   */
  'ticket-summaries-sweep': async () => {
    await sweepPendingSummaries(siteDb(), config.siteUrl);
  },

  /**
   * Nightly (background.json): recount the help desk tiles (a safety net; see above), then the
   * weekly reports (`helpdesk_stats_weekly` / `helpdesk_top_weekly`, the last 3 UTC weeks:
   * src/server/helpdesk/weekly.ts). Both are idempotent: on a throw the retry runs both again.
   */
  'helpdesk-counters': async () => {
    const db = siteDb();
    await recountHelpdeskCounters(db);
    await runWeeklyStats(db);
  },

  /**
   * Every 30 minutes, UTC (background.json schedule `knowledge-health`): starts the weekly
   * Knowledge health run once per owner-local week (Mondays 07:30 in helpdesk_settings.time_zone),
   * marks stalled runs failed, and re-sends article drafts refused at solve time
   * (src/server/knowledge/tick.ts). No retries: the next tick comes in 30 minutes.
   */
  'knowledge-health-tick': async (_data, job) => {
    await runKnowledgeTick(siteDb(), requireSiteUrl(job), new Date());
  },

  /**
   * One week's Knowledge health run {week: 'YYYY-MM-DD'} (sent by the tick; chained with a cursor
   * for big knowledge bases). No AI calls. Safe to repeat (src/server/knowledge/health.ts).
   */
  'knowledge-health': async (data, job) => {
    const week = parseWeek(field(data, 'week'));
    if (!week) throw new DontRetry('Bad week.');
    await runKnowledgeHealth(siteDb(), week, job, jobSiteUrl(job));
  },

  /** An article draft from one solved ticket {ticketId} (sent by the solve paths and the tick). */
  'article-drafts': async (data, job) => {
    const ticketId = posInt(field(data, 'ticketId'));
    if (ticketId === null) throw new DontRetry('Bad ticket id.');
    await runArticleDraftJob(siteDb(), ticketId, job);
  },

  /** A draft for one Knowledge health issue {issueId} ("Write a draft" on the screen). */
  'health-drafts': async (data, job) => {
    const issueId = posInt(field(data, 'issueId'));
    if (issueId === null) throw new DontRetry('Bad issue id.');
    await runHealthDraftJob(siteDb(), issueId, job);
  },

  /** One Test Lab batch {runId, after} ("Run all"; each batch sends the next). */
  'test-lab': async (data, job) => {
    const runId = posInt(field(data, 'runId'));
    if (runId === null) throw new DontRetry('Bad run id.');
    const after = field(data, 'after');
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after > INT_MAX) throw new DontRetry('Bad cursor.');
    // No site address: the batch ends the run (failed/stalled) instead of leaving it running.
    await runTestLabBatch(siteDb(), {runId, after}, job, jobSiteUrl(job));
  },

  /**
   * One step of reading a knowledge file {sourceId, round, step} (sent by "complete" on the Files
   * screen, by the previous step, and by the sweep). Safe to repeat: stale or duplicate deliveries
   * return, a read failure marks the file failed without a retry (src/server/kb/sources/pipeline.ts).
   */
  'kb-extract': async (data, job) => {
    const sourceId = posInt(field(data, 'sourceId'));
    const round = nonNegInt(field(data, 'round'));
    const step = nonNegInt(field(data, 'step'));
    if (sourceId === null || round === null || step === null) throw new DontRetry('Bad file job.');
    await runKbExtractJob(siteDb(), {sourceId, round, step}, job, jobSiteUrl(job));
  },

  /**
   * At :07, :22, :37 and :52 (background.json): re-sends knowledge files whose job stopped, fails
   * the ones idle over 2 h, deletes uploads never completed. Without SITE_URL the housekeeping
   * still runs and the sends are skipped.
   */
  'kb-sources-sweep': async () => {
    await sweepKbSources(siteDb(), config.siteUrl);
  },
});
