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
