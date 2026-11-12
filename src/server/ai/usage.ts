import type {PrismaClient} from '../../generated/prisma/client';

/**
 * The assistant's monthly spending (`ai_usage`: one row per month, micro-dollars).
 *
 * The cap is a money decision: the DATABASE decides, in one conditional statement, never a
 * read-then-write in code and never the cache (docs/agent/orders-and-stock.md).
 * `reserveAiCall` counts the call only while this month's spend is under the cap;
 * `recordAiCost` adds what the call really cost once the provider answered. Both take the
 * SAME `month` (`monthKey()`, computed once per question).
 *
 * Optional hold: pass `holdMicros` (an estimate of one call) to `reserveAiCall` and the same
 * value as `heldMicros` to `recordAiCost`. The hold is added to the spend in the same statement
 * that reserves, so many asks at once can't all pass a cap that has room for only a few; the
 * record then swaps the hold for the real cost (or releases it when nothing was billed; when
 * billing is unknown, a timeout, the hold stays as the cost).
 * Without a hold, calls in flight at once may overshoot the cap by their own cost.
 *
 * Writes with RETURNING / plain UPDATEs: never re-sent on a lost connection (database.md).
 */

/** The first day of the month, UTC (midnight). */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * `YYYY-MM-DD`, bound as text and cast to `date` (no time-zone conversion on the server).
 * Computed ONCE per question and passed to both the reserve and the settle, so a call that
 * starts on the 31st at 23:59:59 and ends in the next month settles the month it was held in.
 */
export function monthKey(now?: Date): string {
  return monthStart(now).toISOString().slice(0, 10);
}

const toMicros = (n: number): bigint => BigInt(Math.max(0, Math.ceil(Number.isFinite(n) ? n : 0)));

/**
 * Counts one AI call for this month if the spend is still under `capMicros`. True = go ahead.
 * `capMicros` ≤ 0 (the assistant is off) → false without a query.
 */
export async function reserveAiCall(db: PrismaClient, capMicros: number, holdMicros: number, month: string): Promise<boolean> {
  if (!Number.isFinite(capMicros) || capMicros <= 0) return false;
  const cap = toMicros(capMicros);
  const hold = toMicros(holdMicros);
  const rows = await db.$queryRaw<{requests: number}[]>`
    INSERT INTO ai_usage (month, spent_micros, requests, updated_at)
    VALUES (${month}::date, ${hold}, 1, now())
    ON CONFLICT (month) DO UPDATE
      SET requests = ai_usage.requests + 1,
          spent_micros = ai_usage.spent_micros + ${hold},
          updated_at = now()
      WHERE ai_usage.spent_micros < ${cap}
    RETURNING requests`;
  return rows.length > 0;
}

/**
 * Adds what one call cost (`micros`) to this month, minus the hold `reserveAiCall` took
 * (`heldMicros`, 0 when none). Call it whenever tokens were billed, and with `micros = 0`
 * to release a hold when the call failed before anything was billed.
 */
export async function recordAiCost(db: PrismaClient, micros: number, heldMicros: number, month: string): Promise<void> {
  const cost = toMicros(micros);
  const held = toMicros(heldMicros);
  if (cost === held) return;
  await db.$executeRaw`
    UPDATE ai_usage
    SET spent_micros = GREATEST(0, spent_micros + ${cost} - ${held}), updated_at = now()
    WHERE month = ${month}::date`;
}

export interface MonthUsage {
  /** `YYYY-MM` */
  month: string;
  spentCents: number;
  requests: number;
}

/** This month's spend and number of calls (a primary-key read; never cached: money). */
export async function monthUsage(db: PrismaClient, now: Date = new Date()): Promise<MonthUsage> {
  const month = monthStart(now);
  const row = await db.aiUsage.findUnique({
    where: {month},
    select: {spentMicros: true, requests: true},
  });
  return {
    month: month.toISOString().slice(0, 7),
    // 1 cent = 10,000 micro-dollars; round up so a started cent shows.
    spentCents: row ? Math.ceil(Number(row.spentMicros) / 10_000) : 0,
    requests: row?.requests ?? 0,
  };
}
