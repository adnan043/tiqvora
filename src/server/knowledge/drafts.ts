import type {Context} from 'hono';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {AI_SECRET_NAMES, aiModelOf, costMicros} from '../../lib/ai-models';
import {DontRetry, JobRejected, sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {maskPersonalData} from '../ai/answer';
import {
  type DraftCleanOptions,
  draftAllowedUrls,
  draftHoldInputTokens,
  DRAFT_MAX_TOKENS,
  DRAFT_SCHEMA,
  DRAFT_SYSTEM,
  DRAFT_TIMEOUT_MS,
  issueDraftInput,
  maskNames,
  type ParsedDraft,
  parseDraft,
  stripUrls,
  ticketDraftInput,
} from '../ai/draft';
import {callAnthropic, type ProviderResult} from '../ai/provider';
import {retrieve} from '../ai/retrieve';
import {AI_DRAFT_BUCKET, AI_DRAFT_PER_MINUTE, capMicrosOf, costOf, settleWith, takeWindowAndReserve} from '../ai/spend';
import {monthKey, recordAiCost} from '../ai/usage';
import {HELPDESK_DEFAULTS} from '../kb/settings';

/**
 * Knowledge health DRAFTS (Phase 4, p4-design §5.3–5.4): an article draft the assistant writes
 * for a person to review. Nothing here ever publishes: a draft is a `health_issues` row, and
 * only Accept (a person, src/server/knowledge/accept.ts) turns it into a DRAFT article.
 *
 *   'article-drafts' {ticketId}  runArticleDraftJob  — sent by the three solve paths
 *                                                     (queueArticleDraft) and the tick's sweep
 *   'health-drafts'  {issueId}   runHealthDraftJob   — sent by POST /helpdesk/health/:id/draft
 *
 * What the provider sees (src/server/ai/draft.ts builds it, masked and escaped as data): for a
 * ticket, its `customer` lines and its `agent` replies, and the cited article; for an issue, its
 * sample questions, its article and the help-center passages `retrieve()` finds. NEVER internal
 * notes, author ids or names, emails, user ids, ticket numbers or page paths. The ticket's people's
 * names are read only to replace them with `[name]` in what is sent and in what comes back.
 *
 * Never pending or charging forever: a timed-out call is final (DontRetry, no second payment);
 * the last try (or a Preview run, which has only one) marks the ticket checked / the issue
 * `failed` before it throws; the tick fails health drafts left `pending` for 15 minutes and gives
 * up on tickets unchecked after 48 hours.
 *
 * Idempotency of `draft-<ticketId>` at three levels: the job key (24 h), the UNIQUE
 * `health_issues.source_ticket_id` (any state: a dismissed draft is never recreated) and
 * `tickets.draft_checked_at` (set once the job is done with the ticket: a draft written, nothing
 * to draft, AI off/cap, or given up). Two deliveries at once may both call the provider (rare;
 * both settle their own money); the unique key keeps exactly one issue. No pre-claim: a crashed
 * claim would lose the draft.
 *
 * Money: the same monthly cap as the assistant, through src/server/ai/spend.ts (site-wide bucket
 * `ai-draft`, 10 a minute, shared by both lists): the window + hold in one statement, then the
 * settle and the result's write in one statement.
 */

/** What a job needs from `JobInfo`. */
export interface DraftJob {
  attempt: number;
  maxAttempts: number;
  /** The Preview: one run, errors swallowed (no retry): treated as the last try. */
  local?: boolean;
}

/** No retry will follow this run. */
const isLastTry = (job: DraftJob) => job.local === true || job.attempt >= job.maxAttempts;

const BUSY = 'Too many drafts this minute; trying again.';
const UNREADABLE = "The assistant's draft couldn't be read; trying again.";
const TIMED_OUT = 'The assistant took too long to write this draft. Try again later.';

export const ARTICLE_DRAFT_LIST = 'article-drafts';
export const articleDraftKey = (ticketId: number) => `draft-${ticketId}`;

/** Lines read from a ticket (oldest first): enough for a support conversation. */
const DRAFT_MAX_LINES = 80;
/** People's names read per ticket (only to mask them). */
const MAX_NAMES = 50;
/** Below this many characters of agent replies in total, there is nothing worth an article. */
const MIN_AGENT_CHARS = 80;
/** The evidence's first customer question, one line. */
const QUESTION_MAX_CHARS = 300;
/** Sample questions an issue's draft is grounded on. */
const MAX_SAMPLES = 5;
const NO_DRAFT_REASON = 'The assistant found nothing to add from these questions.';

/**
 * Sends the `article-drafts` job for a ticket that was just SOLVED (after the commit). Deduped on
 * `draft-<ticketId>`; never throws. True = accepted. A refusal is logged as a code only: the
 * Knowledge health tick's sweep sends it again (15 min to 48 h after the solve). Locally (the
 * Preview) the job runs right here, before this returns.
 */
export async function queueArticleDraft(requestUrl: string | URL, ticketId: number, number: number): Promise<boolean> {
  try {
    await sendJob(requestUrl, ARTICLE_DRAFT_LIST, {ticketId}, {key: articleDraftKey(ticketId), label: `Article draft · ticket #${number}`});
    return true;
  } catch (error) {
    // A code only: never the data.
    console.warn(`[knowledge] article draft job not sent: ${error instanceof JobRejected ? error.code : 'error'}`);
    return false;
  }
}

/**
 * `queueArticleDraft` after the answer is sent (`waitUntil`): the solve paths never wait on the
 * send. Never throws. Without an execution context (an in-process call) it simply runs on. A
 * refused or lost send is picked up by the tick's sweep.
 */
export function queueArticleDraftLater(c: Context, ticketId: number, number: number): void {
  const work = queueArticleDraft(c.req.url, ticketId, number).catch(() => false);
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context: it runs on by itself.
  }
}

