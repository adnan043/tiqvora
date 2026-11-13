import type {Context} from 'hono';
import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {
  type CreateConversationResult,
  customerCanReply,
  type MyTicket,
  type MyTicketRow,
  type MyTicketsPage,
  type Resolution,
  type SolveResult,
  type SourceLink,
  type ThreadMessage,
  type ThreadPage,
  TICKET_LIMITS,
  type TicketStatus,
  ticketSubject,
  UNSOLVED,
} from '../../lib/helpdesk-tickets';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requireVerified, withDb, withViewer} from '../../platform/guards';
import {IDEMPOTENCY_KEY, IdempotencyConflict, idempotent} from '../../platform/idempotency';
import {maskPersonalData} from '../ai/answer';
import {confirmResolution, countCreatedTicket, transition} from '../helpdesk/state';
import {summarizeNewTicket} from '../helpdesk/summary';
import {queueArticleDraftLater} from '../knowledge/drafts';
import {HELPDESK_DEFAULTS} from '../kb/settings';
import {clientRateKey, takeHourWindow, takeRateWindow} from '../rate-window';

/**
 * Talking to a person, the CUSTOMER side: the chat widget's hand-off and "My support".
 * Every route: signed-in users only, and every read and write has `user_id = me` IN its WHERE,
 * so someone else's ticket answers exactly like a missing one (404). Customers never receive
 * internal notes, the AI summary, the AI sources, `confidence`, the priority or the assignee.
 *
 * Mounted in src/server/app.ts, BEFORE `/helpdesk`:
 *   .route('/helpdesk/conversations', conversationRoutes)
 *   .route('/helpdesk/my', myTicketRoutes)
 *
 *   POST /site-api/helpdesk/conversations                  hand-off {key, transcript, note?, page?}
 *                                                          → 201 (200 + created:false on a repeat key)
 *   GET  /site-api/helpdesk/my/tickets?before=             my tickets, newest first (20, keyset)
 *   GET  /site-api/helpdesk/my/unread                      {count} of tickets with an unread reply (≤ 10)
 *   GET  /site-api/helpdesk/my/tickets/:number?before=     one ticket and its thread (100 a page)
 *   POST /site-api/helpdesk/my/tickets/:number/seen        clears the unread flag
 *   POST /site-api/helpdesk/my/tickets/:number/messages    {body, key} a reply (idempotent)
 *   POST /site-api/helpdesk/my/tickets/:number/solve       the customer says it's solved (an agent's solve → confirmed)
 *                                                          → {status, confirmed} (SolveResult: the ACTUAL status)
 *   POST /site-api/helpdesk/my/tickets/:number/csat        {score 1–5}, once, while solved
 *
 * Limits: hand-offs and replies share ONE window of TICKET_LIMITS.customerPerHour per account and
 * hour (`takeHourWindow`, a conditional upsert: the database decides). The window is taken INSIDE
 * the transaction that does the work, after the ownership check, so anything that rolls back
 * (someone else's ticket, a closed one, a key conflict, a hand-off that lost a same-key race)
 * gives its slot back, and a replay (the work never runs) never takes one. A repeated hand-off
 * key is answered before any window. A hand-off also needs a VERIFIED account and passes a
 * per-client window first (HANDOFF_PER_MINUTE a minute per IP fingerprint, `clientRateKey`).
 *
 * Every text field has lone UTF-16 surrogates replaced with U+FFFD before it is validated: one
 * can't be stored (Postgres text, the idempotency jsonb cast) and would answer 500.
 *
 * The hand-off's transcript comes from the browser (the widget keeps it in sessionStorage): it is
 * stored as `customer` / `ai` lines with personal data masked (`maskPersonalData`, as the question
 * log does; the hand-off note too, for the same reason), `tokens = 0` and no confidence — the
 * staff view labels such `ai` lines "from the chat, as shown to the customer": they are the
 * customer's copy, never verified. A cited article is kept only when its slug is a PUBLISHED
 * article, with the database's title and URL (never the client's words); customers get those
 * links back with `id: null`. The AI summary is asked for AFTER the create commits and AFTER the
 * answer (`waitUntil`, never awaited by the request), with a short timeout (`summarizeNewTicket`,
 * src/server/helpdesk/summary.ts): anything but success or "off" hands it to the
 * `ticket-summaries` background job. The hand-off's answer never carries the summary.
 */

