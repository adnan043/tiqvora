/**
 * Help desk analytics: the JSON shapes of `/site-api/helpdesk/reports` (src/server/routes/
 * helpdesk-reports.ts), shared with the Analytics screen. Browser-safe.
 */

/** The periods a report covers, each ending today (UTC), and how its chart is bucketed. */
export const REPORT_RANGES = {
  '7d': {days: 7, bucketDays: 1, label: '7 days'},
  '4w': {days: 28, bucketDays: 7, label: '4 weeks'},
  '13w': {days: 91, bucketDays: 7, label: '13 weeks'},
} as const;

export type ReportRange = keyof typeof REPORT_RANGES;

export const isReportRange = (value: unknown): value is ReportRange =>
  typeof value === 'string' && Object.hasOwn(REPORT_RANGES, value);

export interface ReportTotals {
  questions: number;
  answered: number;
  handedOff: number;
  noSource: number;
  aiOff: number;
  helpfulUp: number;
  helpfulDown: number;
  /** What the AI calls cost, rounded up to the cent. */
  costCents: number;
}

export interface ReportBucket {
  /** The bucket's first UTC day, `YYYY-MM-DD`. */
  start: string;
  questions: number;
  answered: number;
  handedOff: number;
  noSource: number;
}

/** GET /site-api/helpdesk/reports?range= */
export interface HelpdeskReport {
  range: ReportRange;
  /** First and last UTC day covered, `YYYY-MM-DD`. */
  from: string;
  to: string;
  totals: ReportTotals;
  /** The same length of time just before `from`, for the trend. */
  previous: ReportTotals;
  buckets: ReportBucket[];
}

/** The question list's filters (`unhelpful`: the customer said the answer didn't help). */
export const QUESTION_FILTERS = ['all', 'answered', 'handed_off', 'no_source', 'ai_off', 'unhelpful'] as const;
export type QuestionFilter = (typeof QUESTION_FILTERS)[number];

export const isQuestionFilter = (value: unknown): value is QuestionFilter =>
  typeof value === 'string' && (QUESTION_FILTERS as readonly string[]).includes(value);

export type QuestionOutcome = 'answered' | 'handed_off' | 'no_source' | 'ai_off';

export interface QuestionRow {
  /** A BigInt in the database: a string here. */
  id: string;
  question: string;
  outcome: QuestionOutcome;
  confidence: 'high' | 'medium' | 'low' | 'none';
  helpful: boolean | null;
  /** The page it was asked on, a path only, or ''. */
  pagePath: string;
  /** The best matching article, when it still exists. */
  article: {title: string; slug: string} | null;
  createdAt: string;
}

/** GET /site-api/helpdesk/reports/questions?filter=&before= */
export interface QuestionsPage {
  items: QuestionRow[];
  nextBefore: string | null;
}

// ---------------------------------------------------------------------------------------------
// Phase 5: the Overview tiles, the Tickets tab (weekly) and the Knowledge tab (rankings).
// Weeks are UTC weeks, named by their Monday (`YYYY-MM-DD`).

/** Overview "Needs attention" kinds, most urgent first (HEALTH_ORDER). */
export type HealthKind =
  | 'assistant_off' // no AI key, or a monthly budget of 0
  | 'cap_reached' // this month's spend reached the budget
  | 'cap_near' // ≥ 80 % of the budget
  | 'failed_files' // knowledge files that failed or couldn't be read
  | 'no_source' // this week's questions that found no article (question_stats_daily)
  | 'knowledge_gaps' // Knowledge health: open gap issues (conflicts are not counted here)
  | 'low_rated' // Knowledge health: open low_rated issues
  | 'stale_articles'; // Knowledge health: open stale issues

export const HEALTH_ORDER: readonly HealthKind[] = [
  'assistant_off',
  'cap_reached',
  'cap_near',
  'failed_files',
  'no_source',
  'knowledge_gaps',
  'low_rated',
  'stale_articles',
];

/** At most this many health items are returned. */
export const HEALTH_MAX = 6;
/** Spend at or above this share of the budget is "near". */
export const CAP_NEAR_RATIO = 0.8;

