/**
 * The help desk's statuses mapped to badge tones ONCE. Every dashboard screen,
 * the public pages and the chat widget read their colours from here, so a
 * "pending" ticket is the same colour everywhere (docs/design-system.md).
 *
 * The tone names match the kit's `Tone` (`src/portal/ui/display.tsx`) and the
 * `.badge-<tone>` / `.status-<tone>` classes in the stylesheets. `brand` is the
 * accent colour.
 */
export type HelpdeskTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export type TicketStatus = 'waiting' | 'open' | 'pending' | 'solved';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type Confidence = 'high' | 'medium' | 'low' | 'none';
export type ArticleStatus = 'draft' | 'published' | 'archived';

export const TICKET_STATUS_TONES: Record<TicketStatus, HelpdeskTone> = {
  waiting: 'info',
  open: 'brand',
  pending: 'warning',
  solved: 'success',
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  waiting: 'Waiting on us',
  open: 'Open',
  pending: 'Pending',
  solved: 'Solved',
};

export const PRIORITY_TONES: Record<TicketPriority, HelpdeskTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const CONFIDENCE_TONES: Record<Confidence, HelpdeskTone> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
  none: 'danger',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'No source',
};

export const ARTICLE_STATUS_TONES: Record<ArticleStatus, HelpdeskTone> = {
  published: 'success',
  draft: 'neutral',
  archived: 'neutral',
};

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  published: 'Published',
  draft: 'Draft',
  archived: 'Archived',
};
