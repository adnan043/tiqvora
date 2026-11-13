import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {type TicketStatus, UNSOLVED} from '../../lib/helpdesk-tickets';

export type {TicketStatus};
export {UNSOLVED};

/**
 * A ticket's status, and the Overview tiles that count it, change ONLY here.
 *
 * THE status lives in `conversations.status`; `tickets.solved_at` mirrors "solved" and is written
 * in the same statement. The tiles are rows of `helpdesk_counters` kept on write (never `count()`
 * per request): `unsolved`, `waiting_on_us` and `solved:YYYY-MM-DD` (the UTC Monday of the week
 * the ticket was solved). Every change is ONE SQL statement (writable CTEs): the conditional status
 * write, the `solved_at` mirror and the counter deltas commit together or not at all, with no
 * transaction held open. The nightly `helpdesk-counters` job recounts them as a safety net.
 *
 * Every function takes the client or a transaction client (replies run them inside `idempotent()`).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const COUNTER_UNSOLVED = 'unsolved';
export const COUNTER_WAITING = 'waiting_on_us';
/** The counter of tickets solved in the week starting on the UTC Monday `week` ('YYYY-MM-DD'). */
export const solvedCounter = (week: string): string => `solved:${week}`;

/** The UTC Monday of `d`'s week, 'YYYY-MM-DD' (the `solved:` counter key; Postgres' `date_trunc('week')`). */
export function weekKey(d: Date = new Date()): string {
  const day = d.getUTCDay(); // 0 = Sunday
  const back = (day + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
  return monday.toISOString().slice(0, 10);
}

/**
 * The counters' ONE write, as a CTE body over `d (name, delta)` (non-zero, one row per name):
 * every row in name order (so two statements always lock counter rows in the same order: no
 * deadlock), each `value + delta` floored at 0, and a missing row inserted at max(delta, 0) so the
 * `value >= 0` CHECK always holds. The DO UPDATE reads its row's own delta back from `d`.
 */
const COUNTER_UPSERT = Prisma.sql`
      INSERT INTO helpdesk_counters (name, value, updated_at)
      SELECT d.name, GREATEST(d.delta, 0), now() FROM d ORDER BY d.name
      ON CONFLICT (name) DO UPDATE SET
        value = GREATEST(0, helpdesk_counters.value + (SELECT d2.delta FROM d AS d2 WHERE d2.name = EXCLUDED.name)),
        updated_at = now()
      RETURNING helpdesk_counters.name`;

export interface TransitionInput {
  conversationId: number;
  /** The statuses the conversation may be in now; anything else (or no such row) → null. */
  from: readonly TicketStatus[];
  to: TicketStatus;
  /** Default: 'assumed' when `to` is solved, else 'none'. */
  resolution?: 'confirmed' | 'assumed' | 'none';
  /** Move `last_message_at` to now (a reply came with this change). */
  touch?: boolean;
  /** Set `customer_unread` (true after an agent reply); unchanged when left out. */
  customerUnread?: boolean;
}

export interface TransitionResult {
  ticketId: number;
  number: number;
  oldStatus: TicketStatus;
  /** The ticket's `solved_at` after the change (kept when solved → solved). */
  solvedAt: Date | null;
}

/**
 * Moves ONE conversation from any of `from` to `to`, conditionally, in ONE statement: the
 * conversation's status (+ resolution, last_message_at, customer_unread when given), the ticket's
 * `solved_at`, and the counters by the delta old → new. Returns null when the conversation has no
 * ticket or wasn't in `from` (the route answers 409, or 404 after its own lookup).
 *
 * `FOR NO KEY UPDATE OF c, t` makes concurrent changes to one ticket queue up: the second one
 * re-checks `status = ANY(from)` on the committed row and finds nothing, so a race has exactly one
 * winner and the counters move once. NO KEY (not plain FOR UPDATE) because it doesn't conflict with
 * the FOR KEY SHARE a message insert takes on its conversation through the foreign key: a reply that
 * inserts its message and then calls this would otherwise deadlock (40P01) with a concurrent one.
 *
 * LOCK ORDER, everywhere (routes, deleteTicket, the nightly recount): conversations, then tickets,
 * then `helpdesk_counters` rows ORDER BY name. The counters move in ONE upsert over the non-zero
 * deltas in name order (see `COUNTER_UPSERT`): a decrement never goes below 0 (the `value >= 0`
 * CHECK), and a missing row is created at max(delta, 0) (a 0 row for a pruned old solved week).
 */
export async function transition(db: Db, input: TransitionInput): Promise<TransitionResult | null> {
  if (input.from.length === 0) return null;
  const from = [...input.from];
  const to = input.to;
  const resolution = input.resolution ?? null;
  const touch = input.touch === true;
  const customerUnread = input.customerUnread ?? null;
  const week = weekKey();
  const rows = await db.$queryRaw<
    {ticket_id: number; number: number; old_status: TicketStatus; solved_at: Date | null}[]
  >`
    WITH old AS (
      SELECT c.id, c.status, t.id AS ticket_id, t.number, t.solved_at
      FROM conversations c JOIN tickets t ON t.conversation_id = c.id
      WHERE c.id = ${input.conversationId}::int AND c.status = ANY(${from}::text[])
      FOR NO KEY UPDATE OF c, t
    ), c AS (
      UPDATE conversations SET status = ${to}::text,
        resolution = COALESCE(${resolution}::text, CASE WHEN ${to}::text = 'solved' THEN 'assumed' ELSE 'none' END),
        last_message_at = CASE WHEN ${touch}::boolean THEN now() ELSE conversations.last_message_at END,
        customer_unread = COALESCE(${customerUnread}::boolean, conversations.customer_unread),
        updated_at = now()
      FROM old WHERE conversations.id = old.id
      RETURNING conversations.id
    ), t AS (
      UPDATE tickets SET
        solved_at = CASE WHEN ${to}::text = 'solved' THEN COALESCE(old.solved_at, now()) ELSE NULL END,
        updated_at = now()
      FROM old WHERE tickets.id = old.ticket_id
      RETURNING tickets.solved_at
    ), d AS (
      SELECT v.name, sum(v.delta)::int AS delta FROM old, LATERAL (VALUES
        (${COUNTER_UNSOLVED}::text, (${to}::text <> 'solved')::int - (old.status <> 'solved')::int),
        (${COUNTER_WAITING}::text,
          (${to}::text IN ('waiting', 'open'))::int - (old.status IN ('waiting', 'open'))::int),
        ('solved:' || ${week}::text,
          CASE WHEN ${to}::text = 'solved' AND old.status <> 'solved' THEN 1 ELSE 0 END),
        ('solved:' || to_char(date_trunc('week', old.solved_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
          CASE WHEN old.status = 'solved' AND ${to}::text <> 'solved' THEN -1 ELSE 0 END)
      ) AS v(name, delta)
      WHERE v.name IS NOT NULL
      GROUP BY v.name HAVING sum(v.delta) <> 0
    ), counted AS (${COUNTER_UPSERT})
    SELECT old.ticket_id, old.number, old.status AS old_status, (SELECT solved_at FROM t) AS solved_at
    FROM old`;
  const row = rows[0];
  if (!row) return null;
  return {ticketId: row.ticket_id, number: row.number, oldStatus: row.old_status, solvedAt: row.solved_at};
}

/**
 * The counters for a NEW ticket (it starts `waiting`): `unsolved` +1, `waiting_on_us` +1. Not
 * awaited here, so it can go in the create's batch: `db.$transaction([db.conversation.create(…),
 * countCreatedTicket(db)])`. Creates the rows when missing.
 */
export function countCreatedTicket(db: PrismaClient): Prisma.PrismaPromise<number> {
  return db.$executeRaw`
    INSERT INTO helpdesk_counters (name, value, updated_at)
    SELECT v.name, 1, now() FROM (VALUES (${COUNTER_UNSOLVED}::text), (${COUNTER_WAITING}::text)) AS v(name)
    ORDER BY v.name
    ON CONFLICT (name) DO UPDATE SET value = helpdesk_counters.value + 1, updated_at = now()`;
}

export interface DeletedTicket {
  ticketId: number;
  status: TicketStatus;
  solvedAt: Date | null;
}

/**
 * Deletes ticket `number` and its whole conversation (messages, ticket and views cascade) and takes
 * it out of the counters, in ONE statement: `unsolved` −1 when it wasn't solved, `waiting_on_us` −1
 * when it was waiting/open, its solved week −1 when solved. Null when there is no such ticket (404).
 * The row lock (FOR UPDATE: a delete) makes a concurrent `transition()` wait, then find nothing.
 * Same lock order as `transition()`: conversation, ticket, then the counters by name.
 */
export async function deleteTicket(db: Db, number: number): Promise<DeletedTicket | null> {
  const rows = await db.$queryRaw<{ticket_id: number; status: TicketStatus; solved_at: Date | null}[]>`
    WITH old AS (
      SELECT c.id, c.status, t.id AS ticket_id, t.solved_at
      FROM tickets t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.number = ${number}::int
      FOR UPDATE OF c, t
    ), gone AS (
      DELETE FROM conversations USING old WHERE conversations.id = old.id
      RETURNING conversations.id
    ), d AS (
      SELECT v.name, sum(v.delta)::int AS delta FROM old, LATERAL (VALUES
        (${COUNTER_UNSOLVED}::text, -(old.status <> 'solved')::int),
        (${COUNTER_WAITING}::text, -(old.status IN ('waiting', 'open'))::int),
        ('solved:' || to_char(date_trunc('week', old.solved_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
          CASE WHEN old.status = 'solved' THEN -1 ELSE 0 END)
      ) AS v(name, delta)
      WHERE v.name IS NOT NULL
      GROUP BY v.name HAVING sum(v.delta) <> 0
    ), counted AS (${COUNTER_UPSERT})
    SELECT old.ticket_id, old.status, old.solved_at FROM old WHERE EXISTS (SELECT 1 FROM gone)`;
  const row = rows[0];
  if (!row) return null;
  return {ticketId: row.ticket_id, status: row.status, solvedAt: row.solved_at};
}
