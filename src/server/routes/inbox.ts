import type {Context} from 'hono';
import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {
  type Agent,
  customerOf,
  DELETED_CUSTOMER_NAME,
  type HelpdeskTiles,
  type InboxPage,
  type InboxRow,
  type MessageSender,
  type Presence,
  QUEUES,
  type Queue,
  type SourceLink,
  type StaffTicket,
  type ThreadMessage,
  type ThreadPage,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from '../../lib/helpdesk-tickets';
import {audit, CORE} from '../../platform/auth';
import {permissionScope, problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {IDEMPOTENCY_KEY, IdempotencyConflict, idempotent} from '../../platform/idempotency';
import {COUNTER_UNSOLVED, COUNTER_WAITING, deleteTicket, solvedCounter, transition, weekKey} from '../helpdesk/state';
import {PERMISSIONS} from '../permissions';

/**
 * The help desk inbox, for agents (`site:helpdesk:inbox`), from the dashboard.
 * Mounted at `/site-api/helpdesk/tickets` (src/server/app.ts).
 *
 *   GET    /?queue=waiting|mine|pending|solved&priority=&cursor=   a queue (20, keyset)
 *   GET    /tiles                                    the Overview tiles (counters kept on write)
 *   GET    /agents                                   who can be assigned (names, ≤ 100)
 *   GET    /:number?before=                          one ticket + its thread (notes included, 100)
 *   POST   /:number/presence                         "I'm viewing it" + who else is (polled, 30 s)
 *   POST   /:number/messages {kind, body, key, expectedStatus, setStatus?}   reply or internal note
 *   POST   /:number/status {from, to}                change the status (conditional)
 *   POST   /:number/priority {from, to}              change the priority (conditional)
 *   POST   /:number/assignee {from, to}              assign to an agent, or nobody (conditional)
 *   DELETE /:number                                  delete it and its conversation (`site:helpdesk:delete`)
 *
 * Status changes and the delete go ONLY through src/server/helpdesk/state.ts (`transition()`,
 * `deleteTicket()`), which keeps the Overview counters in the same statement. Every change is a
 * conditional write on the value the agent saw (`from` / `expectedStatus`): a race has one winner,
 * the other gets 409 `changed` and reloads. Assignment checks the assignee holds the inbox IN the
 * same statement as the write. No response carries an email: the customer is `{id, name}` (or
 * "Deleted customer"), `canSeeUser` says whether the agent may open them in Users, where the
 * email is shown to `site:user:read` holders only. Audited after commit: assigned, priority,
 * status (other moves), solved, reopened, deleted (ids, statuses and priorities only, never names
 * or text).
 *
 * `priority=` filters only the Waiting and Mine queues; on Pending and Solved it is IGNORED (the
 * `(status, last_message_at desc, id desc)` index doesn't hold the priority, so a filtered Solved
 * page scans most of the table: 826 ms measured on Solved+urgent). The dashboard hides it there.
 * Cursors out of range (a `before` past bigint, an id ≥ 2^31) are ignored: the first page.
 *
 * Not cached (docs/agent/cache.md): every read here changes with every reply, and they are
 * read by a few agents, ~3 ms each. Every answer, a validator's 422 too, is `no-store`.
 */

const PAGE = 20;
const THREAD_PAGE = 100;
const PRESENCE_SECONDS = 90;
const canWork = requirePermission(PERMISSIONS.HELPDESK_INBOX);
/** C0 control characters except tab and line feed (NUL included): never in a message. */
const CONTROL_EXCEPT_TAB_LF_RE = /[\u0000-\u0008\u000b-\u001f]/;
const NUMBER_RE = /^\d{1,9}$/;
const TIME_CURSOR_RE = /^(\d{13})\|(\d{1,10})$/;
const ID_CURSOR_RE = /^\d{1,10}$/;
const MESSAGE_ID_RE = /^\d{1,19}$/;
const MAX_BIGINT = 9223372036854775807n;
/** A UTF-16 surrogate without its pair (linear: one character of lookaround each side). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** A stored article link: exactly `/help/articles/<slug>/` (never `/\host`, `//host` or a query). */
const ARTICLE_URL_RE = /^\/help\/articles\/[a-z0-9-]{1,160}\/$/;
/** Queues the priority filter applies to (see the header). */
const PRIORITY_QUEUES: readonly Queue[] = ['waiting', 'mine'];
const FORMER_AGENT_NAME = 'Former team member';

type Fields = Record<string, string>;

class NotFound extends Error {}
class Changed extends Error {}

/** Every answer here, a validator's 422 too, is never cached (withViewer makes it `private, no-store`). */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

/** A foreign key failed: the ticket's conversation was deleted meanwhile (→ 404). */
function isForeignKeyGone(error: unknown): boolean {
  const e = error as {code?: unknown; meta?: {code?: unknown; driverAdapterError?: {cause?: {kind?: unknown; originalCode?: unknown}}}} | null;
  if (e?.code === 'P2003' || e?.code === '23503') return true;
  const cause = e?.meta?.driverAdapterError?.cause;
  return e?.meta?.code === '23503' || cause?.kind === 'ForeignKeyConstraintViolation' || cause?.originalCode === '23503';
}

/** Lone surrogates → U+FFFD, so a broken pair can't reach the validators or the database. */
const wellFormed = (text: string): string => text.replace(LONE_SURROGATE_RE, '\uFFFD');

const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const isStatus = (v: unknown): v is TicketStatus => typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);
const isPriority = (v: unknown): v is TicketPriority => typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v);