const PAGE = 20;
const THREAD_PAGE = 100;
/** Hand-offs per client (IP fingerprint) and minute, before the per-account hourly window. */
const HANDOFF_PER_MINUTE = 5;
/** The largest cursors the columns hold: conversations.id is INT, messages.id BIGINT. */
const MAX_INT4 = 2147483647;
const MAX_INT8 = 9223372036854775807n;
/** Article links in a transcript: the public help center's article pages only. */
const ARTICLE_URL_RE = /^\/help\/articles\/([a-z0-9-]{1,160})\/$/;
const CITATION_TITLE_MAX = 200;
/** The transcript's UTF-8 size (the Site API refuses bodies over 64 KB; a note rides along). */
const TRANSCRIPT_BYTES = 40_000;
const PAGE_PATH_MAX = 300;
const LANGUAGE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;
/** C0 control characters except tab and line feed (NUL included): never in a message. */
const CONTROL_EXCEPT_TAB_LF_RE = /[\u0000-\u0008\u000b-\u001f]/;
const NUMBER_RE = /^\d{1,9}$/;
const CONVERSATION_CURSOR_RE = /^\d{1,10}$/;
const MESSAGE_CURSOR_RE = /^\d{1,19}$/;
const RATE_BUCKET = (userId: number) => `hd-msg:${userId}`;

type Fields = Record<string, string>;
const invalid = (c: Context, fields: Fields) =>
  c.json(
    {
      ...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'),
      fields,
    },
    422,
  );
const NOT_FOUND = problem('not_found', 'No such ticket.');
const notFound = (c: Context) => c.json(NOT_FOUND, 404);
const rateLimited = (c: Context) =>
  c.json(problem('rate_limited', "You've sent a lot of messages. Try again within the hour."), 429);
const tooManyHandoffs = (c: Context) => {
  c.header('Retry-After', '60');
  return c.json(problem('rate_limited', 'Too many requests from your connection. Try again in a minute.'), 429);
};
const changedMeanwhile = (c: Context) =>
  c.json(problem('changed', 'This conversation changed meanwhile. Reload it and try again.'), 409);
const codeOf = (error: unknown) => (error as {code?: unknown} | null)?.code;

/**
 * A foreign key refused the write (the ticket was deleted meanwhile): Prisma's P2003, or
 * Postgres' 23503 as a raw query or the driver adapter reports it.
 */
function isForeignKeyError(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    meta?: {code?: unknown; driverAdapterError?: {cause?: {originalCode?: unknown; kind?: unknown}}};
  } | null;
  if (!e) return false;
  const cause = e.meta?.driverAdapterError?.cause;
  return (
    e.code === 'P2003' ||
    e.code === '23503' ||
    e.meta?.code === '23503' ||
    cause?.originalCode === '23503' ||
    cause?.kind === 'ForeignKeyConstraintViolation'
  );
}

/** Lone UTF-16 surrogates → U+FFFD (a well-formed pair is kept). */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const wellFormed = (value: string) => value.replace(LONE_SURROGATE_RE, '�');
/** A client value: a string made well-formed, anything else as it is (the validators refuse it). */
const clean = (value: unknown): unknown => (typeof value === 'string' ? wellFormed(value) : value);

/** Every answer here, a validator's 422 too, is never cached (withViewer makes it `private, no-store`). */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

const textError = (value: string, max: number, what: string): string | null => {
  if (CONTROL_EXCEPT_TAB_LF_RE.test(value)) return `${what} has characters that cannot be sent. Type it again as plain text.`;
  if (value.length > max) return `Keep ${what.toLowerCase()} under ${max.toLocaleString('en-US')} characters.`;
  return null;
};

/** The first tag of Accept-Language (`pt-BR,pt;q=0.9` → `pt-BR`), or '' (as routes/helpdesk.ts). */
function languageOf(header: string | undefined): string {
  const tag = (header ?? '').split(',', 1)[0].split(';', 1)[0].trim();
  return tag.length <= 16 && LANGUAGE_RE.test(tag) ? tag : '';
}

/* ----------------------------------------------------------------- validators */