export interface HealthIssue {
  kind: HealthKind;
  /** 0 for `assistant_off` / `cap_reached`; the percent spent for `cap_near`; else how many. */
  count: number;
  /** The count hit its cap: show "N+". */
  more: boolean;
}

/** GET /site-api/helpdesk/reports/overview */
export interface HelpdeskOverview {
  /** UTC Monday … today, `YYYY-MM-DD`. */
  week: {from: string; to: string};
  questions: number;
  answered: number;
  handedOff: number;
  noSource: number;
  helpfulUp: number;
  helpfulDown: number;
  /** Answers per day, Monday first, today last (length 1–7, zeros filled). */
  answeredByDay: number[];
  /**
   * This UTC month's AI spend (every AI call: answers, summaries, drafts, files), against the budget.
   * Only for holders of HELPDESK_SETTINGS (who can change the budget); absent for everyone else.
   */
  spend?: {month: string; spentCents: number; capCents: number; requests: number};
  /** An AI key is present AND the monthly budget is above 0. */
  aiReady: boolean;
  /** At most 6, in HEALTH_ORDER; only the kinds this viewer may act on. */
  health: HealthIssue[];
}

/** The Tickets tab's choices of how many weeks to show. */
export const WEEK_COUNTS = [4, 13] as const;
export type WeekCount = (typeof WEEK_COUNTS)[number];
export const isWeekCount = (value: unknown): value is WeekCount =>
  value === 4 || value === 13 || value === '4' || value === '13';

/** One UTC week of tickets. Resolutions are counted by the week the ticket was solved. */
export interface WeeklyRow {
  /** The Monday, `YYYY-MM-DD`. */
  week: string;
  ticketsCreated: number;
  /** Tickets solved this week that are still solved (confirmed + assumed + any other). */
  ticketsSolved: number;
  /** The customer marked it solved (or confirmed the team's solve). */
  solvedConfirmed: number;
  /** The team marked it solved; can still be reopened or confirmed for 14 days. */
  solvedAssumed: number;
  /** Tickets CREATED this week that got a first team reply. */
  firstResponses: number;
  /** Their median time to that reply, in seconds; null when none. */
  firstResponseMedianSecs: number | null;
  /** Ratings given this week, and their sum (1–5 each). Shown apart from resolutions. */
  csatCount: number;
  csatSum: number;
}

/** GET /site-api/helpdesk/reports/weeks?count=4|13 */
export interface WeeksReport {
  /** Oldest first, exactly `count` weeks ending with the current one (missing weeks are zeros). */
  weeks: WeeklyRow[];
  /** Newest time the nightly job wrote these; null = it has not run yet. */
  updatedAt: string | null;
}

export const TOP_WEEKS = ['current', 'previous'] as const;
export type TopWeek = (typeof TOP_WEEKS)[number];
export const isTopWeek = (value: unknown): value is TopWeek =>
  typeof value === 'string' && (TOP_WEEKS as readonly string[]).includes(value);

/** The rankings' lists in `helpdesk_top_weekly.list`. */
export type TopList = 'unanswered' | 'used' | 'low_rated';
/** Rows per ranking. */
export const TOP_SIZE = 10;
/** An article needs this many votes to be ranked "lowest rated". */
export const LOW_RATED_MIN_VOTES = 5;

export interface ArticleRef {
  id: number;
  title: string;
  slug: string;
}

/** GET /site-api/helpdesk/reports/top?week=current|previous */
export interface TopReport {
  /** The Monday, `YYYY-MM-DD`. */
  week: string;
  /**
   * When the nightly job last worked this week out (`helpdesk_stats_weekly.updated_at`, written every
   * run even when nothing ranks); null = never yet. Set with empty lists = computed, nothing to rank.
   */
  updatedAt: string | null;
  /** Questions that found no article, most asked first (≤ 10). */
  unanswered: {question: string; asked: number}[];
  /** Articles that were the best match of answered questions (≤ 10). `article` null: no longer published. */
  mostUsed: {article: ArticleRef | null; answered: number}[];
  /** Articles with the most "not helpful" votes, all time, ≥ 5 votes (≤ 10). */
  lowestRated: {article: ArticleRef | null; helpful: number; notHelpful: number}[];
}