/** The ticket number in the path, or undefined (→ 404, the same answer as "no such ticket"). */
const numberOf = (value: string | undefined): number | undefined => {
  if (!value || !NUMBER_RE.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
};

/** A user id in a body: a positive safe integer, `null` for nobody, `undefined` when it's neither. */
const userIdOf = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 2 ** 31 ? value : undefined;
};

const invalid = (c: Context, fields: Fields) =>
  c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);

const notFound = (c: Context) => c.json(problem('not_found', 'No such ticket.'), 404);

const changedMeanwhile = (c: Context) =>
  c.json(problem('changed', 'Someone changed this ticket meanwhile. Review it, then try again.'), 409);

/** Every codename that grants `codename` (itself, its wildcard parents, `*`): mirrors `grants()`. */
function grantingCodenames(codename: string): string[] {
  const parts = codename.split(':');
  const out = [codename, '*'];
  for (let i = parts.length - 1; i > 0; i--) out.push(`${parts.slice(0, i).join(':')}:*`);
  return out;
}
const INBOX_CODENAMES = grantingCodenames(PERMISSIONS.HELPDESK_INBOX);

/** Users who hold the inbox through one of their roles (a subquery of user ids). */
const inboxHolderIds = Prisma.sql`
  SELECT ur.user_id FROM permissions p
  JOIN role_permissions rp ON rp.permission_id = p.id
  JOIN user_roles ur ON ur.role_id = rp.role_id
  WHERE p.codename IN (${Prisma.join(INBOX_CODENAMES)})`;

/** A message body: plain text, \r\n → \n, trimmed, no control characters but tab and newline. */
function readBody(value: unknown): {body?: string; error?: string} {
  const text = typeof value === 'string' ? wellFormed(value).replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return {error: 'Write a message first.'};
  if (text.length > TICKET_LIMITS.body) return {error: `A message is at most ${TICKET_LIMITS.body} characters.`};
  if (CONTROL_EXCEPT_TAB_LF_RE.test(text)) return {error: 'Remove the special characters from the message.'};
  return {body: text};
}

/** Article links stored as JSON (a snapshot): only well-formed entries, at most `max`. */
function linksOf(value: unknown, max: number): SourceLink[] {
  if (!Array.isArray(value)) return [];
  const out: SourceLink[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const v = objectOf(item);
    const id = typeof v.id === 'number' && Number.isSafeInteger(v.id) ? v.id : null;
    const title = typeof v.title === 'string' ? v.title.slice(0, 200) : '';
    const url = typeof v.url === 'string' ? v.url : '';
    // Article paths only: never a link out of the site (`//host`, `/\host`) from stored data.
    if (!title || !ARTICLE_URL_RE.test(url)) continue;
    out.push({id, title, url});
  }
  return out;
}

