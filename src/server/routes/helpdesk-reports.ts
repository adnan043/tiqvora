/**
 * Help desk analytics, for holders of `site:helpdesk:reports` (the Analytics screen).
 * Mounted at `/site-api/helpdesk/reports` (src/server/app.ts), BEFORE the public `/helpdesk`.
 *
 *   GET /?range=7d|4w|13w       HelpdeskReport: totals for the period, the period before it (the
 *                               trend) and the chart's buckets. ONE primary-key range read of
 *                               `question_stats_daily` (≤ 182 rows, kept by a trigger on
 *                               `question_logs`: migration helpdesk_analytics), summed here.
 *                               Never a `count()` over the log.
 *   GET /questions?filter=&before=
 *                               QuestionsPage: the asked questions, newest first, 25 a page,
 *                               keyset on id; filtered by outcome or "not helpful". ONE query
 *                               (the best article joined in), on `@@index([outcome, id])` /
 *                               `@@index([helpful, id])`.
 *
 * No cache (docs/agent/cache.md): a few admins read it, and every question changes it.
 * The question text is the customer's own words, shown only to this permission; the log holds no
 * email, name, user id or IP.
 */
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import {
  type HelpdeskReport,
  isQuestionFilter,
  isReportRange,
  type QuestionFilter,
  type QuestionRow,
  type QuestionsPage,
  REPORT_RANGES,
  type ReportBucket,
  type ReportRange,
  type ReportTotals,
} from '../../lib/helpdesk-report-types';
import {requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

const PAGE = 25;
const DAY_MS = 86_400_000;
/** 1 cent = 10,000 micro-dollars. */
const MICROS_PER_CENT = 10_000n;
/** A `question_logs.id` (BIGSERIAL) in a cursor: digits only, no more than a bigint holds. */
const ID_RE = /^[1-9]\d{0,17}$/;

const canSeeReports = requirePermission(PERMISSIONS.HELPDESK_REPORTS);

/** Each filter's condition, from a fixed map (never built from input). */
const FILTER_SQL: Record<QuestionFilter, Prisma.Sql> = {
  all: Prisma.sql`TRUE`,
  answered: Prisma.sql`q."outcome" = 'answered'`,
  handed_off: Prisma.sql`q."outcome" = 'handed_off'`,
  no_source: Prisma.sql`q."outcome" = 'no_source'`,
  ai_off: Prisma.sql`q."outcome" = 'ai_off'`,
  unhelpful: Prisma.sql`q."helpful" = FALSE`,
};

/** `YYYY-MM-DD` of a UTC day. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Midnight UTC of today (or of `now`). */
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type DayRow = {
  day: Date;
  questions: number;
  answered: number;
  handedOff: number;
  noSource: number;
  aiOff: number;
  helpfulUp: number;
  helpfulDown: number;
  costMicros: bigint;
};

const emptyTotals = (): ReportTotals & {micros: bigint} => ({
  questions: 0,
  answered: 0,
  handedOff: 0,
  noSource: 0,
  aiOff: 0,
  helpfulUp: 0,
  helpfulDown: 0,
  costCents: 0,
  micros: 0n,
});

function finish(t: ReportTotals & {micros: bigint}): ReportTotals {
  const {micros, ...totals} = t;
  // Round up, so a started cent shows (as the Assistant screen's spend does).
  return {...totals, costCents: Number((micros + MICROS_PER_CENT - 1n) / MICROS_PER_CENT)};
}

/** Sums the days into the period, the period before it and the chart's buckets. Pure: tested. */
export function buildReport(range: ReportRange, rows: DayRow[], today: Date): HelpdeskReport {
  const {days, bucketDays} = REPORT_RANGES[range];
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  const totals = emptyTotals();
  const previous = emptyTotals();
  const buckets: ReportBucket[] = Array.from({length: days / bucketDays}, (_, i) => ({
    start: isoDay(new Date(from.getTime() + i * bucketDays * DAY_MS)),
    questions: 0,
    answered: 0,
    handedOff: 0,
    noSource: 0,
  }));

  for (const row of rows) {
    const t = row.day.getTime();
    if (t > today.getTime() || t < prevFrom.getTime()) continue;
    const into = t >= from.getTime() ? totals : previous;
    into.questions += row.questions;
    into.answered += row.answered;
    into.handedOff += row.handedOff;
    into.noSource += row.noSource;
    into.aiOff += row.aiOff;
    into.helpfulUp += row.helpfulUp;
    into.helpfulDown += row.helpfulDown;
    into.micros += row.costMicros;
    if (into === totals) {
      const bucket = buckets[Math.floor((t - from.getTime()) / DAY_MS / bucketDays)];
      if (bucket) {
        bucket.questions += row.questions;
        bucket.answered += row.answered;
        bucket.handedOff += row.handedOff;
        bucket.noSource += row.noSource;
      }
    }
  }

  return {range, from: isoDay(from), to: isoDay(today), totals: finish(totals), previous: finish(previous), buckets};
}

const reportQuery = validator('query', value => ({
  range: isReportRange(value.range) ? value.range : ('7d' as ReportRange),
}));

const questionsQuery = validator('query', value => ({
  filter: isQuestionFilter(value.filter) ? value.filter : ('all' as QuestionFilter),
  // A bad cursor reads as "the first page", never an error.
  before: typeof value.before === 'string' && ID_RE.test(value.before) ? value.before : '',
}));

type QuestionDbRow = {
  id: bigint;
  question: string;
  outcome: QuestionRow['outcome'];
  confidence: QuestionRow['confidence'];
  helpful: boolean | null;
  page_path: string;
  article_title: string | null;
  article_slug: string | null;
  created_at: Date;
};

export const helpdeskReportRoutes = new Hono()
  .get('/', reportQuery, withViewer, requireAuth, canSeeReports, withDb, async c => {
    const {range} = c.req.valid('query');
    const today = utcToday();
    const days = REPORT_RANGES[range].days;
    const prevFrom = new Date(today.getTime() - (2 * days - 1) * DAY_MS);
    // ≤ 2 × 91 rows, by primary key.
    const rows = await c.var.db.questionStatsDaily.findMany({
      where: {day: {gte: prevFrom, lte: today}},
      select: {
        day: true,
        questions: true,
        answered: true,
        handedOff: true,
        noSource: true,
        aiOff: true,
        helpfulUp: true,
        helpfulDown: true,
        costMicros: true,
      },
      orderBy: {day: 'asc'},
      take: 2 * 91,
    });
    return c.json(buildReport(range, rows, today));
  })

  .get('/questions', questionsQuery, withViewer, requireAuth, canSeeReports, withDb, async c => {
    const {filter, before} = c.req.valid('query');
    const cursor = before ? Prisma.sql`AND q."id" < ${BigInt(before)}` : Prisma.empty;
    // Only a PUBLISHED article is named: a draft's title is not for this list.
    const rows = await c.var.db.$queryRaw<QuestionDbRow[]>`
      SELECT q."id", q."question", q."outcome", q."confidence", q."helpful", q."page_path", q."created_at",
             a."title" AS "article_title", a."slug" AS "article_slug"
      FROM "question_logs" q
      LEFT JOIN "kb_articles" a ON a."id" = q."top_article_id" AND a."status" = 'published'
      WHERE ${FILTER_SQL[filter]} ${cursor}
      ORDER BY q."id" DESC
      LIMIT ${PAGE + 1}`;
    const items: QuestionRow[] = rows.slice(0, PAGE).map(row => ({
      id: String(row.id),
      question: row.question,
      outcome: row.outcome,
      confidence: row.confidence,
      helpful: row.helpful,
      pagePath: row.page_path,
      article: row.article_title && row.article_slug ? {title: row.article_title, slug: row.article_slug} : null,
      createdAt: row.created_at.toISOString(),
    }));
    return c.json({items, nextBefore: rows.length > PAGE ? items.at(-1)!.id : null} satisfies QuestionsPage);
  });
