/**
 * Knowledge health: the JSON shapes of `/site-api/helpdesk/health` (src/server/routes/
 * knowledge-health.ts), shared with the Knowledge health screen. Browser-safe.
 */

export const HEALTH_TYPES = ['gap', 'stale', 'conflict', 'low_rated'] as const;
export type HealthType = (typeof HEALTH_TYPES)[number];

export const HEALTH_STATES = ['open', 'accepted', 'dismissed'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export type DraftState = 'none' | 'pending' | 'ready' | 'failed';

export const isHealthType = (value: unknown): value is HealthType =>
  typeof value === 'string' && (HEALTH_TYPES as readonly string[]).includes(value);

export const isHealthState = (value: unknown): value is HealthState =>
  typeof value === 'string' && (HEALTH_STATES as readonly string[]).includes(value);

/** What the finding is based on. Every field is optional: read it defensively. */
export interface HealthEvidence {
  source?: 'weekly' | 'ticket';
  from?: string;
  to?: string;
  questions?: number;
  noSource?: number;
  lowConfidence?: number;
  samples?: string[];
  lastReviewedAt?: string;
  daysSinceReview?: number;
  views?: number;
  helpful?: number;
  notHelpful?: number;
  rate?: number;
  ticketNumber?: number;
  question?: string;
  agentReplies?: number;
  /** Ticket drafts: the article the assistant had cited (a `conflict` is about it), or null. */
  citedArticleId?: number | null;
  summary?: string;
  missingFacts?: string[];
  noDraftReason?: string;
}

export interface HealthIssueRow {
  id: number;
  type: HealthType;
  state: HealthState;
  title: string;
  draftState: DraftState;
  article: {id: number; title: string; status: 'draft' | 'published' | 'archived'} | null;
  ticketNumber: number | null;
  evidence: HealthEvidence;
  createdAt: string;
  resolvedAt: string | null;
}

export interface HealthIssueDetail extends HealthIssueRow {
  suggestedBody: string;
  draftError: 'off' | 'cap' | 'failed' | null;
  draftAttempts: number;
  acceptedArticleId: number | null;
  article:
    | (NonNullable<HealthIssueRow['article']> & {
        slug: string;
        categoryId: number;
        lastReviewedAt: string;
        helpfulCount: number;
        notHelpfulCount: number;
      })
    | null;
}

export interface HealthIssuesPage {
  items: HealthIssueRow[];
  next: number | null;
  /** Capped at 100 (the screen shows "99+"). */
  openCounts: Record<HealthType, number>;
  lastRun: {
    week: string;
    timeZone: string;
    state: 'running' | 'done' | 'failed';
    finishedAt: string | null;
    gaps: number;
    stale: number;
    lowRated: number;
  } | null;
}

export interface AcceptInput {
  title: string;
  body: string;
  categoryId?: number;
  excerpt?: string;
  slug?: string;
}

export interface AcceptResult {
  issue: {id: number; state: 'accepted'};
  article: {id: number; title: string; status: 'draft'; mode: 'created' | 'updated'};
}