/** Who wrote a line, for staff: a deleted customer or a former agent keeps a label, never an id. */
function authorOf(sender: MessageSender, name: string | null): string | null {
  if (sender === 'ai') return null;
  if (name) return name;
  return sender === 'customer' ? DELETED_CUSTOMER_NAME : FORMER_AGENT_NAME;
}

type ThreadRow = {
  id: string;
  sender: MessageSender;
  body: string;
  cited_articles: unknown;
  confidence: string | null;
  created_at: Date;
  author: string | null;
};

/**
 * The staff thread of ticket `number`: newest first, 100 a page, notes included. ONE query on
 * `messages(conversation_id, id)`; `before` is a message id (keyset). The conversation id is a
 * scalar subquery (not a join), so the plan is one backward index range that LIMIT stops.
 */
async function staffThread(db: PrismaClient, number: number, before: string | null): Promise<ThreadPage> {
  const older = before ? Prisma.sql`AND m.id < ${before}::bigint` : Prisma.empty;
  const rows = await db.$queryRaw<ThreadRow[]>`
    SELECT m.id::text AS id, m.sender, m.body, m.cited_articles, m.confidence, m.created_at, u.name AS author
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_user_id
    WHERE m.conversation_id = (SELECT conversation_id FROM tickets WHERE number = ${number}::int) ${older}
    ORDER BY m.id DESC
    LIMIT ${THREAD_PAGE + 1}`;
  const messages: ThreadMessage[] = rows.slice(0, THREAD_PAGE).map(row => ({
    id: row.id,
    sender: row.sender,
    author: authorOf(row.sender, row.author),
    body: row.body,
    citations: row.sender === 'ai' ? linksOf(row.cited_articles, TICKET_LIMITS.citationsPerLine) : [],
    confidence: row.confidence,
    createdAt: row.created_at.toISOString(),
  }));
  return {messages, nextBefore: rows.length > THREAD_PAGE ? messages.at(-1)!.id : null};
}

type QueueRow = {
  conversation_id: number;
  status: TicketStatus;
  last_message_at: Date;
  created_at: Date;
  customer_id: number | null;
  customer_name: string | null;
  number: number;
  subject: string;
  priority: TicketPriority;
  assignee_id: number | null;
  assignee_name: string | null;
};

const toInboxRow = (row: QueueRow): InboxRow => ({
  number: row.number,
  subject: row.subject,
  status: row.status,
  priority: row.priority,
  customer: customerOf(row.customer_id === null ? null : {id: row.customer_id, name: row.customer_name ?? ''}),
  assignee: row.assignee_id === null ? null : {id: row.assignee_id, name: row.assignee_name ?? ''},
  lastMessageAt: row.last_message_at.toISOString(),
  createdAt: row.created_at.toISOString(),
});

/**
 * Waiting on us (oldest first, the partial index `conversations_waiting_idx`), Pending and Solved
 * (newest first, `(status, last_message_at desc, id desc)`). ONE query: a row-comparison keyset
 * on `(last_message_at, id)` so it stays an index range, with the names joined in.
 */
async function timeQueue(
  db: PrismaClient,
  queue: 'waiting' | 'pending' | 'solved',
  priority: TicketPriority | null,
  cursor: {at: Date; id: number} | null
): Promise<InboxPage> {
  const oldestFirst = queue === 'waiting';
  const statusWhere = oldestFirst ? Prisma.sql`c.status IN ('waiting', 'open')` : Prisma.sql`c.status = ${queue}::text`;
  const keyset = !cursor
    ? Prisma.empty
    : oldestFirst
      ? Prisma.sql`AND (c.last_message_at, c.id) > (${cursor.at}::timestamptz, ${cursor.id}::int)`
      : Prisma.sql`AND (c.last_message_at, c.id) < (${cursor.at}::timestamptz, ${cursor.id}::int)`;
  const byPriority = priority ? Prisma.sql`AND t.priority = ${priority}::text` : Prisma.empty;
  const order = oldestFirst
    ? Prisma.sql`ORDER BY c.last_message_at ASC, c.id ASC`
    : Prisma.sql`ORDER BY c.last_message_at DESC, c.id DESC`;
  const rows = await db.$queryRaw<QueueRow[]>`
    SELECT c.id AS conversation_id, c.status, c.last_message_at, c.created_at,
      u.id AS customer_id, u.name AS customer_name,
      t.number, t.subject, t.priority, t.assignee_id, a.name AS assignee_name
    FROM conversations c
    JOIN tickets t ON t.conversation_id = c.id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN users a ON a.id = t.assignee_id
    WHERE ${statusWhere} ${keyset} ${byPriority}
    ${order}
    LIMIT ${PAGE + 1}`;
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    items: page.map(toInboxRow),
    next: rows.length > PAGE && last ? `${last.last_message_at.getTime()}|${last.conversation_id}` : null,
  };
}