/* --------------------------------- helpers --------------------------------- */

/** `UPDATE tickets SET draft_checked_at = now()` while still unchecked: the job is done with it. */
async function markChecked(db: PrismaClient, ticketId: number): Promise<void> {
  await db.$executeRaw`
    UPDATE "tickets" SET "draft_checked_at" = now()
    WHERE "id" = ${ticketId} AND "draft_checked_at" IS NULL`;
}

/** The first positive integer `id` in a `[{id, title, url}]` snapshot (ai_sources / cited_articles), else null. */
function firstArticleId(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const id = item && typeof item === 'object' ? (item as {id?: unknown}).id : null;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

/** One line, masked (personal data, names, links), ≤ max characters (the evidence's question). */
function maskedLine(text: string, max: number, names: readonly string[]): string {
  const line = stripUrls(maskNames(maskPersonalData(text), names))
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A foreign key violation (23503), however the driver adapter reports it (as inbox.ts reads it). */
function isForeignKeyError(error: unknown): boolean {
  const e = error as {code?: unknown; meta?: {code?: unknown; driverAdapterError?: {cause?: {kind?: unknown; originalCode?: unknown}}}} | null;
  if (e?.code === 'P2003' || e?.code === '23503') return true;
  const cause = e?.meta?.driverAdapterError?.cause;
  return e?.meta?.code === '23503' || cause?.kind === 'ForeignKeyConstraintViolation' || cause?.originalCode === '23503';
}

interface Settings {
  monthlyCapCents: number;
  model: string;
}

const toSettings = (row: Settings | null): Settings => ({
  monthlyCapCents: row?.monthlyCapCents ?? 2000,
  model: row?.model ?? HELPDESK_DEFAULTS.model,
});

type Gate = {ok: true; key: string; month: string; hold: number; modelId: string; serverFallback: boolean} | {ok: false; reason: 'off' | 'cap' | 'busy'};

/** The site's own address, for the links a draft may keep (null when not set). */
function siteOrigin(): string | null {
  try {
    return config.siteUrl;
  } catch {
    return null;
  }
}

/** Key, cap, then the `ai-draft` window + the hold (sized from `content`) in ONE statement. */
async function gate(db: PrismaClient, settings: Settings, content: string): Promise<Gate> {
  const key = config.ownerSecret(AI_SECRET_NAMES.anthropic);
  const capMicros = capMicrosOf(settings.monthlyCapCents);
  if (!key || capMicros <= 0) return {ok: false, reason: 'off'};
  const model = aiModelOf(settings.model);
  // Once: the hold and its settle land on the same month row.
  const month = monthKey();
  const hold = costMicros(model, draftHoldInputTokens(content), DRAFT_MAX_TOKENS);
  const taken = await takeWindowAndReserve(db, {bucket: AI_DRAFT_BUCKET, perMinute: AI_DRAFT_PER_MINUTE, capMicros, holdMicros: hold, month});
  if (taken !== 'ok') return {ok: false, reason: taken};
  return {ok: true, key, month, hold, modelId: model.id, serverFallback: model.serverFallback};
}

/** The call (never throws) and its parsed draft (null on any doubt), its cost, and whether it timed out. */
async function callDraft(
  g: Extract<Gate, {ok: true}>,
  content: string,
  clean: DraftCleanOptions
): Promise<{parsed: ParsedDraft | null; cost: number; timedOut: boolean}> {
  const result = await callAnthropic(g.key, {
    model: g.modelId,
    system: DRAFT_SYSTEM,
    messages: [{role: 'user', content}],
    serverFallback: g.serverFallback,
    schema: DRAFT_SCHEMA,
    maxTokens: DRAFT_MAX_TOKENS,
    timeoutMs: DRAFT_TIMEOUT_MS,
  }).catch((): ProviderResult => ({ok: false, reason: 'network'}));
  const cost = costOf(result, g.hold);
  const parsed = result.ok && !result.refused && result.stopReason !== 'max_tokens' ? parseDraft(result.text, clean) : null;
  return {parsed, cost, timedOut: !result.ok && result.reason === 'timeout'};
}

/* ------------------------------ article drafts ------------------------------ */

/**
 * The `article-drafts` job for one solved ticket (§5.3). Safe to repeat. Round trips: 1 parallel
 * read + ≤ 1 article read + 1 gate + the call + 1 write. Throws (the platform retries) when the
 * window is busy or the draft can't be read (before the last attempt); a DB error throws too.
 * A timed-out call marks the ticket checked and throws DontRetry (never paid twice). On the last
 * try any other failure marks it checked first (a busy window doesn't: nothing was paid, and the
 * tick's sweep sends it again until 48 h after the solve).
 */
export async function runArticleDraftJob(db: PrismaClient, ticketId: number, job: DraftJob): Promise<void> {
  try {
    await articleDraft(db, ticketId, job);
  } catch (error) {
    if (isLastTry(job) && !(error instanceof Busy)) await markChecked(db, ticketId).catch(() => undefined);
    throw error;
  }
}

/** The `ai-draft` window is full this minute (nothing reserved). */
class Busy extends Error {}

async function articleDraft(db: PrismaClient, ticketId: number, job: DraftJob): Promise<void> {
  const [ticket, settingsRow, lines, people] = await Promise.all([
    db.ticket.findUnique({
      where: {id: ticketId},
      select: {id: true, number: true, solvedAt: true, draftCheckedAt: true, aiSources: true, healthIssue: {select: {id: true}}},
    }),
    db.helpdeskSettings.findUnique({where: {id: 1}, select: {monthlyCapCents: true, model: true}}),
    // NEVER `note` (internal), never author ids or names.
    db.message.findMany({
      where: {conversation: {is: {ticket: {is: {id: ticketId}}}}, sender: {in: ['customer', 'ai', 'agent']}},
      select: {sender: true, body: true, citedArticles: true},
      orderBy: {id: 'asc'},
      take: DRAFT_MAX_LINES,
    }),
    // The ticket's people (its customer, its assignee, every author of a line): read ONLY to
    // replace their names with [name] in what the provider sees and in the draft. Never sent.
    db.$queryRaw<{name: string}[]>`
      SELECT u."name" FROM "users" u
      WHERE u."id" IN (
        SELECT c."user_id" FROM "tickets" t JOIN "conversations" c ON c."id" = t."conversation_id" WHERE t."id" = ${ticketId}::int
        UNION SELECT t."assignee_id" FROM "tickets" t WHERE t."id" = ${ticketId}::int
        UNION SELECT m."author_user_id" FROM "tickets" t JOIN "messages" m ON m."conversation_id" = t."conversation_id"
          WHERE t."id" = ${ticketId}::int AND m."author_user_id" IS NOT NULL)
      LIMIT ${MAX_NAMES}::int`,
  ]);
  const names = people.map(p => p.name).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  // Gone (deleted), or done before.
  if (!ticket || ticket.draftCheckedAt || ticket.healthIssue) return;
  // Reopened: not marked. A new solve sends again (the sweep covers 15 min–48 h too).
  if (!ticket.solvedAt) return;

  // Nothing worth drafting (no AI call): no agent reply, or only a few words of one.
  const agentLines = lines.filter(line => line.sender === 'agent');
  const agentChars = agentLines.reduce((sum, line) => sum + line.body.trim().length, 0);
  if (agentLines.length === 0 || agentChars < MIN_AGENT_CHARS) {
    await markChecked(db, ticketId);
    return;
  }

  // The cited article: the hand-off's sources first, else the last assistant line's citations.
  let citedId = firstArticleId(ticket.aiSources);
  if (citedId === null) {
    const lastAi = [...lines].reverse().find(line => line.sender === 'ai');
    citedId = lastAi ? firstArticleId(lastAi.citedArticles) : null;
  }
  const cited =
    citedId === null
      ? null
      : await db.kbArticle.findFirst({where: {id: citedId, status: {not: 'archived'}}, select: {id: true, title: true, body: true}});

  const citedArticle = cited ? {title: cited.title, body: cited.body} : null;
  const content = ticketDraftInput(
    lines.map(line => ({sender: line.sender, body: line.body})),
    citedArticle,
    names
  );
  const g = await gate(db, toSettings(settingsRow), content);
  if (!g.ok) {
    if (g.reason === 'busy') throw new Busy(BUSY);
    // off / cap: retrying won't help this month.
    await markChecked(db, ticketId);
    return;
  }

  // From here on the hold is ALWAYS settled.
  const {parsed, cost, timedOut} = await callDraft(g, content, {
    names,
    siteOrigin: siteOrigin(),
    allowedUrls: draftAllowedUrls(citedArticle),
  });
  if (!parsed) {
    await recordAiCost(db, cost, g.hold, g.month);
    if (timedOut || isLastTry(job)) {
      await markChecked(db, ticketId);
      if (timedOut) throw new DontRetry(TIMED_OUT);
      return;
    }
    throw new Error(UNREADABLE);
  }

  if (parsed.action === 'none') {
    await settleWith(db, cost, g.hold, g.month, settle =>
      db.$executeRaw`
        ${settle}
        UPDATE "tickets" SET "draft_checked_at" = now()
        WHERE "id" = ${ticketId} AND "draft_checked_at" IS NULL`
    );
    return;
  }

  const type = parsed.conflict && cited ? 'conflict' : 'gap';
  // `edit` with no cited article is a new one; a conflict is always about the cited article.
  const articleId = (parsed.action === 'edit' || type === 'conflict') && cited ? cited.id : null;
  const firstCustomer = lines.find(line => line.sender === 'customer');
  const evidence = {
    source: 'ticket',
    ticketNumber: ticket.number,
    question: firstCustomer ? maskedLine(firstCustomer.body, QUESTION_MAX_CHARS, names) : '',
    agentReplies: agentLines.length,
    summary: parsed.summary,
    missingFacts: parsed.missingFacts,
    citedArticleId: cited?.id ?? null,
    // 'new': the draft is a whole new article even when it points at a cited one (a conflict), so
    // Accept never writes it over that article (accept.ts).
    draftAction: parsed.action,
  };
  try {
    await settleWith(db, cost, g.hold, g.month, settle => {
      const open = settle === Prisma.empty ? Prisma.sql`WITH` : Prisma.sql`${settle},`;
      // ON CONFLICT with no target: covers both the UNIQUE source_ticket_id and the open partial index.
      return db.$queryRaw<{id: number}[]>`
        ${open} ins AS (
          INSERT INTO "health_issues" ("type", "article_id", "source_ticket_id", "fingerprint", "evidence",
            "suggested_title", "suggested_body", "draft_state", "created_at", "updated_at")
          VALUES (${type}, ${articleId}::int, ${ticketId}::int, ${`ticket:${ticketId}`}, ${JSON.stringify(evidence)}::jsonb,
            ${parsed.title}, ${parsed.body}, 'ready', now(), now())
          ON CONFLICT DO NOTHING
          RETURNING "id"
        )
        UPDATE "tickets" SET "draft_checked_at" = now()
        WHERE "id" = ${ticketId}::int AND "draft_checked_at" IS NULL
        RETURNING "id"`;
    });
  } catch (error) {
    // The ticket was deleted meanwhile (FK): nothing left to draft from (the money was settled).
    if (isForeignKeyError(error)) return;
    throw error;
  }
}

/* ------------------------------ health drafts ------------------------------ */

function samplesOf(evidence: unknown): string[] {
  const samples = evidence && typeof evidence === 'object' ? (evidence as {samples?: unknown}).samples : null;
  if (!Array.isArray(samples)) return [];
  return samples.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, MAX_SAMPLES);
}

/** `pending` → `failed` with a reason (and, for `none`, the evidence's noDraftReason), conditionally. */
async function failDraft(db: PrismaClient, issueId: number, reason: 'off' | 'cap' | 'failed'): Promise<void> {
  await db.$executeRaw`
    UPDATE "health_issues" SET "draft_state" = 'failed', "draft_error" = ${reason}, "updated_at" = now()
    WHERE "id" = ${issueId} AND "state" = 'open' AND "draft_state" = 'pending'`;
}

/**
 * The `health-drafts` job for one open issue whose "Write a draft" was pressed (§5.4). Safe to
 * repeat: anything not `open` + `pending` is done. Round trips: 1 parallel read + ≤ 1 retrieve +
 * 1 gate + the call + 1 write. Never leaves the issue `pending` for good: a timed-out call fails
 * it (DontRetry: never paid twice), and on the last try (or a Preview run) ANY error, a busy
 * window included, fails it before it is thrown. The tick fails what is still pending after 15 min.
 */
export async function runHealthDraftJob(db: PrismaClient, issueId: number, job: DraftJob): Promise<void> {
  try {
    await healthDraft(db, issueId, job);
  } catch (error) {
    if (isLastTry(job)) await failDraft(db, issueId, 'failed').catch(() => undefined);
    throw error;
  }
}

async function healthDraft(db: PrismaClient, issueId: number, job: DraftJob): Promise<void> {
  const [issue, settingsRow] = await Promise.all([
    db.healthIssue.findUnique({
      where: {id: issueId},
      select: {
        state: true,
        type: true,
        evidence: true,
        draftState: true,
        article: {select: {id: true, title: true, body: true, status: true}},
      },
    }),
    db.helpdeskSettings.findUnique({where: {id: 1}, select: {monthlyCapCents: true, model: true}}),
  ]);
  if (!issue || issue.state !== 'open' || issue.draftState !== 'pending') return;

  const samples = samplesOf(issue.evidence);
  const article = issue.article ? {title: issue.article.title, body: issue.article.body} : null;
  // Grounding: the published help center (retrieve reads published chunks only, ≤ 6).
  const query = samples.join(' ') || article?.title || '';
  const sources = query ? (await retrieve(db, query)).sources : [];

  const content = issueDraftInput(issue.type, samples, article, sources);
  const g = await gate(db, toSettings(settingsRow), content);
  if (!g.ok) {
    if (g.reason === 'busy') throw new Busy(BUSY);
    await failDraft(db, issueId, g.reason);
    return;
  }

  const {parsed, cost, timedOut} = await callDraft(g, content, {
    siteOrigin: siteOrigin(),
    allowedUrls: draftAllowedUrls(article, sources),
  });
  if (!parsed) {
    await recordAiCost(db, cost, g.hold, g.month);
    if (timedOut || isLastTry(job)) {
      await failDraft(db, issueId, 'failed');
      if (timedOut) throw new DontRetry(TIMED_OUT);
      return;
    }
    throw new Error(UNREADABLE);
  }

  if (parsed.action === 'none') {
    await settleWith(db, cost, g.hold, g.month, settle =>
      db.$executeRaw`
        ${settle}
        UPDATE "health_issues" SET "draft_state" = 'failed', "draft_error" = 'failed',
          "evidence" = "evidence" || jsonb_build_object('noDraftReason', ${NO_DRAFT_REASON}::text), "updated_at" = now()
        WHERE "id" = ${issueId} AND "state" = 'open' AND "draft_state" = 'pending'`
    );
    return;
  }

  await settleWith(db, cost, g.hold, g.month, settle =>
    db.$executeRaw`
      ${settle}
      UPDATE "health_issues" SET "suggested_title" = ${parsed.title}, "suggested_body" = ${parsed.body},
        "draft_state" = 'ready', "draft_error" = NULL,
        "evidence" = ("evidence" - 'noDraftReason') || jsonb_build_object('summary', ${parsed.summary}::text, 'missingFacts', ${JSON.stringify(parsed.missingFacts)}::jsonb),
        "updated_at" = now()
      WHERE "id" = ${issueId} AND "state" = 'open' AND "draft_state" = 'pending'`
  );
}
