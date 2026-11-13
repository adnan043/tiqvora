import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {costMicrosFor} from '../../lib/ai-models';
import type {ProviderResult} from './provider';
import {recordAiCost} from './usage';

/**
 * The shared AI money helper for Phase 4 jobs (drafts, Test Lab): the reserve / hold / settle
 * pattern of src/server/helpdesk/summary.ts, parameterised. (summary.ts keeps its own private
 * copy; new code uses this file.)
 *
 *   1. `takeWindowAndReserve`: a site-wide per-minute window AND the monthly reserve (+ a hold of
 *      the call's worst case), in ONE statement. The reserve runs only if the window had room.
 *   2. The provider call. From here on the hold is ALWAYS settled.
 *   3. `costOf(result, hold)`: what the call really cost.
 *   4. `settleWith(db, cost, hold, month, settle => <the write, prefixed by settle>)`: the settle and
 *      the result's write in ONE statement; or `recordAiCost` alone when there is nothing to write.
 *
 * Every spend lands on the same `ai_usage` month row and the same cap as the assistant
 * (usage.ts). The `month` is `monthKey()` taken ONCE per call and passed to both sides.
 * All writes: never re-sent on a lost connection (database.md).
 */

/** 1 cent = 10,000 micro-dollars. */
export const MICROS_PER_CENT = 10_000;

/** Site-wide per-minute buckets, apart from the assistant's (`ai-ask`) and the summaries' (`ai-summary`). */
export const AI_DRAFT_BUCKET = 'ai-draft';
/** Article drafts and health drafts together, per minute. */
export const AI_DRAFT_PER_MINUTE = 10;
export const AI_TESTLAB_BUCKET = 'ai-testlab-batch';
/** Test Lab batches per minute (10 calls each: 30 calls a minute). */
export const AI_TESTLAB_BATCHES_PER_MINUTE = 3;

const toMicros = (n: number): bigint => BigInt(Math.max(0, Math.ceil(Number.isFinite(n) ? n : 0)));

/** The owner's monthly cap in cents → micro-dollars (negative, NaN → 0 = the assistant is off). */
export function capMicrosOf(capCents: number): number {
  return Number.isFinite(capCents) ? Math.max(0, Math.floor(capCents)) * MICROS_PER_CENT : 0;
}

export interface WindowAndReserve {
  /** The `rate_windows` bucket (≤ 40 chars). */
  bucket: string;
  /** Calls allowed in this bucket per minute, site-wide. */
  perMinute: number;
  /** The month's cap, in micro-dollars. ≤ 0 → 'cap' without a query. */
  capMicros: number;
  /** The call's worst case, held against the cap while it runs (`costMicros(model, in, out)`). */
  holdMicros: number;
  /** `monthKey()`, taken once for this call: the hold and its settle land on the same row. */
  month: string;
}

/**
 * A site-wide per-minute window AND the monthly reserve (+ hold), in ONE statement (the same
 * conditional upserts as rate-window.ts and usage.ts › reserveAiCall). A write.
 *   'ok'   the window had room and the month is under the cap: the hold is taken, call now;
 *   'busy' the window is full this minute (nothing reserved): try again later;
 *   'cap'  the month's cap is reached (the window's slot is used; nothing reserved).
 */
export async function takeWindowAndReserve(db: PrismaClient, o: WindowAndReserve): Promise<'ok' | 'busy' | 'cap'> {
  if (!Number.isFinite(o.capMicros) || o.capMicros <= 0) return 'cap';
  const cap = toMicros(o.capMicros);
  const hold = toMicros(o.holdMicros);
  const perMinute = Math.max(0, Math.floor(o.perMinute));
  const bucket = o.bucket.slice(0, 40);
  const rows = await db.$queryRaw<{window: boolean; reserved: boolean}[]>`
    WITH w AS (
      INSERT INTO "rate_windows" ("bucket", "minute", "count")
      VALUES (${bucket}, date_trunc('minute', now()), 1)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
      WHERE "rate_windows"."count" < ${perMinute}
      RETURNING 1
    ), r AS (
      INSERT INTO "ai_usage" ("month", "spent_micros", "requests", "updated_at")
      SELECT ${o.month}::date, ${hold}, 1, now() WHERE EXISTS (SELECT 1 FROM w)
      ON CONFLICT ("month") DO UPDATE
        SET "requests" = "ai_usage"."requests" + 1,
            "spent_micros" = "ai_usage"."spent_micros" + ${hold},
            "updated_at" = now()
        WHERE "ai_usage"."spent_micros" < ${cap}
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM w) AS "window", EXISTS (SELECT 1 FROM r) AS "reserved"`;
  if (!rows[0]?.window) return 'busy';
  return rows[0]?.reserved ? 'ok' : 'cap';
}

/**
 * What one call cost, in micro-dollars (as answer.ts bills an answer):
 * - a reply: every attempt (`usage.iterations`, a refused one included) at the price of the
 *   model that ran it (a server-side fallback bills at its own rate);
 * - a timeout or a lost connection: the provider may have run and billed it, so the hold stays
 *   as the cost (the cap is never under-counted);
 * - an HTTP error or an unreadable reply: nothing billed → 0 (the hold is released).
 */
export function costOf(result: ProviderResult, hold: number): number {
  if (result.ok) return result.attempts.reduce((sum, a) => sum + costMicrosFor(a.model, a.inputTokens, a.outputTokens), 0);
  return result.reason === 'timeout' || result.reason === 'network' ? hold : 0;
}

/**
 * `WITH settled AS (UPDATE ai_usage …)` (spent += cost − held, on `month`), or `Prisma.empty`
 * when cost = held (nothing to settle). Put it in front of a write so the settle and the write
 * commit together. When it is empty, the write must start its own `WITH` (if it has CTEs); when it
 * is not, further CTEs continue with `, name AS (…)`.
 */
export function settleCte(cost: number, held: number, month: string): Prisma.Sql {
  const c = toMicros(cost);
  const h = toMicros(held);
  if (c === h) return Prisma.empty;
  return Prisma.sql`WITH settled AS (
      UPDATE "ai_usage"
      SET "spent_micros" = GREATEST(0, "spent_micros" + ${c} - ${h}), "updated_at" = now()
      WHERE "month" = ${month}::date
      RETURNING 1
    )`;
}

/**
 * Runs `write(settleCte(cost, held, month))`: the caller's ONE statement that settles and writes.
 * If it fails with an error the database raised BEFORE committing (a Prisma P20xx known request
 * error), nothing was settled, so the money is settled alone with `recordAiCost`; any other
 * failure (a lost connection) may have committed, so the hold stays as spent (never settled
 * twice). The error is always rethrown.
 */
export async function settleWith<T>(
  db: PrismaClient,
  cost: number,
  held: number,
  month: string,
  write: (settle: Prisma.Sql) => Promise<T>
): Promise<T> {
  try {
    return await write(settleCte(cost, held, month));
  } catch (err) {
    const rejectedBeforeCommit = err instanceof Prisma.PrismaClientKnownRequestError && /^P20\d\d$/.test(err.code);
    if (toMicros(cost) !== toMicros(held) && rejectedBeforeCommit) {
      await recordAiCost(db, cost, held, month).catch(() => undefined);
    }
    throw err;
  }
}