/** Assigned to me and not solved, newest ticket first: the index `tickets(assignee_id, solved_at, id)`. */
async function mineQueue(db: PrismaClient, me: number, priority: TicketPriority | null, cursor: number | null): Promise<InboxPage> {
  const rows = await db.ticket.findMany({
    where: {assigneeId: me, solvedAt: null, ...(cursor ? {id: {lt: cursor}} : {}), ...(priority ? {priority} : {})},
    orderBy: {id: 'desc'},
    take: PAGE + 1,
    select: {
      id: true,
      number: true,
      subject: true,
      priority: true,
      assignee: {select: {id: true, name: true}},
      conversation: {select: {status: true, lastMessageAt: true, createdAt: true, user: {select: {id: true, name: true}}}},
    },
  });
  const page = rows.slice(0, PAGE);
  return {
    items: page.map(row => ({
      number: row.number,
      subject: row.subject,
      status: row.conversation.status as TicketStatus,
      priority: row.priority as TicketPriority,
      customer: customerOf(row.conversation.user),
      assignee: row.assignee ? {id: row.assignee.id, name: row.assignee.name} : null,
      lastMessageAt: row.conversation.lastMessageAt.toISOString(),
      createdAt: row.conversation.createdAt.toISOString(),
    })),
    next: rows.length > PAGE ? String(page.at(-1)!.id) : null,
  };
}

// ------------------------------------------------------------------ validators --

const queueQuery = validator('query', value => {
  const queue: Queue = (QUEUES as readonly string[]).includes(value.queue as string) ? (value.queue as Queue) : 'waiting';
  const priority: TicketPriority | '' = isPriority(value.priority) ? value.priority : '';
  // A cursor of the wrong shape is ignored: the first page.
  const cursor = typeof value.cursor === 'string' && value.cursor.length <= 40 ? value.cursor : '';
  return {queue, priority, cursor};
});

/** `before`: a message id 1..2^63-1, else ignored (the first page), never a bigint overflow. */
const threadQuery = validator('query', value => {
  const raw = typeof value.before === 'string' && MESSAGE_ID_RE.test(value.before) ? value.before : '';
  const n = raw ? BigInt(raw) : 0n;
  return {before: n > 0n && n <= MAX_BIGINT ? n.toString() : ''};
});

/** `expectedStatus` is required for a reply; `setStatus` (open|pending|solved) is optional (default: pending). */
type MessageInput = {kind: 'reply' | 'note'; body: string; key: string; expectedStatus?: TicketStatus | null; setStatus?: TicketStatus | null};

const messageBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const fields: Fields = {};
  const kind = v.kind === 'note' ? 'note' : v.kind === 'reply' ? 'reply' : null;
  if (!kind) fields.kind = 'Choose a reply or an internal note.';
  const {body, error} = readBody(v.body);
  if (error) fields.body = error;
  const key = typeof v.key === 'string' ? v.key : '';
  if (!IDEMPOTENCY_KEY.test(key)) fields.key = 'Reload the page and send again.';
  const expectedStatus = isStatus(v.expectedStatus) ? v.expectedStatus : null;
  if (kind === 'reply' && !expectedStatus) fields.expectedStatus = 'Reload the ticket and send again.';
  let setStatus: TicketStatus | null = null;
  if (v.setStatus !== undefined && v.setStatus !== null) {
    if (kind === 'note') fields.setStatus = 'An internal note does not change the status.';
    else if (v.setStatus === 'open' || v.setStatus === 'pending' || v.setStatus === 'solved') setStatus = v.setStatus;
    else fields.setStatus = 'Choose Open, Pending or Solved.';
  }
  if (Object.keys(fields).length) return invalid(c, fields);
  return {kind: kind!, body: body!, key, expectedStatus, setStatus} as MessageInput;
});

const statusBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const fields: Fields = {};
  if (!isStatus(v.from)) fields.from = 'Reload the ticket and try again.';
  if (!isStatus(v.to)) fields.to = 'Choose Waiting on us, Open, Pending or Solved.';
  if (Object.keys(fields).length) return invalid(c, fields);
  return {from: v.from as TicketStatus, to: v.to as TicketStatus};
});

const priorityBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const fields: Fields = {};
  if (!isPriority(v.from)) fields.from = 'Reload the ticket and try again.';
  if (!isPriority(v.to)) fields.to = 'Choose Low, Normal, High or Urgent.';
  if (Object.keys(fields).length) return invalid(c, fields);
  return {from: v.from as TicketPriority, to: v.to as TicketPriority};
});

const assigneeBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const fields: Fields = {};
  const from = userIdOf(v.from);
  const to = userIdOf(v.to);
  if (from === undefined) fields.from = 'Reload the ticket and try again.';
  if (to === undefined) fields.to = 'Pick someone who works the inbox.';
  if (Object.keys(fields).length) return invalid(c, fields);
  return {from: from as number | null, to: to as number | null};
});

/**
 * The audit event of a status move, after commit: solved, reopened (from solved), or any other
 * move as `helpdesk_ticket_status` {from, to}. Statuses only.
 */
async function auditStatus(db: PrismaClient, me: number, number: number, from: TicketStatus, to: TicketStatus): Promise<void> {
  if (from === to) return;
  if (to === 'solved') {
    await audit(db, {actorUserId: me, action: 'helpdesk_ticket_solved', target: ['ticket', number], meta: {by: 'agent', from}});
  } else if (from === 'solved') {
    await audit(db, {actorUserId: me, action: 'helpdesk_ticket_reopened', target: ['ticket', number], meta: {to}});
  } else {
    await audit(db, {actorUserId: me, action: 'helpdesk_ticket_status', target: ['ticket', number], meta: {from, to}});
  }
}

// -------------------------------------------------------------------- routes --

