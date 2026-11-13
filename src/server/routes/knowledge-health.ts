/**
 * Knowledge health, for holders of `site:helpdesk:reports` (the Knowledge health screen).
 * Mounted at `/site-api/helpdesk/health` (src/server/app.ts), BEFORE the public `/helpdesk`.
 *
 *   GET  /?state=&type=&before=   HealthIssuesPage: issues by state (and type), newest first, 20 a
 *                                 page, keyset on id (`(state, id)` / `(state, type, id)`), the open
 *                                 counts per type (capped: ≤ 400 rows read) and the last weekly run.
 *                                 Three reads in one Promise.all. Never the suggested body.
 *   GET  /:id                     {issue: HealthIssueDetail}, with the suggested body.
 *   POST /:id/accept              The reviewer's edited draft becomes a DRAFT article (also needs
 *                                 `site:kb:edit`): src/server/knowledge/accept.ts. Never publishes.
 *   POST /:id/dismiss             Conditional on `open`: two reviewers can't both resolve it.
 *   POST /:id/draft               "Write a draft": a conditional claim (≤ 3 tries), then the
 *                                 `health-drafts` job (key `hdraft-<id>-<attempt>`).
 *
 * Unknown id → 404 for everyone allowed in (no other answer tells which ids exist). No cache: a
 * few admins read it, and every accept or dismiss changes it. The sample questions in the evidence
 * were masked before they were logged; they are shown only to this permission, as in Analytics.
 */
import type {Context} from 'hono';
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {
  type AcceptResult,
  type DraftState,
  HEALTH_STATES,
  HEALTH_TYPES,
  type HealthEvidence,
  type HealthIssueDetail,
  type HealthIssueRow,
  type HealthIssuesPage,
  type HealthState,
  type HealthType,
} from '../../lib/knowledge-health-types';
import {audit} from '../../platform/auth';
import {JobRejected, sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {readArticle} from '../kb/articles';
import {acceptIssue, CategoryGone, NeedsCategory, NotOpen, SlugTaken} from '../knowledge/accept';
import {PERMISSIONS} from '../permissions';

const PAGE = 20;
/** "Write a draft" presses per issue (the column's CHECK says the same). */
const DRAFT_TRIES = 3;
/** Open rows read for the per-type counts; the screen shows "99+" past 99. */
const COUNT_CAP = 400;

const canSee = requirePermission(PERMISSIONS.HELPDESK_REPORTS);
const canEditKb = requirePermission(PERMISSIONS.KB_EDIT);

type Fields = Record<string, string>;

const idOf = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : undefined;
};
const objectOf = (value: unknown) =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

const notFound = (c: Context) => c.json(problem('not_found', 'No such issue.'), 404);
const changed = (c: Context) => c.json(problem('changed', 'Someone already accepted or dismissed this issue.'), 409);
const invalid = (c: Context, fields: Fields) =>
  c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);

const listQuery = validator('query', value => ({
  state: (HEALTH_STATES as readonly unknown[]).includes(value.state) ? (value.state as HealthState) : ('open' as const),
  type: (HEALTH_TYPES as readonly unknown[]).includes(value.type) ? (value.type as HealthType) : ('all' as const),
  before: typeof value.before === 'string' ? value.before : '',
}));

/**
 * The Accept body: the KB's own article rules (title, body, excerpt, slug, category), with
 * `status` ignored (Accept only ever writes a draft) and the category optional (the old article's
 * is used when there is one).
 */
const acceptBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const {out, fields} = readArticle(v, false);
  if (v.categoryId === undefined || v.categoryId === null) delete fields.categoryId;
  delete fields.status;
  if (Object.keys(fields).length) return invalid(c, fields);
  return {title: out.title!, body: out.body!, excerpt: out.excerpt, slug: out.slug, categoryId: out.categoryId};
});

const articleRef = {select: {id: true, title: true, status: true}} as const;