type TranscriptLine = {
  role: 'customer' | 'assistant';
  text: string;
  citations: {title: string; url: string; slug: string}[];
};
type CreateBody = {
  key: string;
  transcript: TranscriptLine[];
  note: string;
  page: string;
};

const createBody = validator('json', (value, c) => {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

  const key = typeof v.key === 'string' ? v.key : '';
  if (!IDEMPOTENCY_KEY.test(key)) {
    return invalid(c, {
      key: 'The request key is 16 to 64 letters, digits, - or _. Reload the page and try again.',
    });
  }

  const transcript: TranscriptLine[] = [];
  if (v.transcript !== undefined && v.transcript !== null) {
    const tooLong = 'The conversation is too long to send. Tell us what you need in your own words instead.';
    if (!Array.isArray(v.transcript) || v.transcript.length > TICKET_LIMITS.transcriptLines) {
      return invalid(c, {transcript: tooLong});
    }
    let chars = 0;
    let bytes = 0;
    const encoder = new TextEncoder();
    for (const item of v.transcript as unknown[]) {
      const entry = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
      const entryText = clean(entry.text);
      if ((entry.role !== 'customer' && entry.role !== 'assistant') || typeof entryText !== 'string') {
        return invalid(c, {
          transcript: 'Each message needs a role (customer or assistant) and its text.',
        });
      }
      if (CONTROL_EXCEPT_TAB_LF_RE.test(entryText)) {
        return invalid(c, {
          transcript: 'A message has characters that cannot be sent. Start a new conversation.',
        });
      }
      const text = entryText.trim();
      if (text.length > TICKET_LIMITS.body) return invalid(c, {transcript: tooLong});
      chars += text.length;
      bytes += encoder.encode(text).length;
      if (chars > TICKET_LIMITS.transcriptChars || bytes > TRANSCRIPT_BYTES) return invalid(c, {transcript: tooLong});

      const citations: TranscriptLine['citations'] = [];
      if (entry.citations !== undefined && entry.citations !== null) {
        if (!Array.isArray(entry.citations) || entry.citations.length > TICKET_LIMITS.citationsPerLine) {
          return invalid(c, {
            transcript: 'A message has too many article links.',
          });
        }
        for (const raw of entry.citations as unknown[]) {
          const link = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
          // The client's title is checked as before but never stored: the database's is (below).
          const rawTitle = clean(link.title);
          const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
          const url = typeof link.url === 'string' ? link.url : '';
          const match = ARTICLE_URL_RE.exec(url);
          if (!title || title.length > CITATION_TITLE_MAX || CONTROL_EXCEPT_TAB_LF_RE.test(title) || !match) {
            return invalid(c, {
              transcript: 'An article link in the conversation is not one of ours.',
            });
          }
          citations.push({title, url, slug: match[1]!});
        }
      }
      // Blank lines carry nothing; links only belong to the assistant's lines.
      if (text)
        transcript.push({
          role: entry.role,
          text,
          citations: entry.role === 'assistant' ? citations : [],
        });
    }
  }

  let note = '';
  if (v.note !== undefined && v.note !== null) {
    const rawNote = clean(v.note);
    if (typeof rawNote !== 'string') return invalid(c, {note: 'Tell us what you need help with, as text.'});
    note = rawNote.trim();
    const error = textError(note, TICKET_LIMITS.note, 'Your message');
    if (error) return invalid(c, {note: error});
  }
  if (!note && !transcript.some(line => line.role === 'customer')) {
    return invalid(c, {note: 'Tell us what you need help with.'});
  }

  let page = '';
  if (v.page !== undefined && v.page !== null && v.page !== '') {
    const rawPage = clean(v.page);
    const path = typeof rawPage === 'string' ? rawPage.split(/[?#]/, 1)[0]! : '';
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.startsWith('/\\') ||
      path.length > PAGE_PATH_MAX ||
      /[\u0000-\u001f\u007f\s\ufffd]/.test(path)
    ) {
      return invalid(c, {page: 'The page must be a path such as /help/.'});
    }
    page = path;
  }

  return {key, transcript, note, page} satisfies CreateBody;
});

/** `:number` → the ticket number, or the same 404 as a missing ticket. */
const numberParam = validator('param', (value, c) =>
  NUMBER_RE.test(value.number ?? '') ? {number: Number(value.number)} : notFound(c),
);

/** `?before=` on the list: my own conversation id (INT). Anything else, or out of range → the first page. */
const listQuery = validator('query', value => {
  const raw = typeof value.before === 'string' ? value.before : '';
  const before = CONVERSATION_CURSOR_RE.test(raw) ? Number(raw) : null;
  return {
    before: before && Number.isSafeInteger(before) && before > 0 && before <= MAX_INT4 ? before : null,
  };
});

/** `?before=` on a thread: a message id (BIGINT). Anything else, or out of range → the newest page. */
const threadQuery = validator('query', value => {
  const raw = typeof value.before === 'string' ? value.before : '';
  if (!MESSAGE_CURSOR_RE.test(raw)) return {before: null};
  const before = BigInt(raw);
  return {before: before > 0n && before <= MAX_INT8 ? before : null};
});

const replyBody = validator('json', (value, c) => {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const rawBody = clean(v.body);
  const body = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (!body) return invalid(c, {body: 'Type your message.'});
  const error = textError(body, TICKET_LIMITS.body, 'Your message');
  if (error) return invalid(c, {body: error});
  const key = typeof v.key === 'string' ? v.key : '';
  if (!IDEMPOTENCY_KEY.test(key)) {
    return invalid(c, {
      key: 'The request key is 16 to 64 letters, digits, - or _. Reload the page and try again.',
    });
  }
  return {body, key};
});

const csatBody = validator('json', (value, c) => {
  const score = (value as {score?: unknown} | null)?.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    return invalid(c, {score: 'Pick a number from 1 to 5.'});
  }
  return {score};
});

