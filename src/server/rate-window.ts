import type {Context} from 'hono';

import type {PrismaClient} from '../generated/prisma/client';
import {clientIp, rateLimitIp} from '../platform/auth/kit';
import {subjectHash} from '../platform/auth/keys';
import {config} from '../platform/config';

/**
 * Per-minute request counters for public routes with no account to limit by (help-center
 * search, feedback, views; the assistant later). Table `rate_windows`: one row per bucket and
 * minute. A route checks a PER-CLIENT bucket first (`s:<hash>`, from `clientRateKey`), then a
 * SITE-WIDE one (`kb-search`, …) as a higher ceiling, so one script can't use up everyone's.
 *
 * ONE conditional upsert per bucket: the database decides, so many requests at once can't
 * overshoot. True = counted and allowed; false = this minute's limit is already reached.
 * A write with RETURNING: never re-sent on a lost connection (docs/agent/database.md).
 * Minutes older than an hour are deleted by the hourly `rate-windows-cleanup` background job
 * (src/server/background.ts, background.json).
 */
export async function takeRateWindow(db: PrismaClient, bucket: string, limitPerMinute: number): Promise<boolean> {
  const name = bucket.slice(0, 40);
  const limit = Math.max(1, Math.floor(limitPerMinute));
  const rows = await db.$queryRaw<{count: number}[]>`
    INSERT INTO "rate_windows" ("bucket", "minute", "count")
    VALUES (${name}, date_trunc('minute', now()), 1)
    ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
    WHERE "rate_windows"."count" < ${limit}
    RETURNING "count"`;
  return rows.length > 0;
}

/**
 * Takes each window in order and stops at the first one that is full (false). In order, so a
 * client over its own limit never uses up the site-wide one. One round trip per window;
 * a `null` entry (no client key) is skipped.
 */
export async function takeRateWindows(
  db: PrismaClient,
  windows: readonly (readonly [bucket: string, limitPerMinute: number] | null)[]
): Promise<boolean> {
  for (const window of windows) {
    if (window && !(await takeRateWindow(db, window[0], window[1]))) return false;
  }
  return true;
}

/**
 * Who the client is for a rate limit: the same keyed, one-way IP fingerprint the sign-in limits
 * and audit rows use (HMAC-SHA256 of the Cloudflare client IP, an IPv6 /56 as one, keyed by
 * JWT_SECRET), cut to 16 hex characters so a bucket fits VARCHAR(40). Never the raw IP.
 * `null` without JWT_SECRET: then only the site-wide limits apply.
 */
export async function clientRateKey(c: Context): Promise<string | null> {
  const secret = config.jwtSecret;
  if (!secret) return null;
  return (await subjectHash(secret, 'ip', rateLimitIp(clientIp(c)))).slice(0, 16);
}

/** Rows deleted per statement, and statements per run: bounded work inside a job's 60 seconds. */
const CLEANUP_BATCH = 5000;
const CLEANUP_MAX_BATCHES = 40;

/**
 * Deletes minutes older than an hour (no limit looks further back than this one), in batches of
 * CLEANUP_BATCH, until none are left or CLEANUP_MAX_BATCHES ran (the next hourly run finishes
 * the rest). Safe to repeat: a second run finds nothing to delete. No index on `minute` alone:
 * the table only ever holds about two hours of rows, so each batch is a short scan.
 * Returns how many rows went. Run by the `rate-windows-cleanup` background job.
 */
export async function deleteOldRateWindows(db: PrismaClient): Promise<number> {
  let total = 0;
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
    const deleted = await db.$executeRaw`
      DELETE FROM "rate_windows" WHERE ctid IN (
        SELECT ctid FROM "rate_windows" WHERE "minute" < now() - interval '1 hour' LIMIT ${CLEANUP_BATCH}
      )`;
    total += deleted;
    if (deleted < CLEANUP_BATCH) break;
  }
  return total;
}