export const inboxRoutes = new Hono()
  .use(noStore)
  .get('/', queueQuery, withViewer, requireAuth, canWork, withDb, async c => {
    const {queue, priority, cursor} = c.req.valid('query');
    const db = c.var.db;
    // Pending and Solved ignore the priority (see the header).
    const prio: TicketPriority | null = isPriority(priority) && PRIORITY_QUEUES.includes(queue) ? priority : null;
    if (queue === 'mine') {
      const id = ID_CURSOR_RE.test(cursor) ? Number(cursor) : null;
      return c.json(await mineQueue(db, c.var.viewer.id!, prio, id && id > 0 && id < 2 ** 31 ? id : null));
    }
    const m = TIME_CURSOR_RE.exec(cursor);
    const at = m ? new Date(Number(m[1])) : null;
    const id = m ? Number(m[2]) : 0;
    const keyset = at && !Number.isNaN(at.getTime()) && id > 0 && id < 2 ** 31 ? {at, id} : null;
    return c.json(await timeQueue(db, queue, prio, keyset));
  })

  // `/tiles` and `/agents` BEFORE `/:number`.
  .get('/tiles', withViewer, requireAuth, canWork, withDb, async c => {
    const solved = solvedCounter(weekKey());
    const rows = await c.var.db.helpdeskCounter.findMany({
      where: {name: {in: [COUNTER_UNSOLVED, COUNTER_WAITING, solved]}},
      select: {name: true, value: true},
    });
    const value = (name: string) => rows.find(row => row.name === name)?.value ?? 0;
    const tiles: HelpdeskTiles = {unsolved: value(COUNTER_UNSOLVED), waitingOnUs: value(COUNTER_WAITING), solvedThisWeek: value(solved)};
    return c.json(tiles);
  })

  // Active users whose roles grant the inbox (the assign menu). Names only, never an email.
  .get('/agents', withViewer, requireAuth, canWork, withDb, async c => {
    const agents = await c.var.db.$queryRaw<Agent[]>`
      SELECT u.id, u.name FROM users u
      WHERE u.status = 'active' AND u.id IN (${inboxHolderIds})
      ORDER BY u.name, u.id
      LIMIT 100`;
    return c.json({agents: agents.map(a => ({id: a.id, name: a.name}))});
  })

  .get('/:number', threadQuery, withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const db = c.var.db;
    const [row, thread, mayOpenUsers] = await Promise.all([
      db.ticket.findUnique({
        where: {number},
        select: {
          number: true,
          subject: true,
          priority: true,
          aiSummary: true,
          aiSummaryState: true,
          aiSources: true,
          csat: true,
          createdAt: true,
          solvedAt: true,
          assignee: {select: {id: true, name: true}},
          conversation: {
            select: {
              status: true,
              resolution: true,
              pagePath: true,
              language: true,
              lastMessageAt: true,
              user: {select: {id: true, name: true}},
            },
          },
        },
      }),
      staffThread(db, number, c.req.valid('query').before || null),
      permissionScope(c, CORE.USER_READ).then(scope => scope === 'all'),
    ]);
    if (!row) return notFound(c);
    const customer = customerOf(row.conversation.user);
    const ticket: StaffTicket = {
      number: row.number,
      subject: row.subject,
      status: row.conversation.status as TicketStatus,
      priority: row.priority as TicketPriority,
      resolution: row.conversation.resolution as StaffTicket['resolution'],
      customer,
      canSeeUser: mayOpenUsers && customer.id !== null,
      assignee: row.assignee ? {id: row.assignee.id, name: row.assignee.name} : null,
      aiSummary: row.aiSummaryState === 'ready' ? row.aiSummary : null,
      aiSummaryState: row.aiSummaryState as StaffTicket['aiSummaryState'],
      aiSources: linksOf(row.aiSources, TICKET_LIMITS.aiSources),
      pagePath: row.conversation.pagePath,
      language: row.conversation.language,
      csat: row.csat,
      createdAt: row.createdAt.toISOString(),
      solvedAt: row.solvedAt?.toISOString() ?? null,
      lastMessageAt: row.conversation.lastMessageAt.toISOString(),
      thread,
    };
    return c.json({ticket});
  })

  // "I'm viewing this" + who else viewed it in the last 90 s, in ONE statement. A POST: it writes.
  .post('/:number/presence', withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const me = c.var.viewer.id!;
    const rows = await c.var.db.$queryRaw<
      {status: TicketStatus; last_message_at: Date; others: {id: number; name: string; viewed_at: string}[]}[]
    >`
      WITH t AS (
        SELECT t.id, c.status, c.last_message_at
        FROM tickets t JOIN conversations c ON c.id = t.conversation_id
        WHERE t.number = ${number}::int
      ), v AS (
        INSERT INTO ticket_views (ticket_id, user_id, viewed_at)
        SELECT t.id, ${me}::int, now() FROM t
        ON CONFLICT (ticket_id, user_id) DO UPDATE SET viewed_at = EXCLUDED.viewed_at
        RETURNING ticket_id
      )
      SELECT t.status, t.last_message_at,
        COALESCE((
          SELECT json_agg(o ORDER BY o.viewed_at DESC) FROM (
            SELECT u.id, u.name, tv.viewed_at
            FROM ticket_views tv JOIN users u ON u.id = tv.user_id
            WHERE tv.ticket_id = t.id AND tv.user_id <> ${me}::int
              AND tv.viewed_at > now() - make_interval(secs => ${PRESENCE_SECONDS}::int)
            ORDER BY tv.viewed_at DESC
            LIMIT 5
          ) o
        ), '[]'::json) AS others
      FROM t`;
    const row = rows[0];
    if (!row) return notFound(c);
    const presence: Presence = {
      status: row.status,
      lastMessageAt: row.last_message_at.toISOString(),
      others: (Array.isArray(row.others) ? row.others : []).map(o => ({
        id: o.id,
        name: o.name,
        viewedAt: new Date(o.viewed_at).toISOString(),
      })),
    };
    return c.json(presence);
  })

  // A reply (to the customer) or an internal note, idempotent on `key`. A reply moves the status
  // from `expectedStatus` (what the agent saw) to `setStatus` (default: pending) in the same
  // transaction: a stale `expectedStatus` → 409 and the message is not saved.
  .post('/:number/messages', messageBody, withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const input = c.req.valid('json');
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const sender: MessageSender = input.kind === 'note' ? 'note' : 'agent';
    let result;
    try {
      result = await idempotent(
        db,
        {
          scope: `hd-agent:${me}`,
          key: input.key,
          request: {number, kind: input.kind, body: input.body, expectedStatus: input.expectedStatus ?? null, setStatus: input.setStatus ?? null},
        },
        async tx => {
          // LOCK FIRST, in transition()'s order (conversation, then ticket): taking the row locks
          // after the insert (whose FK takes a KEY SHARE on the conversation) deadlocked against a
          // concurrent transition() or customer message. A deleted ticket → no row → 404.
          const [locked] = await tx.$queryRaw<{conversation_id: number; ticket_id: number; status: TicketStatus}[]>`
            SELECT c.id AS conversation_id, t.id AS ticket_id, c.status
            FROM tickets t JOIN conversations c ON c.id = t.conversation_id
            WHERE t.number = ${number}::int
            FOR NO KEY UPDATE OF c, t`;
          if (!locked) throw new NotFound();
          // A stale status: nothing is written (the status can't move under the lock).
          if (input.kind === 'reply' && locked.status !== input.expectedStatus) throw new Changed();
          // The message, and the first response time on the first reply, in one statement.
          const rows = await tx.$queryRaw<{message_id: string; created_at: Date; author: string | null}[]>`
            WITH m AS (
              INSERT INTO messages (conversation_id, sender, author_user_id, body)
              VALUES (${locked.conversation_id}::int, ${sender}::text, ${me}::int, ${input.body}::text)
              RETURNING id, created_at
            ), f AS (
              UPDATE tickets SET first_response_at = now(), updated_at = now()
              WHERE tickets.id = ${locked.ticket_id}::int AND tickets.first_response_at IS NULL AND ${sender}::text = 'agent'
              RETURNING tickets.id
            )
            SELECT m.id::text AS message_id, m.created_at,
              (SELECT name FROM users WHERE id = ${me}::int) AS author
            FROM m`;
          const row = rows[0];
          if (!row) throw new NotFound();
          let status = locked.status;
          if (input.kind === 'reply') {
            const expected = input.expectedStatus!;
            const to = input.setStatus ?? 'pending';
            if (to !== expected) {
              const moved = await transition(tx, {
                conversationId: locked.conversation_id,
                from: [expected],
                to,
                touch: true,
                customerUnread: true,
                resolution: to === 'solved' ? 'assumed' : 'none',
              });
              if (!moved) throw new Changed();
            } else {
              const {count} = await tx.conversation.updateMany({
                where: {id: locked.conversation_id, status: expected},
                data: {lastMessageAt: new Date(), customerUnread: true},
              });
              if (!count) throw new Changed();
            }
            status = to;
          }
          const message: ThreadMessage = {
            id: row.message_id,
            sender,
            author: row.author ?? FORMER_AGENT_NAME,
            body: input.body,
            citations: [],
            confidence: null,
            createdAt: row.created_at.toISOString(),
          };
          return {message, status, from: locked.status};
        }
      );
    } catch (error) {
      if (error instanceof NotFound || isForeignKeyGone(error)) return notFound(c);
      if (error instanceof Changed) {
        return c.json(problem('changed', 'Someone changed this ticket meanwhile. Review it, then send again.'), 409);
      }
      if (error instanceof IdempotencyConflict) return c.json(problem(error.code, 'Reload the ticket and send again.'), 409);
      throw error;
    }
    const {message, status, from} = result.value;
    if (!result.replayed && input.kind === 'reply' && status !== from) await auditStatus(db, me, number, from, status);
    return c.json({message, status}, 201);
  })

  .post('/:number/status', statusBody, withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const {from, to} = c.req.valid('json');
    const db = c.var.db;
    const ticket = await db.ticket.findUnique({where: {number}, select: {conversationId: true, conversation: {select: {status: true}}}});
    if (!ticket) return notFound(c);
    if (from === to) {
      return ticket.conversation.status === from ? c.json({status: to}) : changedMeanwhile(c);
    }
    const moved = await transition(db, {conversationId: ticket.conversationId, from: [from], to});
    if (!moved) return changedMeanwhile(c);
    await auditStatus(db, c.var.viewer.id!, number, from, to);
    return c.json({status: to});
  })

  .post('/:number/priority', priorityBody, withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const {from, to} = c.req.valid('json');
    const db = c.var.db;
    const {count} = await db.ticket.updateMany({where: {number, priority: from}, data: {priority: to}});
    if (count) {
      if (from !== to) {
        await audit(db, {actorUserId: c.var.viewer.id!, action: 'helpdesk_ticket_priority', target: ['ticket', number], meta: {from, to}});
      }
      return c.json({priority: to});
    }
    const exists = await db.ticket.findUnique({where: {number}, select: {id: true}});
    return exists ? changedMeanwhile(c) : notFound(c);
  })

  // Assign to an agent (or nobody), conditional on the assignee the agent saw. Whether `to` holds
  // the inbox is checked IN the same statement as the write: no gap for a role change.
  .post('/:number/assignee', assigneeBody, withViewer, requireAuth, canWork, withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const {from, to} = c.req.valid('json');
    const db = c.var.db;
    const rows = await db.$queryRaw<
      {found: boolean; target_name: string | null; updated: boolean}[]
    >`
      WITH cur AS (
        SELECT t.id FROM tickets t
        WHERE t.number = ${number}::int
      ), target AS (
        SELECT u.id, u.name FROM users u
        WHERE u.id = ${to}::int AND u.status = 'active' AND u.id IN (${inboxHolderIds})
      ), up AS (
        UPDATE tickets SET assignee_id = ${to}::int, updated_at = now()
        WHERE tickets.number = ${number}::int
          AND tickets.assignee_id IS NOT DISTINCT FROM ${from}::int
          AND (${to}::int IS NULL OR EXISTS (SELECT 1 FROM target))
        RETURNING tickets.id
      )
      SELECT (cur.id IS NOT NULL) AS found,
        (SELECT name FROM target) AS target_name,
        EXISTS (SELECT 1 FROM up) AS updated
      FROM (SELECT 1) one LEFT JOIN cur ON true`;
    const row = rows[0];
    if (!row?.found) return notFound(c);
    if (to !== null && row.target_name === null) {
      return invalid(c, {to: 'Pick someone who works the inbox.'});
    }
    if (!row.updated) {
      // The statement's snapshot predates a concurrent winner (its UPDATE waited, then re-checked
      // the committed row): read the assignee again, in a new snapshot, so the 409 names the winner.
      const now = await db.ticket.findUnique({where: {number}, select: {assignee: {select: {id: true, name: true}}}});
      if (!now) return notFound(c);
      const assignee: Agent | null = now.assignee ? {id: now.assignee.id, name: now.assignee.name || FORMER_AGENT_NAME} : null;
      return c.json({...problem('changed', 'Someone changed this ticket meanwhile. Review it, then try again.'), assignee}, 409);
    }
    if (from !== to) {
      await audit(db, {actorUserId: c.var.viewer.id!, action: 'helpdesk_ticket_assigned', target: ['ticket', number], meta: {from, to}});
    }
    const assignee: Agent | null = to === null ? null : {id: to, name: row.target_name ?? ''};
    return c.json({assignee});
  })

  // The ticket, its whole conversation and its views; the counters move in the same statement.
  .delete('/:number', withViewer, requireAuth, requirePermission(PERMISSIONS.HELPDESK_DELETE), withDb, async c => {
    const number = numberOf(c.req.param('number'));
    if (!number) return notFound(c);
    const db = c.var.db;
    const gone = await deleteTicket(db, number);
    if (!gone) return notFound(c);
    await audit(db, {actorUserId: c.var.viewer.id!, action: 'helpdesk_ticket_deleted', target: ['ticket', number], meta: {status: gone.status}});
    return c.json({ok: true});
  });