/* ----------------------------------------------------------------- helpers */

/**
 * A stored `cited_articles` value → links FOR THE CUSTOMER, dropping anything that isn't one of
 * the help center's article pages. The internal article id is never sent (`id: null`).
 */
function linksOf(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return [];
  const out: SourceLink[] = [];
  for (const item of value) {
    const link = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof link.title !== 'string' || typeof link.url !== 'string' || !ARTICLE_URL_RE.test(link.url)) continue;
    out.push({id: null, title: link.title, url: link.url});
  }
  return out;
}

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());

type ThreadRow = {
  id: bigint;
  sender: string;
  body: string;
  cited_articles: unknown;
  created_at: Date;
  author: string | null;
};

/**
 * One page of MY ticket's thread, newest first, in ONE query: the owner filter is IN the query
 * (so it runs alongside the header read), and notes are never selected. The conversation is a
 * scalar subquery and the cursor a plain bound, so both are index conditions on
 * `messages (conversation_id, id)`: a backward scan the LIMIT stops (not a join that sorts the
 * whole thread first).
 */
async function myThread(db: PrismaClient, number: number, me: number, before: bigint | null): Promise<ThreadPage> {
  const rows = await db.$queryRaw<ThreadRow[]>`
    SELECT m."id", m."sender", m."body", m."cited_articles", m."created_at", u."name" AS "author"
    FROM "messages" m
    LEFT JOIN "users" u ON u."id" = m."author_user_id"
    WHERE m."conversation_id" = (
        SELECT c."id" FROM "conversations" c JOIN "tickets" t ON t."conversation_id" = c."id"
        WHERE t."number" = ${number}::int AND c."user_id" = ${me}::int AND c."status" <> 'ai'
      )
      AND m."sender" <> 'note'
      AND m."id" < ${before ?? MAX_INT8}::bigint
    ORDER BY m."id" DESC
    LIMIT ${THREAD_PAGE + 1}`;
  const page = rows.slice(0, THREAD_PAGE);
  return {
    messages: page.map(row => ({
      id: String(row.id),
      sender: row.sender as ThreadMessage['sender'],
      author: row.sender === 'ai' ? null : row.author,
      body: row.body,
      citations: row.sender === 'ai' ? linksOf(row.cited_articles) : [],
      // Customers never see how sure the assistant was.
      confidence: null,
      createdAt: iso(row.created_at),
    })),
    nextBefore: rows.length > THREAD_PAGE ? String(page[page.length - 1]!.id) : null,
  };
}

/** Thrown inside a reply's transaction: rolls it back (the key is freed), mapped to an answer. */
class ReplyRefused extends Error {
  constructor(readonly reason: 'not_found' | 'closed' | 'changed' | 'rate_limited') {
    super(reason);
  }
}