const listSelect = {
  id: true,
  type: true,
  state: true,
  suggestedTitle: true,
  draftState: true,
  evidence: true,
  createdAt: true,
  resolvedAt: true,
  article: articleRef,
  sourceTicket: {select: {number: true}},
} as const;

const detailSelect = {
  ...listSelect,
  suggestedBody: true,
  draftError: true,
  draftAttempts: true,
  acceptedArticleId: true,
  article: {
    select: {
      id: true,
      title: true,
      status: true,
      slug: true,
      categoryId: true,
      lastReviewedAt: true,
      helpfulCount: true,
      notHelpfulCount: true,
    },
  },
} as const;

type ListRow = {
  id: number;
  type: string;
  state: string;
  suggestedTitle: string;
  draftState: string;
  evidence: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  article: {id: number; title: string; status: string} | null;
  sourceTicket: {number: number} | null;
};

// ---- evidence: copied field by field, each checked (the column is JSON written by jobs) ----

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const texts = (v: unknown, count: number, max: number) =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string').slice(0, count).map(item => item.slice(0, max)) : undefined;

const posInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647 ? v : undefined);

/** Shown only in the issue drawer (the detail response): left out of list rows to keep pages small. */
const DETAIL_ONLY = ['samples', 'question', 'summary', 'missingFacts', 'noDraftReason'] as const;

/** `citedArticleId` is being added to HealthEvidence; typed here too so this compiles either way. */
type Evidence = HealthEvidence & {citedArticleId?: number};

function toEvidence(raw: unknown, detail: boolean): Evidence {
  const v = objectOf(raw);
  const out: Evidence = {
    source: v.source === 'weekly' || v.source === 'ticket' ? v.source : undefined,
    from: txt(v.from, 40),
    to: txt(v.to, 40),
    questions: num(v.questions),
    noSource: num(v.noSource),
    lowConfidence: num(v.lowConfidence),
    samples: texts(v.samples, 5, 500),
    lastReviewedAt: txt(v.lastReviewedAt, 40),
    daysSinceReview: num(v.daysSinceReview),
    views: num(v.views),
    helpful: num(v.helpful),
    notHelpful: num(v.notHelpful),
    rate: num(v.rate),
    ticketNumber: num(v.ticketNumber),
    question: txt(v.question, 300),
    agentReplies: num(v.agentReplies),
    summary: txt(v.summary, 1000),
    missingFacts: texts(v.missingFacts, 10, 300),
    noDraftReason: txt(v.noDraftReason, 300),
    // The article a conflict or low-confidence answer cited (a positive id, else dropped).
    citedArticleId: posInt(v.citedArticleId),
  };
  if (!detail) for (const key of DETAIL_ONLY) delete out[key];
  for (const key of Object.keys(out) as (keyof Evidence)[]) if (out[key] === undefined) delete out[key];
  return out;
}

const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
type ArticleStatus = (typeof ARTICLE_STATUSES)[number];
const statusOf = (s: string): ArticleStatus => ((ARTICLE_STATUSES as readonly string[]).includes(s) ? (s as ArticleStatus) : 'draft');
const DRAFT_STATES = ['none', 'pending', 'ready', 'failed'] as const;

