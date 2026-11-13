/**
 * Tickets: the JSON shapes, limits and words shared by the Site API (src/server/routes/support.ts,
 * inbox.ts, canned.ts), the chat widget's hand-off (src/lib/helpdesk-widget.ts) and the dashboard
 * (My support, the inbox, saved replies). Browser-safe: no server imports.
 *
 * THE status of a ticket lives in `conversations.status` (src/server/helpdesk/state.ts moves it).
 * Customers never receive `note` lines, the AI summary, the AI sources or `confidence`.
 */
import type {TicketPriority, TicketStatus} from './helpdesk-tones';

export type {TicketPriority, TicketStatus};

export const TICKET_LIMITS = {
  /** A message (customer or agent reply), 1–4000 characters after trimming. */
  body: 4000,
  /** The widget's transcript sent with a hand-off: at most 50 lines, 12,000 characters in all. */
  transcriptLines: 50,
  transcriptChars: 12000,
  /** The customer's own words to the team at hand-off, 0–4000. */
  note: 4000,
  subject: 120,
  cannedTitle: 80,
  cannedBody: 4000,
  cannedMax: 100,
  citationsPerLine: 5,
  aiSources: 10,
  /** Customer messages (hand-offs + replies) per hour, per account. */
  customerPerHour: 30,
  /** A solved ticket takes customer replies for this many days, then it is closed. */
  reopenDays: 14,
} as const;