/* ----------------------------------------------------------------- the hand-off */

/** Thrown inside the hand-off's transaction when the hourly window is full: rolls it back. */
class HandoffRateLimited extends Error {}

/**
 * AI summaries started by hand-offs that had no execution context to hand them to (tests, an
 * in-process call): kept here so they can be awaited. On the Worker they go to `waitUntil`.
 */
const unattendedSummaries = new Set<Promise<unknown>>();

/**
 * Test hook: waits for every hand-off summary started without an execution context. The
 * integration harness gives each request one and drains its `waitUntil` work before it returns,
 * so tests going through it need nothing; a test calling the app without a context awaits this.
 */
export async function settleHandoffSummariesForTests(): Promise<void> {
  while (unattendedSummaries.size) await Promise.all([...unattendedSummaries]);
}

/** Runs the summary after the answer is sent: never awaited by the request, never throws. */
function summarizeLater(c: Context, work: Promise<unknown>): void {
  const guarded = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context: it simply runs on (kept for settleHandoffSummariesForTests).
    unattendedSummaries.add(guarded);
    void guarded.finally(() => unattendedSummaries.delete(guarded));
  }
}

export const conversationRoutes = new Hono()
  .use(noStore)
  .post('/', createBody, withViewer, requireAuth, requireVerified, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {key, transcript, note, page} = c.req.valid('json');

    const slugs = [...new Set(transcript.flatMap(line => line.citations.map(link => link.slug)))].slice(0, 50);

    // 1 round trip: a repeat of this hand-off, the cited PUBLISHED articles, the assistant's cap and model.
    const [existing, articles, settings, clientKey] = await Promise.all([
      db.conversation.findFirst({
        where: {userId: me, requestKey: key},
        select: {status: true, ticket: {select: {number: true}}},
      }),
      slugs.length
        ? db.kbArticle.findMany({
            where: {slug: {in: slugs}, status: 'published'},
            select: {id: true, slug: true, title: true},
            take: slugs.length,
          })
        : Promise.resolve([] as {id: number; slug: string; title: string}[]),
      db.helpdeskSettings.findUnique({
        where: {id: 1},
        select: {monthlyCapCents: true, model: true},
      }),
      clientRateKey(c),
    ]);
    if (existing?.ticket) {
      const body: CreateConversationResult = {
        ticket: {
          number: existing.ticket.number,
          status: existing.status as TicketStatus,
        },
        created: false,
      };
      return c.json(body, 200);
    }

    // 1 round trip: this client's hand-offs this minute (one script, many accounts).
    if (clientKey && !(await takeRateWindow(db, `hd-handoff:${clientKey}`, HANDOFF_PER_MINUTE))) return tooManyHandoffs(c);

    // Only published articles, with OUR title and URL: a forged line can't link anywhere else.
    const articleBySlug = new Map(articles.map(article => [article.slug, article]));
    const lines: {
      sender: 'customer' | 'ai';
      body: string;
      citedArticles?: SourceLink[];
    }[] = transcript.map(line => {
      const body = wellFormed(maskPersonalData(line.text).slice(0, TICKET_LIMITS.body));
      if (line.role === 'customer') return {sender: 'customer', body};
      const citedArticles: SourceLink[] = [];
      const cited = new Set<string>();
      for (const link of line.citations) {
        const article = articleBySlug.get(link.slug);
        if (!article || cited.has(article.slug)) continue;
        cited.add(article.slug);
        citedArticles.push({id: article.id, title: article.title, url: `/help/articles/${article.slug}/`});
      }
      return {
        sender: 'ai',
        body,
        ...(citedArticles.length ? {citedArticles} : {}),
      };
    });
    // The customer's own words to the team close the thread, masked like the transcript lines
    // (the same personal data rules for everything the hand-off stores and summarizes).
    if (note) lines.push({sender: 'customer', body: wellFormed(maskPersonalData(note).slice(0, TICKET_LIMITS.body))});

    const sources: SourceLink[] = [];
    const seen = new Set<string>();
    for (const link of lines.flatMap(line => line.citedArticles ?? [])) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      sources.push(link);
      if (sources.length >= TICKET_LIMITS.aiSources) break;
    }
    const hasCustomerText = lines.some(line => line.sender === 'customer');
    const subject =
      wellFormed(ticketSubject(lines.find(line => line.sender === 'customer')?.body ?? '')) || 'Help request';

    const readBack = () =>
      db.conversation.findFirst({
        where: {userId: me, requestKey: key},
        select: {status: true, ticket: {select: {number: true}}},
      });

    // 1 transaction: the hourly window, the conversation, its lines, its ticket and the two tiles,
    // all or nothing. The window is taken inside it, so a refusal or a lost same-key race (P2002)
    // rolls the slot back with everything else.
    let created: {id: number; ticket: {id: number; number: number} | null};
    try {
      created = await db.$transaction(async tx => {
        if (!(await takeHourWindow(tx, RATE_BUCKET(me), TICKET_LIMITS.customerPerHour))) throw new HandoffRateLimited();
        const row = await tx.conversation.create({
          data: {
            userId: me,
            requestKey: key,
            pagePath: page,
            language: languageOf(c.req.header('accept-language')),
            status: 'waiting',
            messages: {
              createMany: {
                data: lines.map(line => ({
                  sender: line.sender,
                  authorUserId: line.sender === 'customer' ? me : null,
                  body: line.body,
                  ...(line.citedArticles
                    ? {
                        citedArticles: line.citedArticles as unknown as Prisma.InputJsonValue,
                      }
                    : {}),
                })),
              },
            },
            ticket: {
              create: {
                subject,
                ...(sources.length ? {aiSources: sources as unknown as Prisma.InputJsonValue} : {}),
                // Something the customer said to summarize (the validator makes sure there is).
                aiSummaryState: hasCustomerText ? 'pending' : 'unavailable',
              },
            },
          },
          select: {id: true, ticket: {select: {id: true, number: true}}},
        });
        // Only $executeRaw is used: a transaction client runs it the same way.
        await countCreatedTicket(tx as unknown as PrismaClient);
        return row;
      });
    } catch (error) {
      if (error instanceof HandoffRateLimited) return rateLimited(c);
      // The same key won a race (P2002), or the commit's answer was lost: what's stored decides.
      const again = await readBack().catch(() => null);
      if (again?.ticket) {
        const body: CreateConversationResult = {
          ticket: {
            number: again.ticket.number,
            status: again.status as TicketStatus,
          },
          created: codeOf(error) !== 'P2002',
        };
        return c.json(body, codeOf(error) === 'P2002' ? 200 : 201);
      }
      throw error;
    }

    const ticket = created.ticket!;
    if (hasCustomerText) {
      // After commit AND after the answer (waitUntil); never throws. Ready, unavailable, or left
      // pending for the job / the sweep.
      summarizeLater(
        c,
        summarizeNewTicket(db, {
          requestUrl: c.req.url,
          ticketId: ticket.id,
          number: ticket.number,
          lines: lines.map(line => ({sender: line.sender, body: line.body})),
          // No row: the schema's defaults (money: read from the database, never the cache).
          settings: {
            monthlyCapCents: settings?.monthlyCapCents ?? 2000,
            model: settings?.model ?? HELPDESK_DEFAULTS.model,
          },
        }),
      );
    }

    const body: CreateConversationResult = {
      ticket: {number: ticket.number, status: 'waiting'},
      created: true,
    };
    return c.json(body, 201);
  });

