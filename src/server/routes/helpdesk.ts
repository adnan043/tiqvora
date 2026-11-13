import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {ASK_LIMITS, LOG_ID_RE, type AskResult, type AskRole, type WidgetConfig} from '../../lib/helpdesk-types';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';
import {problem, withDb} from '../../platform/guards';
import {answerQuestion, writeQuestionLog} from '../ai/answer';
import {retrieve} from '../ai/retrieve';
import {HELPDESK_DEFAULTS} from '../kb/settings';
import {clientRateKey, takeRateWindow} from '../rate-window';

/**
 * The chat assistant, public (no sign-in; the chat widget on public pages calls it).
 *
 *   POST /site-api/helpdesk/ask                  {question, history?, page?} → AskResult
 *   POST /site-api/helpdesk/ask/:logId/helpful   {helpful: boolean}, once per answer, within a day;
 *                                                `logId` is `<id>.<signature>` (unguessable, `signLogId`)
 *   GET  /site-api/helpdesk/widget               WidgetConfig (cached)
 *
 * Nothing here knows who the visitor is: the question log has no user id and no IP, and the AI
 * provider gets only the customer's words, the help-center text and the fixed prompt
 * (src/server/ai/answer.ts). Rate limits per client are keyed IP hashes (rate-window.ts).
 *
 * POST /ask, the happy path in 5 database round trips: the ask window → (settings row, human
 * topics, retrieve) in parallel → both AI windows in one statement → the cap reserve → the log
 * row with the cost settled in one statement. The cap and the model come from the DATABASE row
 * every time (money: never the cache).
 *
 * Cache (docs/agent/cache.md):
 *   helpdesk:widget — 7 days — read by the widget on every public page view, the same for
 *   everyone — cleared by PATCH /helpdesk/settings (routes/helpdesk-settings.ts) after it saves.
 *   It holds `capOn` (the cap is above 0) only to choose the panel's first words; /ask enforces
 *   the real cap from the database.
 */

const WIDGET_CACHE_KEY = 'helpdesk:widget';
const WEEK = 7 * 24 * 3600;
const DAY_MS = 24 * 3600 * 1000;
/** Per minute: one client's questions (the site-wide ceiling when there's no client key). */
const ASK_PER_CLIENT = 20;
const ASK_SITE_WIDE = 600;
const HELPFUL_PER_CLIENT = 20;
const HELPFUL_SITE_WIDE = 1200;
const LANGUAGE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;
/** C0 control characters except tab and line feed (NUL included): never in a question. */
const CONTROL_EXCEPT_TAB_LF_RE = /[\u0000-\u0008\u000b-\u001f]/;

const invalid = (field: string, message: string) => ({...problem('invalid', message), fields: {[field]: message}});

/** Every answer from these POST routes, a 404 or a 422 from a validator too, is never cached. */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

/**
 * One client's per-minute window, then the site-wide one, in ONE statement (one round trip).
 * The site-wide row is only counted when the client's had room, so a client over its own limit
 * never uses up everyone's. The same conditional upsert as src/server/rate-window.ts; a write
 * (never re-sent). No client key (no JWT_SECRET) → the site-wide window alone.
 */
async function takeClientAndSiteWindows(
  db: PrismaClient,
  clientBucket: string | null,
  clientLimit: number,
  siteBucket: string,
  siteLimit: number
): Promise<boolean> {
  if (!clientBucket) return takeRateWindow(db, siteBucket, siteLimit);
  const client = clientBucket.slice(0, 40);
  const rows = await db.$queryRaw<{client: boolean; site: boolean}[]>`
    WITH a AS (
      INSERT INTO "rate_windows" ("bucket", "minute", "count")
      VALUES (${client}, date_trunc('minute', now()), 1)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
      WHERE "rate_windows"."count" < ${clientLimit}
      RETURNING 1
    ), s AS (
      INSERT INTO "rate_windows" ("bucket", "minute", "count")
      SELECT ${siteBucket}, date_trunc('minute', now()), 1 WHERE EXISTS (SELECT 1 FROM a)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
      WHERE "rate_windows"."count" < ${siteLimit}
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM a) AS "client", EXISTS (SELECT 1 FROM s) AS "site"`;
  return Boolean(rows[0]?.client && rows[0]?.site);
}

/* ------------------------------ the vote handle ------------------------------ */

const encoder = new TextEncoder();
let voteKey: {secret: string; key: Promise<CryptoKey>} | null = null;

/** The HMAC key for vote handles (derived from JWT_SECRET; one import per isolate and secret). */
function voteHmacKey(secret: string): Promise<CryptoKey> {
  if (voteKey?.secret !== secret) {
    voteKey = {
      secret,
      key: crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']),
    };
  }
  return voteKey.key;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The first 16 characters of base64url(HMAC-SHA256(JWT_SECRET, 'hd-vote:' + id)). */
async function voteSignature(secret: string, id: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await voteHmacKey(secret), encoder.encode(`hd-vote:${id}`));
  return base64url(new Uint8Array(mac)).slice(0, 16);
}