export const TICKET_STATUSES: readonly TicketStatus[] = ['waiting', 'open', 'pending', 'solved'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
/** Not solved: what the "unsolved" tile counts. */
export const UNSOLVED: readonly TicketStatus[] = ['waiting', 'open', 'pending'];

export type MessageSender = 'customer' | 'ai' | 'agent' | 'note';
export type Queue = 'waiting' | 'mine' | 'pending' | 'solved';
export const QUEUES: readonly Queue[] = ['waiting', 'mine', 'pending', 'solved'];
export type Resolution = 'confirmed' | 'assumed' | 'none';
export type SummaryState = 'pending' | 'ready' | 'unavailable';

/** An article link the assistant showed. `id` is null when the article is gone (a snapshot). */
export interface SourceLink {
  id: number | null;
  title: string;
  url: string;
}

/**
 * A customer whose account was deleted: their tickets stay (anonymised, `conversations.user_id`
 * set to null by the foreign key) and show under this name. They never appear in anyone's My support.
 */
export const DELETED_CUSTOMER_NAME = 'Deleted customer';

/** The customer on a staff row. `id` is null when the account was deleted (no link to Users). */
export interface TicketCustomer {
  id: number | null;
  name: string;
}

/** `user` as read from `conversations.user` (null after an account deletion) → the customer to show. */
export function customerOf(user: {id: number; name: string} | null | undefined): TicketCustomer {
  if (!user) return {id: null, name: DELETED_CUSTOMER_NAME};
  return {id: user.id, name: user.name.trim() || 'Customer'};
}

export interface ThreadMessage {
  /** BigInt as a string. */
  id: string;
  /** Customers never receive 'note'. */
  sender: MessageSender;
  /** The agent's / customer's name; null for ai (the UI shows the assistant's name). */
  author: string | null;
  body: string;
  /** ai lines only, else []. */
  citations: SourceLink[];
  /** Staff view only (the customer view: always null). */
  confidence: string | null;
  createdAt: string;
}

/** Newest page first (the UI reverses). `nextBefore`: the message id to send as `?before=`. */
export interface ThreadPage {
  messages: ThreadMessage[];
  nextBefore: string | null;
}

/* ---------------------------------------------------------------- customer */

export interface MyTicketRow {
  number: number;
  subject: string;
  status: TicketStatus;
  unread: boolean;
  lastMessageAt: string;
  createdAt: string;
}

/** `nextBefore`: opaque to the UI (the caller's own conversation id), sent back as `?before=`. */
export interface MyTicketsPage {
  items: MyTicketRow[];
  nextBefore: number | null;
}

export interface MyTicket {
  number: number;
  subject: string;
  status: TicketStatus;
  resolution: Resolution;
  createdAt: string;
  solvedAt: string | null;
  csat: number | null;
  /** False when solved more than `reopenDays` ago. */
  canReply: boolean;
  /** Solved and not rated yet. */
  canRate: boolean;
  thread: ThreadPage;
}

export interface CreateConversationInput {
  /** IDEMPOTENCY_KEY (/^[A-Za-z0-9_-]{16,64}$/), reused on every retry of one hand-off. */
  key: string;
  transcript: {role: 'customer' | 'assistant'; text: string; citations?: {title: string; url: string}[]}[];
  /** The customer's own words to the team (required when there is no customer line). */
  note?: string;
  /** A path only, no query. */
  page?: string;
}

export interface CreateConversationResult {
  ticket: {number: number; status: TicketStatus};
  created: boolean;
}

/* ---------------------------------------------------------------- staff */

export interface Agent {
  id: number;
  name: string;
}

export interface InboxRow {
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  customer: TicketCustomer;
  assignee: Agent | null;
  /** Waiting time = now − lastMessageAt; age = now − createdAt (the UI works them out). */
  lastMessageAt: string;
  createdAt: string;
}

/** `next`: an opaque cursor ("<epoch ms>|<id>" or "<id>"), sent back as `?cursor=`. */
export interface InboxPage {
  items: InboxRow[];
  next: string | null;
}

export interface StaffTicket {
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  resolution: Resolution;
  customer: TicketCustomer;
  /** The viewer may open the customer in Users (where the email is shown); false for a deleted customer. */
  canSeeUser: boolean;
  assignee: Agent | null;
  aiSummary: string | null;
  aiSummaryState: SummaryState;
  aiSources: SourceLink[];
  pagePath: string;
  language: string;
  csat: number | null;
  createdAt: string;
  solvedAt: string | null;
  lastMessageAt: string;
  /** Notes included. */
  thread: ThreadPage;
}

export interface Presence {
  status: TicketStatus;
  lastMessageAt: string;
  others: {id: number; name: string; viewedAt: string}[];
}

export interface CannedReply {
  id: number;
  title: string;
  body: string;
  position: number;
}

export interface HelpdeskTiles {
  unsolved: number;
  waitingOnUs: number;
  solvedThisWeek: number;
}

/* ---------------------------------------------------------------- words and rules */

/**
 * Status words for CUSTOMERS (My support, the widget). The staff words ("Waiting on us") would
 * read backwards to them. Tones still come from `TICKET_STATUS_TONES` (helpdesk-tones.ts).
 */
export const CUSTOMER_STATUS_LABELS: Record<TicketStatus, string> = {
  waiting: 'With our team',
  open: 'With our team',
  pending: 'Waiting for you',
  solved: 'Solved',
};

/**
 * A ticket's subject from the customer's first words: whitespace collapsed, cut to 120 characters
 * at a word when one ends in the second half (else mid-word), with "…" when cut. '' stays ''.
 */
export function ticketSubject(text: string, max: number = TICKET_LIMITS.subject): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = max - 1; // the ellipsis
  const cut = flat.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  const head = space >= Math.floor(room / 2) ? cut.slice(0, space) : flat.slice(0, room);
  return `${head.trimEnd()}…`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the customer may still reply: not solved, or solved less than `reopenDays` ago. */
export function customerCanReply(status: TicketStatus, solvedAt: Date | string | null, now: Date = new Date()): boolean {
  if (status !== 'solved') return true;
  if (!solvedAt) return true;
  const solved = typeof solvedAt === 'string' ? Date.parse(solvedAt) : solvedAt.getTime();
  if (!Number.isFinite(solved)) return false;
  return now.getTime() - solved < TICKET_LIMITS.reopenDays * DAY_MS;
}