/* ----------------------------------------------------------------- My support */

export const myTicketRoutes = new Hono()
  .use(noStore)

  .get('/tickets', listQuery, withViewer, requireAuth, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {before} = c.req.valid('query');
    const rows = await db.conversation.findMany({
      where: {
        userId: me,
        status: {not: 'ai'},
        ...(before ? {id: {lt: before}} : {}),
      },
      orderBy: {id: 'desc'},
      take: PAGE + 1,
      select: {
        id: true,
        status: true,
        customerUnread: true,
        lastMessageAt: true,
        createdAt: true,
        ticket: {select: {number: true, subject: true}},
      },
    });
    const page = rows.slice(0, PAGE);
    const items: MyTicketRow[] = page.flatMap(row =>
      row.ticket
        ? [
            {
              number: row.ticket.number,
              subject: row.ticket.subject,
              status: row.status as TicketStatus,
              unread: row.customerUnread,
              lastMessageAt: iso(row.lastMessageAt),
              createdAt: iso(row.createdAt),
            },
          ]
        : [],
    );
    const body: MyTicketsPage = {
      items,
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
    return c.json(body);
  })

  .get('/unread', withViewer, requireAuth, withDb, async c => {
    // Capped: the badge shows "9+" (partial index conversations_unread_idx).
    const rows = await c.var.db.conversation.findMany({
      where: {userId: c.var.viewer.id!, customerUnread: true},
      select: {id: true},
      take: 10,
    });
    return c.json({count: rows.length});
  })

  .get('/tickets/:number', numberParam, threadQuery, withViewer, requireAuth, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {number} = c.req.valid('param');
    const {before} = c.req.valid('query');
    // 1 round trip: the header and the thread, both with `user_id = me` in the query.
    const [header, thread] = await Promise.all([
      db.ticket.findFirst({
        where: {
          number,
          conversation: {is: {userId: me, status: {not: 'ai'}}},
        },
        select: {
          number: true,
          subject: true,
          csat: true,
          solvedAt: true,
          createdAt: true,
          conversation: {select: {status: true, resolution: true}},
        },
      }),
      myThread(db, number, me, before),
    ]);
    if (!header) return notFound(c);
    const status = header.conversation.status as TicketStatus;
    const ticket: MyTicket = {
      number: header.number,
      subject: header.subject,
      status,
      resolution: header.conversation.resolution as Resolution,
      createdAt: iso(header.createdAt),
      solvedAt: header.solvedAt ? iso(header.solvedAt) : null,
      csat: header.csat,
      canReply: customerCanReply(status, header.solvedAt),
      canRate: status === 'solved' && header.csat === null,
      thread,
    };
    return c.json({ticket});
  })

  .post('/tickets/:number/seen', numberParam, withViewer, requireAuth, withDb, async c => {
    const {number} = c.req.valid('param');
    // Conditional and owner-scoped: nothing to clear (or not mine) is fine and says nothing.
    await c.var.db.conversation.updateMany({
      where: {
        userId: c.var.viewer.id!,
        customerUnread: true,
        ticket: {is: {number}},
      },
      data: {customerUnread: false},
    });
    return c.json({ok: true as const});
  })

  .post('/tickets/:number/messages', numberParam, replyBody, withViewer, requireAuth, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const author = c.var.viewer.name;
    const {number} = c.req.valid('param');
    const {body, key} = c.req.valid('json');

    try {
      const {value} = await idempotent(db, {scope: `hd-reply:${me}`, key, request: {number, body}}, async tx => {
        // LOCK FIRST, in the order transition() locks (conversation, then ticket): inserting the
        // message before it took a KEY SHARE on the conversation that a parallel reply's
        // transition() then waited on while holding its own (a deadlock). Owner-scoped: someone
        // else's ticket is not found and takes no lock.
        const [conversation] = await tx.$queryRaw<{id: number; status: string; ticket_id: number; solved_at: Date | null}[]>`
          SELECT c."id", c."status", t."id" AS "ticket_id", t."solved_at"
          FROM "conversations" c JOIN "tickets" t ON t."conversation_id" = c."id"
          WHERE t."number" = ${number}::int AND c."user_id" = ${me}::int
          FOR NO KEY UPDATE OF c, t`;
        if (!conversation || conversation.status === 'ai') throw new ReplyRefused('not_found');
        const status = conversation.status as TicketStatus;
        if (!customerCanReply(status, conversation.solved_at)) throw new ReplyRefused('closed');

        // Mine and open: now it counts. In this transaction, so a rollback gives the slot back.
        if (!(await takeHourWindow(tx, RATE_BUCKET(me), TICKET_LIMITS.customerPerHour))) {
          throw new ReplyRefused('rate_limited');
        }

        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            sender: 'customer',
            authorUserId: me,
            body,
          },
          select: {id: true, createdAt: true},
        });
        if (status !== 'waiting') {
          // Back to "with our team" (a solved one reopens): conditional on what we read.
          const moved = await transition(tx, {
            conversationId: conversation.id,
            from: [status],
            to: 'waiting',
            touch: true,
            resolution: 'none',
          });
          if (!moved) throw new ReplyRefused('changed');
        } else {
          const {count} = await tx.conversation.updateMany({
            where: {id: conversation.id, status: 'waiting'},
            data: {lastMessageAt: new Date()},
          });
          if (!count) throw new ReplyRefused('changed');
        }
        const thread: ThreadMessage = {
          id: String(message.id),
          sender: 'customer',
          author,
          body,
          citations: [],
          confidence: null,
          createdAt: iso(message.createdAt),
        };
        return {message: thread, status: 'waiting' as TicketStatus};
      });
      return c.json(value, 201);
    } catch (error) {
      if (error instanceof ReplyRefused) {
        if (error.reason === 'not_found') return notFound(c);
        if (error.reason === 'rate_limited') return rateLimited(c);
        if (error.reason === 'closed') {
          return c.json(problem('closed', 'This conversation is closed. Start a new one from the help center.'), 409);
        }
        return changedMeanwhile(c);
      }
      if (error instanceof IdempotencyConflict) {
        return c.json(problem(error.code, 'This message was already sent with different text. Reload and try again.'), 409);
      }
      // The ticket was deleted between the lookup and the insert.
      if (isForeignKeyError(error)) return notFound(c);
      throw error;
    }
  })

  .post('/tickets/:number/solve', numberParam, withViewer, requireAuth, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {number} = c.req.valid('param');
    const conversation = await db.conversation.findFirst({
      where: {
        userId: me,
        status: {not: 'ai'},
        ticket: {is: {number}},
      },
      select: {id: true, status: true},
    });
    if (!conversation) return notFound(c);
    // Not solved yet: solve it as confirmed (the counters move in the same statement).
    if (conversation.status !== 'solved') {
      const moved = await transition(db, {
        conversationId: conversation.id,
        from: [...UNSOLVED],
        to: 'solved',
        resolution: 'confirmed',
      });
      if (moved) {
        await audit(db, {
          actorUserId: me,
          action: 'helpdesk_ticket_solved',
          target: ['ticket', number],
          meta: {by: 'customer', from: moved.oldStatus},
        });
        // After commit AND after the answer (waitUntil): an article draft from this solved ticket
        // (never throws; not on "already solved"; a lost send is picked up by the tick's sweep).
        queueArticleDraftLater(c, moved.ticketId, number);
        return c.json({status: 'solved', confirmed: true} satisfies SolveResult);
      }
      // Lost a race (a second press, or an agent solved or moved it meanwhile): fall through to the
      // solved path, which upgrades an agent's solve or answers with what the ticket is now.
    }
    // Solved: an agent's solve ("assumed") inside the reopen window is upgraded to "confirmed"
    // (counters moved in the same statement). No article draft here: the agent's solve queued it.
    const upgraded = await confirmResolution(db, conversation.id);
    if (upgraded) {
      await audit(db, {
        actorUserId: me,
        action: 'helpdesk_ticket_confirmed',
        target: ['ticket', number],
        meta: {by: 'customer'},
      });
      return c.json({status: 'solved', confirmed: true} satisfies SolveResult);
    }
    // Nothing changed (already confirmed, outside the window, a repeat press, or a race lost to a
    // reopen): one read of what the ticket is NOW, so the answer never claims a status it doesn't have.
    const now = await db.conversation.findFirst({
      where: {id: conversation.id, userId: me},
      select: {status: true},
    });
    if (!now) return notFound(c);
    const status = now.status as TicketStatus;
    // It was unsolved and is still unsolved: our solve did not happen.
    if (conversation.status !== 'solved' && status !== 'solved') return changedMeanwhile(c);
    return c.json({status, confirmed: false} satisfies SolveResult);
  })

  .post('/tickets/:number/csat', numberParam, csatBody, withViewer, requireAuth, withDb, async c => {
    const {number} = c.req.valid('param');
    const {score} = c.req.valid('json');
    // ONE conditional write: mine, solved, not rated yet. Anything else is the same 404.
    const {count} = await c.var.db.ticket.updateMany({
      where: {
        number,
        csat: null,
        solvedAt: {not: null},
        conversation: {is: {userId: c.var.viewer.id!, status: 'solved'}},
      },
      data: {csat: score, csatAt: new Date()},
    });
    if (!count) return c.json(problem('not_found', 'No such ticket, or it was already rated.'), 404);
    return c.json({csat: score});
  });
