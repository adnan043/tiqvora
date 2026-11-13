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
 *   GET /overview               HelpdeskOverview (the Overview's AI tiles and "Needs attention"): this UTC
 *                               week's ≤ 7 `question_stats_daily` rows, this month's `ai_usage` row, the
 *                               budget (database row, not the cache: money; `spend` only for
 *                               HELPDESK_SETTINGS holders), Phase 4's open `health_issues` counts
 *                               (≤ 100 rows read) and, for KB editors, up to 7 failed knowledge files
 *                               (6 shown, "6+" from 7). ONE Promise.all.
 *   GET /weeks?count=4|13       WeeksReport: `helpdesk_stats_weekly` (≤ 13 primary-key rows, written
 *                               nightly by src/server/helpdesk/weekly.ts), missing weeks as zeros.
 *   GET /top?week=current|previous
 *                               TopReport: that week's `helpdesk_top_weekly` rankings (PK prefix,
 *                               ≤ 30 rows), only PUBLISHED articles named; `updatedAt` = that
 *                               week's `helpdesk_stats_weekly.updated_at` (null = never worked out).
 *                               ONE query.
 *
 * Weeks are UTC weeks named by their Monday. Resolutions are tickets (owner decision 1): confirmed =
 * the customer marked it solved, assumed = the team did; CSAT is reported apart.
 *
 * No cache (docs/agent/cache.md): a few admins read it, and every question changes it.
 * The question text is the customer's own words, shown only to this permission; the log holds no
 * email, name, user id or IP.
 */
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {
  type ArticleRef,
  CAP_NEAR_RATIO,
  HEALTH_MAX,
  HEALTH_ORDER,
  type HealthIssue,
  type HealthKind,
  type HelpdeskOverview,
  type HelpdeskReport,
  isQuestionFilter,
  isReportRange,
  isTopWeek,
  isWeekCount,
  type QuestionFilter,
  type QuestionRow,
  type QuestionsPage,
  REPORT_RANGES,
  type ReportBucket,
  type ReportRange,
  type ReportTotals,
  type TopReport,
  type TopWeek,
  type WeekCount,
  type WeeklyRow,
  type WeeksReport,
} from '../../lib/helpdesk-report-types';
import {config} from '../../platform/config';
import {can, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {monthUsage} from '../ai/usage';
import {weekKey} from '../helpdesk/state';
import {mondayBefore} from '../helpdesk/weekly';
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

// ---------------------------------------------------------------------------------------------
// Phase 5: Overview, weeks, rankings.

/** Budget when the settings row doesn't exist yet (the column's default, schema.prisma). */
const DEFAULT_CAP_CENTS = 2000;
/** Phase 4 open issues read for the counts (as knowledge-health.ts), and failed files listed. */
const ISSUE_SCAN = 100;
const FAILED_FILES_SHOWN = 6;
/** One more than shown is read, so exactly 6 is "6" and only 7 or more is "6+". */
const FAILED_FILES_TAKE = FAILED_FILES_SHOWN + 1;

export interface OverviewInput {
  today: Date;
  days: Pick<DayRow, 'day' | 'questions' | 'answered' | 'handedOff' | 'noSource' | 'helpfulUp' | 'helpfulDown'>[];
  usage: {month: string; spentCents: number; requests: number};
  capCents: number;
  hasKey: boolean;
  /** Open `health_issues` per type, from a scan of at most ISSUE_SCAN rows. */
  openIssues: {type: string; n: number}[];
  /** Failed knowledge files read (≤ FAILED_FILES_TAKE = 7), or null when the viewer can't edit knowledge. */
  failedFiles: number | null;
  canSettings: boolean;
}

/** The Overview's numbers and "Needs attention" items. Pure: tested. */
export function buildOverview(o: OverviewInput): HelpdeskOverview {
  const from = weekKey(o.today);
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const length = Math.round((utcToday(o.today).getTime() - fromMs) / DAY_MS) + 1;
  const answeredByDay = Array.from({length}, () => 0);
  const sums = {questions: 0, answered: 0, handedOff: 0, noSource: 0, helpfulUp: 0, helpfulDown: 0};
  for (const row of o.days) {
    const i = Math.round((row.day.getTime() - fromMs) / DAY_MS);
    if (i < 0 || i >= length) continue;
    answeredByDay[i] = (answeredByDay[i] ?? 0) + row.answered;
    sums.questions += row.questions;
    sums.answered += row.answered;
    sums.handedOff += row.handedOff;
    sums.noSource += row.noSource;
    sums.helpfulUp += row.helpfulUp;
    sums.helpfulDown += row.helpfulDown;
  }

  const aiReady = o.hasKey && o.capCents > 0;
  const found = new Map<HealthKind, HealthIssue>();
  const add = (kind: HealthKind, count: number, more = false) => found.set(kind, {kind, count, more});
  if (o.canSettings) {
    if (!aiReady) add('assistant_off', 0);
    else if (o.usage.spentCents >= o.capCents) add('cap_reached', 0);
    else if (o.usage.spentCents >= o.capCents * CAP_NEAR_RATIO) add('cap_near', Math.floor((o.usage.spentCents / o.capCents) * 100));
  }
  if (o.failedFiles) add('failed_files', Math.min(o.failedFiles, FAILED_FILES_SHOWN), o.failedFiles > FAILED_FILES_SHOWN);
  if (sums.noSource > 0) add('no_source', sums.noSource);
  // The scan reads at most ISSUE_SCAN open rows (newest first): when it was full, ANY type may have
  // more beyond it (the scan says nothing about which), so every Knowledge health count is "N+".
  const issues = new Map(o.openIssues.map(row => [row.type, row.n]));
  const scanFull = o.openIssues.reduce((sum, row) => sum + row.n, 0) >= ISSUE_SCAN;
  // Gaps only: the item links to Knowledge health filtered to type=gap. Conflicts have no slot
  // in HEALTH_ORDER (they show on Knowledge health itself).
  const gaps = issues.get('gap') ?? 0;
  if (gaps > 0) add('knowledge_gaps', gaps, scanFull);
  const lowRated = issues.get('low_rated') ?? 0;
  if (lowRated > 0) add('low_rated', lowRated, scanFull);
  const stale = issues.get('stale') ?? 0;
  if (stale > 0) add('stale_articles', stale, scanFull);

  return {
    week: {from, to: isoDay(utcToday(o.today))},
    ...sums,
    answeredByDay,
    // Money is for who may change the budget (HELPDESK_SETTINGS); left out for everyone else.
    ...(o.canSettings ? {spend: {month: o.usage.month, spentCents: o.usage.spentCents, capCents: o.capCents, requests: o.usage.requests}} : {}),
    aiReady,
    health: HEALTH_ORDER.flatMap(kind => found.get(kind) ?? []).slice(0, HEALTH_MAX),
  };
}

type WeekDbRow = Omit<WeeklyRow, 'week'> & {week: Date; updatedAt: Date};

/** `count` weeks ending with `currentMonday`, oldest first; a week the job never wrote is zeros. Pure: tested. */
export function fillWeeks(rows: readonly WeekDbRow[], currentMonday: string, count: WeekCount): WeeksReport {
  const byWeek = new Map(rows.map(row => [isoDay(row.week), row]));
  const weeks: WeeklyRow[] = Array.from({length: count}, (_, i) => {
    const week = mondayBefore(currentMonday, count - 1 - i);
    const row = byWeek.get(week);
    return {
      week,
      ticketsCreated: row?.ticketsCreated ?? 0,
      ticketsSolved: row?.ticketsSolved ?? 0,
      solvedConfirmed: row?.solvedConfirmed ?? 0,
      solvedAssumed: row?.solvedAssumed ?? 0,
      firstResponses: row?.firstResponses ?? 0,
      firstResponseMedianSecs: row?.firstResponseMedianSecs ?? null,
      csatCount: row?.csatCount ?? 0,
      csatSum: row?.csatSum ?? 0,
    };
  });
  const newest = rows.reduce<number | null>((max, row) => Math.max(max ?? 0, row.updatedAt.getTime()), null);
  return {weeks, updatedAt: newest === null ? null : new Date(newest).toISOString()};
}

export type TopDbRow = {
  /** Null on the one row a computed week with no rankings reads. */
  list: string | null;
  rank: number;
  question: string;
  value: number;
  value2: number;
  updated_at: Date;
  article_id: number | null;
  title: string | null;
  slug: string | null;
};

/**
 * One week's rankings from its rows (rank order kept). `computedAt`: when the nightly job last
 * worked this week out (`helpdesk_stats_weekly.updated_at`, written every run, zeros included),
 * or null when it never has (then the rows' own newest time, if any). A computed week with no rows is `updatedAt` set and empty lists
 * ("nothing to rank"), not "not yet". Pure: tested.
 */
export function buildTop(week: string, rows: readonly TopDbRow[], computedAt: Date | null): TopReport {
  const sorted = rows.filter(row => row.list !== null).sort((a, b) => a.rank - b.rank);
  // A ranking without its week's row can't come from a run (the job writes both); fall back to the rows' own time.
  const newest = sorted.reduce<number | null>((max, row) => Math.max(max ?? 0, row.updated_at.getTime()), null);
  const at = computedAt ? computedAt.getTime() : newest;
  const report: TopReport = {week, updatedAt: at === null ? null : new Date(at).toISOString(), unanswered: [], mostUsed: [], lowestRated: []};
  for (const row of sorted) {
    const article: ArticleRef | null =
      row.article_id !== null && row.title !== null && row.slug !== null ? {id: row.article_id, title: row.title, slug: row.slug} : null;
    if (row.list === 'unanswered') report.unanswered.push({question: row.question, asked: row.value});
    else if (row.list === 'used') report.mostUsed.push({article, answered: row.value});
    else if (row.list === 'low_rated') report.lowestRated.push({article, helpful: row.value2, notHelpful: row.value});
  }
  return report;
}

const weeksQuery = validator('query', value => ({
  count: (isWeekCount(value.count) ? Number(value.count) : 13) as WeekCount,
}));

const topQuery = validator('query', value => ({
  week: isTopWeek(value.week) ? value.week : ('current' as TopWeek),
}));

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
  })

  .get('/overview', withViewer, requireAuth, canSeeReports, withDb, async c => {
    const db = c.var.db;
    const now = new Date();
    const today = utcToday(now);
    const monday = new Date(`${weekKey(now)}T00:00:00Z`);
    // In-memory permission checks (the access set is already loaded by the guard).
    // `can` takes the viewer-only context; this one also carries `db` (Hono's Set is invariant).
    const viewerCtx = c as unknown as Parameters<typeof can>[0];
    const [canKb, canSettings] = await Promise.all([can(viewerCtx, PERMISSIONS.KB_EDIT), can(viewerCtx, PERMISSIONS.HELPDESK_SETTINGS)]);
    const [days, usage, settings, openIssues, failed] = await Promise.all([
      // ≤ 7 rows by primary key.
      db.questionStatsDaily.findMany({
        where: {day: {gte: monday, lte: today}},
        orderBy: {day: 'asc'},
        take: 7,
        select: {day: true, questions: true, answered: true, handedOff: true, noSource: true, helpfulUp: true, helpfulDown: true},
      }),
      monthUsage(db, now),
      db.helpdeskSettings.findUnique({where: {id: 1}, select: {monthlyCapCents: true}}),
      db.$queryRaw<{type: string; n: number}[]>`
        SELECT s."type", count(*)::int AS "n"
        FROM (SELECT "type" FROM "health_issues" WHERE "state" = 'open' ORDER BY "id" DESC LIMIT ${ISSUE_SCAN}) s
        GROUP BY s."type"`,
      canKb
        ? db.kbSource.findMany({where: {state: 'failed'}, orderBy: {updatedAt: 'desc'}, take: FAILED_FILES_TAKE, select: {id: true}})
        : null,
    ]);
    return c.json(
      buildOverview({
        today: now,
        days,
        usage,
        capCents: settings?.monthlyCapCents ?? DEFAULT_CAP_CENTS,
        // Presence only: the key never leaves the server.
        hasKey: Boolean(config.ownerSecret(AI_SECRET_NAMES.anthropic)),
        openIssues,
        failedFiles: failed ? failed.length : null,
        canSettings,
      }) satisfies HelpdeskOverview
    );
  })

  .get('/weeks', weeksQuery, withViewer, requireAuth, canSeeReports, withDb, async c => {
    const {count} = c.req.valid('query');
    const current = weekKey();
    // ≤ 13 rows by primary key.
    const rows = await c.var.db.helpdeskStatsWeekly.findMany({
      where: {week: {gte: new Date(`${mondayBefore(current, count - 1)}T00:00:00Z`)}},
      orderBy: {week: 'asc'},
      take: 13,
      select: {
        week: true,
        ticketsCreated: true,
        ticketsSolved: true,
        solvedConfirmed: true,
        solvedAssumed: true,
        firstResponses: true,
        firstResponseMedianSecs: true,
        csatCount: true,
        csatSum: true,
        updatedAt: true,
      },
    });
    return c.json(fillWeeks(rows, current, count) satisfies WeeksReport);
  })

  .get('/top', topQuery, withViewer, requireAuth, canSeeReports, withDb, async c => {
    const {week} = c.req.valid('query');
    const monday = mondayBefore(weekKey(), week === 'previous' ? 1 : 0);
    // ONE query: when the week was worked out (its weekly row, by primary key) and its ≤ 30 ranking
    // rows (primary-key prefix); only a PUBLISHED article is named. Always ≥ 1 row: with no
    // rankings, one row of nulls carrying "computed_at".
    const rows = await c.var.db.$queryRaw<(TopDbRow & {computed_at: Date | null})[]>`
      SELECT s."updated_at" AS "computed_at", r.*
      FROM (SELECT 1) one
      LEFT JOIN "helpdesk_stats_weekly" s ON s."week" = ${monday}::date
      LEFT JOIN LATERAL (
        SELECT t."list", t."rank", t."question", t."value", t."value2", t."updated_at",
               a."id" AS "article_id", a."title", a."slug"
        FROM "helpdesk_top_weekly" t
        LEFT JOIN "kb_articles" a ON a."id" = t."article_id" AND a."status" = 'published'
        WHERE t."week" = ${monday}::date
        ORDER BY t."list", t."rank"
        LIMIT 30
      ) r ON TRUE`;
    return c.json(buildTop(monday, rows, rows[0]?.computed_at ?? null) satisfies TopReport);
  });