function toRow(row: ListRow, detail = false): HealthIssueRow {
  return {
    id: row.id,
    type: row.type as HealthType,
    state: row.state as HealthState,
    title: row.suggestedTitle || row.article?.title || '',
    draftState: ((DRAFT_STATES as readonly string[]).includes(row.draftState) ? row.draftState : 'none') as DraftState,
    article: row.article ? {id: row.article.id, title: row.article.title, status: statusOf(row.article.status)} : null,
    ticketNumber: row.sourceTicket?.number ?? null,
    evidence: toEvidence(row.evidence, detail),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

type DetailRow = Omit<ListRow, 'article'> & {
  suggestedBody: string;
  draftError: string | null;
  draftAttempts: number;
  acceptedArticleId: number | null;
  article: {
    id: number;
    title: string;
    status: string;
    slug: string;
    categoryId: number;
    lastReviewedAt: Date;
    helpfulCount: number;
    notHelpfulCount: number;
  } | null;
};

function toDetail(row: DetailRow): HealthIssueDetail {
  const a = row.article;
  return {
    ...toRow(row, true),
    suggestedBody: row.suggestedBody,
    draftError: row.draftError === 'off' || row.draftError === 'cap' || row.draftError === 'failed' ? row.draftError : null,
    draftAttempts: row.draftAttempts,
    acceptedArticleId: row.acceptedArticleId,
    article: a
      ? {
          id: a.id,
          title: a.title,
          status: statusOf(a.status),
          slug: a.slug,
          categoryId: a.categoryId,
          lastReviewedAt: a.lastReviewedAt.toISOString(),
          helpfulCount: a.helpfulCount,
          notHelpfulCount: a.notHelpfulCount,
        }
      : null,
  };
}

const zeroCounts = (): Record<HealthType, number> => ({gap: 0, stale: 0, conflict: 0, low_rated: 0});

export const knowledgeHealthRoutes = new Hono()
  .get('/', listQuery, withViewer, requireAuth, canSee, withDb, async c => {
    const db = c.var.db;
    const {state, type} = c.req.valid('query');
    const before = idOf(c.req.valid('query').before);
    const [rows, counts, run] = await Promise.all([
      db.healthIssue.findMany({
        where: {state, ...(type !== 'all' ? {type} : {}), ...(before ? {id: {lt: before}} : {})},
        orderBy: {id: 'desc'},
        take: PAGE + 1,
        select: listSelect,
      }),
      db.$queryRaw<{type: string; n: number}[]>`
        SELECT s."type", count(*)::int AS "n"
        FROM (SELECT "type" FROM "health_issues" WHERE "state" = 'open' ORDER BY "id" DESC LIMIT ${COUNT_CAP}) s
        GROUP BY s."type"`,
      db.knowledgeHealthRun.findFirst({
        orderBy: {week: 'desc'},
        select: {week: true, timeZone: true, state: true, finishedAt: true, gapsFound: true, staleFound: true, lowRatedFound: true},
      }),
    ]);
    const items = rows.slice(0, PAGE).map(row => toRow(row));
    const openCounts = zeroCounts();
    for (const row of counts) {
      if ((HEALTH_TYPES as readonly string[]).includes(row.type)) openCounts[row.type as HealthType] = Math.min(row.n, 100);
    }
    const page: HealthIssuesPage = {
      items,
      next: rows.length > PAGE ? items.at(-1)!.id : null,
      openCounts,
      lastRun: run
        ? {
            week: run.week.toISOString().slice(0, 10),
            timeZone: run.timeZone,
            state: run.state === 'done' || run.state === 'failed' ? run.state : 'running',
            finishedAt: run.finishedAt?.toISOString() ?? null,
            gaps: run.gapsFound,
            stale: run.staleFound,
            lowRated: run.lowRatedFound,
          }
        : null,
    };
    c.header('Cache-Control', 'private, no-store');
    return c.json(page);
  })

  .get('/:id', withViewer, requireAuth, canSee, withDb, async c => {
    const id = idOf(c.req.param('id'));
    const row = id ? await c.var.db.healthIssue.findUnique({where: {id}, select: detailSelect}) : null;
    if (!row) return notFound(c);
    c.header('Cache-Control', 'private, no-store');
    return c.json({issue: toDetail(row)});
  })

  .post('/:id/accept', acceptBody, withViewer, requireAuth, canSee, canEditKb, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    const me = c.var.viewer.id!;
    let accepted;
    try {
      accepted = await acceptIssue(db, id, c.req.valid('json'), me);
    } catch (error) {
      if (error instanceof NotOpen) {
        const exists = await db.healthIssue.findUnique({where: {id}, select: {id: true}});
        return exists ? changed(c) : notFound(c);
      }
      if (error instanceof NeedsCategory) return invalid(c, {categoryId: 'Pick a category.'});
      if (error instanceof CategoryGone) return invalid(c, {categoryId: 'That category no longer exists. Pick another.'});
      // 422 like every other field problem: 409 on this route means only "someone else handled it".
      if (error instanceof SlugTaken) return invalid(c, {slug: 'That slug is already used. Pick another.'});
      throw error;
    }
    await audit(db, {
      actorUserId: me,
      action: 'health_issue_accepted',
      target: ['health_issue', id],
      // `updated` = an existing draft (the issue's own article, unedited since the issue was raised)
      // was overwritten: the audit says which one, so the change is never silent.
      meta: {type: accepted.type, articleId: accepted.article.id, mode: accepted.mode, sourceArticleId: accepted.sourceArticleId},
    });
    const result: AcceptResult = {
      issue: {id, state: 'accepted'},
      article: {id: accepted.article.id, title: accepted.article.title, status: 'draft', mode: accepted.mode},
    };
    return c.json(result);
  })

  .post('/:id/dismiss', withViewer, requireAuth, canSee, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    const {count} = await db.healthIssue.updateMany({
      where: {id, state: 'open'},
      data: {state: 'dismissed', resolvedBy: c.var.viewer.id!, resolvedAt: new Date()},
    });
    if (!count) {
      const exists = await db.healthIssue.findUnique({where: {id}, select: {id: true}});
      return exists ? changed(c) : notFound(c);
    }
    await audit(db, {actorUserId: c.var.viewer.id!, action: 'health_issue_dismissed', target: ['health_issue', id]});
    return c.json({issue: {id, state: 'dismissed' as const}});
  })

  .post('/:id/draft', withViewer, requireAuth, canSee, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    if (!config.ownerSecret(AI_SECRET_NAMES.anthropic)) {
      // An unknown id is a 404 whatever the AI setting (one read, only on this path).
      const exists = await db.healthIssue.findUnique({where: {id}, select: {id: true}});
      if (!exists) return notFound(c);
      return c.json(problem('ai_off', 'Add your Anthropic API key in Assistant first.'), 409);
    }
    const claimed = await db.$queryRaw<{attempts: number}[]>`
      UPDATE "health_issues"
      SET "draft_state" = 'pending', "draft_error" = NULL, "draft_attempts" = "draft_attempts" + 1, "updated_at" = now()
      WHERE "id" = ${id} AND "state" = 'open' AND "draft_state" IN ('none', 'failed') AND "draft_attempts" < ${DRAFT_TRIES}
      RETURNING "draft_attempts"::int AS "attempts"`;
    const attempts = claimed[0]?.attempts;
    if (attempts === undefined) {
      const row = await db.healthIssue.findUnique({where: {id}, select: {state: true, draftState: true, draftAttempts: true}});
      if (!row) return notFound(c);
      if (row.state === 'open' && row.draftState === 'pending') return c.json({draftState: 'pending' as const}, 202);
      if (row.state === 'open' && row.draftAttempts >= DRAFT_TRIES) {
        return c.json(problem('draft_limit', 'Tried three times. Write this one in Articles.'), 409);
      }
      return changed(c);
    }
    try {
      await sendJob(c.req.url, 'health-drafts', {issueId: id}, {key: `hdraft-${id}-${attempts}`, label: `Draft · knowledge issue ${id}`});
    } catch (error) {
      console.warn(`[knowledge] draft job not sent: ${error instanceof JobRejected ? error.code : 'error'}`);
      await db.healthIssue.updateMany({where: {id, draftState: 'pending'}, data: {draftState: 'failed', draftError: 'failed'}});
      return c.json(problem('not_sent', "Couldn't start the draft. Try again in a minute."), 503);
    }
    await audit(db, {
      actorUserId: c.var.viewer.id!,
      action: 'health_issue_draft_requested',
      target: ['health_issue', id],
      meta: {attempt: attempts},
    });
    return c.json({draftState: 'pending' as const}, 202);
  });