/** Constant time for equal lengths (the regex already fixed the length). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `<id>.<signature>`: only the visitor who asked holds it, so nobody can vote on someone else's
 * answer by counting ids. Without JWT_SECRET there is nothing to sign with: a handle that never
 * verifies (votes answer 404 until the secret is set).
 */
async function signLogId(id: string): Promise<string> {
  const secret = config.jwtSecret;
  return `${id}.${secret ? await voteSignature(secret, id) : 'unsigned-no-key0'}`;
}

/** The log id of a valid handle, or null (bad signature, no JWT_SECRET). */
async function verifyLogId(handle: string): Promise<string | null> {
  const secret = config.jwtSecret;
  if (!secret) return null;
  const dot = handle.indexOf('.');
  const id = handle.slice(0, dot);
  return sameString(handle.slice(dot + 1), await voteSignature(secret, id)) ? id : null;
}

type AskBody = {question: string; history: {role: AskRole; text: string}[]; page: string};

const askBody = validator('json', (value, c) => {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

  const question = typeof v.question === 'string' ? v.question.trim() : '';
  if (CONTROL_EXCEPT_TAB_LF_RE.test(question)) {
    return c.json(invalid('question', 'Your question has characters that cannot be sent. Type it again as plain text.'), 422);
  }
  if (question.length < ASK_LIMITS.questionMin) {
    return c.json(invalid('question', 'Type your question (at least 2 characters).'), 422);
  }
  if (question.length > ASK_LIMITS.questionMax) {
    return c.json(invalid('question', `Keep your question under ${ASK_LIMITS.questionMax} characters.`), 422);
  }

  const history: AskBody['history'] = [];
  if (v.history !== undefined && v.history !== null) {
    const tooLong = 'The conversation is too long to send. Start a new one.';
    if (!Array.isArray(v.history) || v.history.length > ASK_LIMITS.historyCount) return c.json(invalid('history', tooLong), 422);
    let chars = 0;
    for (const item of v.history as unknown[]) {
      const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if ((entry.role !== 'customer' && entry.role !== 'assistant') || typeof entry.text !== 'string') {
        return c.json(invalid('history', 'Each earlier message needs a role (customer or assistant) and its text.'), 422);
      }
      if (CONTROL_EXCEPT_TAB_LF_RE.test(entry.text)) {
        return c.json(invalid('history', 'An earlier message has characters that cannot be sent. Start a new conversation.'), 422);
      }
      chars += entry.text.length;
      if (chars > ASK_LIMITS.historyChars) return c.json(invalid('history', tooLong), 422);
      const text = entry.text.trim();
      if (text) history.push({role: entry.role as AskRole, text});
    }
  }

  let page = '';
  if (v.page !== undefined && v.page !== null && v.page !== '') {
    const path = typeof v.page === 'string' ? v.page.split(/[?#]/, 1)[0] : '';
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.startsWith('/\\') ||
      path.length > ASK_LIMITS.pagePath ||
      /[\u0000-\u001f\u007f\s]/.test(path)
    ) {
      return c.json(invalid('page', 'The page must be a path such as /help/.'), 422);
    }
    page = path;
  }

  return {question, history, page} satisfies AskBody;
});

const helpfulParam = validator('param', (value, c) =>
  LOG_ID_RE.test(value.logId ?? '') ? {logId: value.logId} : c.json(problem('not_found', 'No such answer.'), 404)
);

const helpfulBody = validator('json', (value, c) => {
  const helpful = (value as {helpful?: unknown} | null)?.helpful;
  if (typeof helpful !== 'boolean') {
    return c.json(invalid('helpful', 'Say whether the answer helped: helpful is true or false.'), 422);
  }
  return {helpful};
});

/** The first tag of Accept-Language (`pt-BR,pt;q=0.9` → `pt-BR`), or '' when it isn't one. */
function languageOf(header: string | undefined): string {
  const tag = (header ?? '').split(',', 1)[0].split(';', 1)[0].trim();
  return tag.length <= 16 && LANGUAGE_RE.test(tag) ? tag : '';
}

type WidgetCache = Omit<WidgetConfig, 'assistant'> & {capOn: boolean};

export const helpdeskRoutes = new Hono()
  .post('/ask', noStore, askBody, withDb, async c => {
    const db = c.var.db;
    const {question, history, page} = c.req.valid('json');

    // 1 round trip: this client's questions per minute, then the site's, before any other work.
    const client = await clientRateKey(c);
    const allowed = await takeClientAndSiteWindows(db, client ? `q:${client}` : null, ASK_PER_CLIENT, 'hd-ask', ASK_SITE_WIDE);
    if (!allowed) {
      return c.json(problem('rate_limited', "You're asking very fast. Wait a minute and try again."), 429);
    }

    // 1 round trip: independent reads together. The cap and model from the row (money: never cached).
    const [row, topics, retrieved] = await Promise.all([
      db.helpdeskSettings.findUnique({
        where: {id: 1},
        select: {monthlyCapCents: true, model: true, tone: true, confidenceThreshold: true, assistantName: true},
      }),
      db.helpdeskHumanTopic.findMany({select: {keyword: true}, orderBy: {id: 'asc'}, take: ASK_LIMITS.humanTopics}),
      // A short follow-up borrows the customer's previous question (retrieve.ts).
      retrieve(db, question, [...history].reverse().find(item => item.role === 'customer')?.text ?? ''),
    ]);

    const outcome = await answerQuestion({
      db,
      key: config.ownerSecret(AI_SECRET_NAMES.anthropic),
      settings: {
        assistantName: row?.assistantName ?? HELPDESK_DEFAULTS.assistantName,
        tone: row?.tone ?? HELPDESK_DEFAULTS.tone,
        confidenceThreshold: row?.confidenceThreshold ?? HELPDESK_DEFAULTS.confidenceThreshold,
        model: row?.model ?? HELPDESK_DEFAULTS.model,
      },
      // No row: the schema's default cap (2000 cents), as a fresh install has.
      capCents: row?.monthlyCapCents ?? 2000,
      humanTopics: topics.map(topic => topic.keyword),
      question,
      retrieved,
      history,
      language: languageOf(c.req.header('accept-language')),
      page,
      clientKey: client,
    });

    // The public answer: never the log entry or the internal article ids behind the citations.
    const {log, citedArticleIds: _internalIds, ...result} = outcome;
    const logId = await signLogId(await writeQuestionLog(db, log));
    return c.json({logId, ...result} satisfies AskResult);
  })

  .post('/ask/:logId/helpful', noStore, helpfulParam, helpfulBody, withDb, async c => {
    const db = c.var.db;
    const {logId} = c.req.valid('param');
    const {helpful} = c.req.valid('json');
    const client = await clientRateKey(c);
    const allowed = await takeClientAndSiteWindows(db, client ? `h:${client}` : null, HELPFUL_PER_CLIENT, 'hd-helpful', HELPFUL_SITE_WIDE);
    if (!allowed) return c.json(problem('rate_limited', 'Too many answers right now. Try again in a minute.'), 429);
    // The signed handle from the visitor's own /ask reply: a guessed or edited one is a 404.
    const id = await verifyLogId(logId);
    if (!id) return c.json(problem('not_found', 'No such answer, or it was already rated.'), 404);
    // Conditional: once per answer, and only for a recent one. Nothing else in the row can be
    // changed or read.
    const {count} = await db.questionLog.updateMany({
      where: {id: BigInt(id), helpful: null, createdAt: {gt: new Date(Date.now() - DAY_MS)}},
      data: {helpful},
    });
    if (!count) return c.json(problem('not_found', 'No such answer, or it was already rated.'), 404);
    return c.json({ok: true as const});
  })

  .get('/widget', withDb, async c => {
    const db = c.var.db;
    const widget = await cache.getOrSet<WidgetCache>(WIDGET_CACHE_KEY, WEEK, async () => {
      const [row, replies] = await Promise.all([
        db.helpdeskSettings.findUnique({
          where: {id: 1},
          select: {assistantName: true, greeting: true, launcherLabel: true, businessHours: true, monthlyCapCents: true},
        }),
        db.helpdeskQuickReply.findMany({
          select: {label: true},
          orderBy: [{position: 'asc'}, {id: 'asc'}],
          take: ASK_LIMITS.quickReplies,
        }),
      ]);
      return {
        name: row?.assistantName ?? HELPDESK_DEFAULTS.assistantName,
        greeting: row?.greeting ?? HELPDESK_DEFAULTS.greeting,
        launcherLabel: row?.launcherLabel ?? HELPDESK_DEFAULTS.launcherLabel,
        businessHours: row?.businessHours ?? HELPDESK_DEFAULTS.businessHours,
        quickReplies: replies.map(reply => reply.label),
        capOn: (row?.monthlyCapCents ?? 2000) > 0,
      };
    });
    const {capOn, ...rest} = widget;
    // The key is read live (no query): adding or removing it shows within the browser's minute.
    const body: WidgetConfig = {...rest, assistant: capOn && Boolean(config.ownerSecret(AI_SECRET_NAMES.anthropic))};
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(body);
  });
