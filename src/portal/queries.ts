import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import type {HelpdeskReport, QuestionFilter, QuestionsPage, ReportRange} from '../lib/helpdesk-report-types';
import type {
  Agent,
  CannedReply,
  HelpdeskTiles,
  InboxPage,
  MyTicket,
  MyTicketsPage,
  Presence,
  Queue,
  StaffTicket,
} from '../lib/helpdesk-tickets';
import type {TicketPriority} from '../lib/helpdesk-tones';
import type {HelpdeskSettingsAdmin} from '../lib/helpdesk-types';
import type {ArticleStatus, KbManageArticle, KbManageArticlesPage, KbManageCategory, KbSnippetsPage} from '../lib/kb-types';
import type {AdminUser, AuditRow, PermissionRow, RoleRow} from '../lib/types';
import {refreshSession} from '../platform/browser';
import {api, read} from './api';
import type {Me} from './shared';

/**
 * Every portal read, ONCE: the screen (`useQuery(x)`) and its route's loader
 * (`queryClient.ensureQueryData(x)`, src/portal/routes.tsx) use the same
 * options, so a hover on a link fetches what the screen will show and the
 * screen renders from the cache. Kept apart from the screens so the routes can
 * import them without pulling the (lazy) screen code into the first bundle.
 *
 * A save invalidates by key prefix (`['users']`, `['kb']`, `['roles']`): every
 * knowledge-base save invalidates `['kb']`, so the lists, the editor and the
 * overview's tiles all refresh.
 */

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    const me = await read<Me>(api.me.$get());
    // The access token ran out but the refresh token is still there: refresh ONCE.
    if (me.viewer.state === 'returning' && (await refreshSession())) return read<Me>(api.me.$get());
    return me;
  },
  staleTime: 60_000,
});

/** The brand, for the sidebar. Public and cached on the server. */
export const siteQuery = queryOptions({
  queryKey: ['site'],
  queryFn: () => read<{site: {name: string; logo: string | null} | null}>(api.site.$get()),
  staleTime: 5 * 60_000,
});

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => read<{database: boolean; auth: boolean; siteKey: boolean}>(api.health.$get()),
});

export type UsersPage = {users: AdminUser[]; nextBefore: number | null};
export type AuditPage = {events: AuditRow[]; nextBefore: string | null};

/** The overview's tiles: the FIRST page of each list, under the lists' own key prefixes. */
export const firstUsersQuery = queryOptions({
  queryKey: ['users', 'first'],
  queryFn: () => read<UsersPage>(api.admin.users.$get({query: {before: '', email: '', status: ''}})),
});
export const firstAuditQuery = queryOptions({
  queryKey: ['audit', 'first'],
  queryFn: () => read<AuditPage>(api.admin.audit.$get({query: {before: ''}})),
});

/** `/dashboard/users`: every account, newest first, filtered by exact email and status. */
export const usersQuery = (filter: {email: string; status: string}) =>
  infiniteQueryOptions({
    queryKey: ['users', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<UsersPage>(api.admin.users.$get({query: {before: pageParam ?? '', email: filter.email, status: filter.status}})),
    getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
  });

// ---------------------------------------------------------- knowledge base --

/** The Articles screen's filters (and the overview's drafts tile): part of the query key. */
export type KbArticleFilters = {status: ArticleStatus | ''; categoryId: number | ''; q: string};
/** The Articles screen's first view (its route warms it). */
export const KB_ALL_ARTICLES: KbArticleFilters = {status: '', categoryId: '', q: ''};
/** The drafts filter: the overview's "Drafts" tile reads its first page, under the screen's own key. */
export const KB_DRAFTS: KbArticleFilters = {status: 'draft', categoryId: '', q: ''};

/** `/dashboard/articles`: every article (any status), newest first, 20 a page. */
export const kbArticlesQuery = (filters: KbArticleFilters) =>
  infiniteQueryOptions({
    queryKey: ['kb', 'articles', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<KbManageArticlesPage>(
        api.kb.manage.articles.$get({
          query: {status: filters.status, category: String(filters.categoryId), q: filters.q, before: pageParam ?? ''},
        })
      ),
    getNextPageParam: last => (last.next ? String(last.next) : undefined),
  });

/** One article with its body, for the editor. */
export const kbArticleQuery = (id: number) =>
  queryOptions({
    queryKey: ['kb', 'article', id],
    queryFn: () => read<{article: KbManageArticle}>(api.kb.manage.articles[':id'].$get({param: {id: String(id)}})),
  });

/** Every category (≤ 100) with its published and total article counts. */
export const kbCategoriesQuery = queryOptions({
  queryKey: ['kb', 'categories'],
  queryFn: () => read<{categories: KbManageCategory[]}>(api.kb.manage.categories.$get()),
});

/** `/dashboard/snippets`: short answers the assistant may use, newest first. */
export const kbSnippetsQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: ['kb', 'snippets', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => read<KbSnippetsPage>(api.kb.manage.snippets.$get({query: {q, before: pageParam ?? ''}})),
    getNextPageParam: last => (last.next ? String(last.next) : undefined),
  });

// ---------------------------------------------------------------- help desk --

/** `/dashboard/assistant`: the assistant's settings, whether its key is set, this month's spend. */
export const helpdeskSettingsQuery = queryOptions({
  queryKey: ['helpdesk', 'settings'],
  queryFn: () => read<HelpdeskSettingsAdmin>(api.helpdesk.settings.$get()),
});

// ------------------------------------------------- help desk: the inbox --
// Every staff write invalidates `['helpdesk']` (the lists, the open ticket, the overview's tiles).
// A reply or note also `setQueryData`s the ticket first, so it shows before the refetch.

/** The inbox's filters, as in its URL (`/inbox?view=mine&priority=urgent`). Absent view = `waiting`. */
export type InboxFilters = {view?: Queue; priority?: TicketPriority};

/**
 * The summary is written by a job after the hand-off, usually within seconds but later when
 * the job retries: poll every 10 s for the first 2 minutes, then every minute up to 30 minutes.
 */
const SUMMARY_POLL = {fastMs: 10_000, fastForMs: 2 * 60_000, slowMs: 60_000, slowForMs: 30 * 60_000} as const;

/** How often to look for a pending summary `age` ms after the ticket was created (false: stop). */
export function summaryPollMs(age: number): number | false {
  if (age < SUMMARY_POLL.fastForMs) return SUMMARY_POLL.fastMs;
  if (age < SUMMARY_POLL.slowForMs) return SUMMARY_POLL.slowMs;
  return false;
}

/**
 * The inbox's 60 s refresh runs while at most this many pages are loaded. A refetch reloads
 * EVERY loaded page in turn, so deeper in the list it pauses (a write or a revisit still
 * refreshes it). Not `maxPages`: with a keyset list that drops the first page off the top.
 */
const INBOX_REFRESH_PAGES = 3;

/**
 * `/dashboard/inbox`: one queue, 20 a page, sorted by the server per queue (waiting: longest
 * waiting first). Refreshed every minute while the tab is visible, so new tickets appear,
 * as long as no more than 3 pages are loaded (never 10 page reloads a minute).
 */
export const inboxTicketsQuery = (filters: InboxFilters) => {
  const key = {view: filters.view ?? 'waiting', priority: filters.priority ?? ''} as const;
  return infiniteQueryOptions({
    queryKey: ['helpdesk', 'tickets', key],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<InboxPage>(api.helpdesk.tickets.$get({query: {queue: key.view, priority: key.priority, cursor: pageParam ?? ''}})),
    getNextPageParam: last => last.next ?? undefined,
    refetchInterval: query => ((query.state.data?.pages.length ?? 0) > INBOX_REFRESH_PAGES ? false : 60_000),
    refetchIntervalInBackground: false,
  });
};

const staffTicket = (number: number, before: string) =>
  read<{ticket: StaffTicket}>(api.helpdesk.tickets[':number'].$get({param: {number: String(number)}, query: {before}}));

/**
 * One ticket for an agent: its header, the AI summary and sources, and the newest 100 thread
 * items (notes included; `thread.nextBefore` loads earlier ones, `inboxThreadQuery`). While the
 * summary is being written it refetches with a backoff (`summaryPollMs`): every 10 s for 2
 * minutes after the hand-off, then every minute up to 30 minutes.
 */
export const inboxTicketQuery = (number: number) =>
  queryOptions({
    queryKey: ['helpdesk', 'ticket', number],
    queryFn: () => staffTicket(number, ''),
    refetchInterval: query => {
      const ticket = query.state.data?.ticket;
      if (!ticket || ticket.aiSummaryState !== 'pending') return false;
      return summaryPollMs(Date.now() - Date.parse(ticket.createdAt));
    },
    refetchIntervalInBackground: false,
  });

/** Earlier thread items of a ticket, before message id `before` (the ticket's `thread.nextBefore`). */
export const inboxThreadQuery = (number: number, before: string) =>
  queryOptions({
    queryKey: ['helpdesk', 'ticket', number, 'before', before],
    queryFn: async () => (await staffTicket(number, before)).ticket.thread,
    staleTime: Infinity,
  });

/**
 * "Sam is also viewing": a heartbeat (POST: it records that I'm viewing) that answers who else is.
 * Every 30 s while the ticket is open and the tab is visible; gone the moment the ticket closes.
 * If `lastMessageAt` is newer than the loaded ticket's, the screen invalidates the ticket.
 */
export const inboxViewersQuery = (number: number) =>
  queryOptions({
    queryKey: ['helpdesk', 'ticket', number, 'viewers'],
    queryFn: () => read<Presence>(api.helpdesk.tickets[':number'].presence.$post({param: {number: String(number)}})),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

/** Who can take a ticket (holders of the inbox permission): names only, ≤ 100. */
export const inboxAgentsQuery = queryOptions({
  queryKey: ['helpdesk', 'agents'],
  queryFn: () => read<{agents: Agent[]}>(api.helpdesk.tickets.agents.$get()),
  staleTime: 5 * 60_000,
});

/** The overview's three tiles (counters kept on write, never a count query). */
export const helpdeskStatsQuery = queryOptions({
  queryKey: ['helpdesk', 'stats'],
  queryFn: () => read<HelpdeskTiles>(api.helpdesk.tickets.tiles.$get()),
});

/** A page of saved replies (the list is ≤ 100, so it is ONE page). */
export type SavedRepliesPage = {replies: CannedReply[]; next: null};

/** Saved replies whose name or text holds `q` (any case); everything when `q` is blank. */
export function matchSavedReplies(replies: CannedReply[], q: string): CannedReply[] {
  const needle = q.trim().toLowerCase();
  return needle ? replies.filter(r => r.title.toLowerCase().includes(needle) || r.body.toLowerCase().includes(needle)) : replies;
}

/**
 * Saved replies, the agents' own list (≤ 100, `position` order): the composer's "Insert a
 * saved reply" and `/saved-replies`. ONE cache entry, fetched once: `q` narrows it in the
 * browser through `select` (title or text, any case), so typing never refetches.
 * Infinite so screens use `LoadMore` like every list; it never has a second page.
 * Writes invalidate `['helpdesk', 'replies']`.
 */
export const savedRepliesQuery = (q = '') =>
  infiniteQueryOptions({
    queryKey: ['helpdesk', 'replies'],
    initialPageParam: undefined as string | undefined,
    queryFn: async (): Promise<SavedRepliesPage> => {
      const {replies} = await read<{replies: CannedReply[]}>(api.helpdesk.canned.$get());
      return {replies, next: null};
    },
    getNextPageParam: () => undefined,
    select: q.trim() ? data => ({...data, pages: data.pages.map(page => ({...page, replies: matchSavedReplies(page.replies, q)}))}) : undefined,
  });

// ------------------------------------------------- help desk: My support --
// The signed-in person's OWN requests (the server scopes every read to them). Every customer
// write invalidates `['support']`.

/** `/dashboard/support`: my requests, newest first, 20 a page. */
export const supportTicketsQuery = infiniteQueryOptions({
  queryKey: ['support', 'tickets'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<MyTicketsPage>(api.helpdesk.my.tickets.$get({query: {before: pageParam ?? ''}})),
  getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
});

const myTicket = (number: number, before: string) =>
  read<{ticket: MyTicket}>(api.helpdesk.my.tickets[':number'].$get({param: {number: String(number)}, query: {before}}));

/**
 * One of my requests: no notes, summary, sources or assignment (the server never sends them).
 * Refetched on window focus and every minute while visible, so a reply from the team appears.
 */
export const supportTicketQuery = (number: number) =>
  queryOptions({
    queryKey: ['support', 'ticket', number],
    queryFn: () => myTicket(number, ''),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

/** Earlier messages of one of my requests, before message id `before` (`thread.nextBefore`). */
export const supportThreadQuery = (number: number, before: string) =>
  queryOptions({
    queryKey: ['support', 'ticket', number, 'before', before],
    queryFn: async () => (await myTicket(number, before)).ticket.thread,
    staleTime: Infinity,
  });

/** How many of my requests have a reply I haven't seen (capped by the server at 10: "9+"). The nav badge. */
export const supportUnreadQuery = queryOptions({
  queryKey: ['support', 'unread'],
  queryFn: () => read<{count: number}>(api.helpdesk.my.unread.$get()),
  staleTime: 60_000,
});

/** `/dashboard/activity`: the audit log, newest first. */
export const auditQuery = infiniteQueryOptions({
  queryKey: ['audit'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<AuditPage>(api.admin.audit.$get({query: {before: pageParam ?? ''}})),
  getNextPageParam: last => last.nextBefore ?? undefined,
});

export const rolesQuery = queryOptions({
  queryKey: ['roles'],
  queryFn: () => read<{roles: RoleRow[]}>(api.admin.roles.$get()),
});

/** The permission catalogue: changes only with a migration. */
export const permissionsQuery = queryOptions({
  queryKey: ['permissions'],
  queryFn: () => read<{permissions: PermissionRow[]}>(api.admin.permissions.$get()),
  staleTime: 5 * 60_000,
});

/** Two-step sign-in, for the account screen. */
export type TwoFactorStatus = {enabled: boolean; recoveryCodesLeft: number; hasPassword: boolean};
export const twoFactorQuery = queryOptions({
  queryKey: ['account', 'two-factor'],
  queryFn: () => read<TwoFactorStatus>(api.auth['two-factor'].$get()),
});

/** The devices signed in to this account (this one marked `current`). */
export type DeviceSession = {id: string; device: string; lastActiveAt: string; current: boolean};
export const sessionsQuery = queryOptions({
  queryKey: ['account', 'sessions'],
  queryFn: () => read<{sessions: DeviceSession[]}>(api.auth.sessions.$get()),
});

// ------------------------------------------------ help desk: Analytics --
// Holders of `site:helpdesk:reports` (`/dashboard/analytics`). Read only: nothing invalidates them.

/** The period's totals, the period before it and the chart's buckets (`question_stats_daily`). */
export const helpdeskReportQuery = (range: ReportRange) =>
  queryOptions({
    queryKey: ['helpdesk', 'reports', range],
    queryFn: () => read<HelpdeskReport>(api.helpdesk.reports.$get({query: {range}})),
    staleTime: 60_000,
  });

/** The questions customers asked, newest first, 25 a page, keyset on id; the filter is in the key. */
export const helpdeskQuestionsQuery = (filter: QuestionFilter) =>
  infiniteQueryOptions({
    queryKey: ['helpdesk', 'reports', 'questions', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<QuestionsPage>(api.helpdesk.reports.questions.$get({query: {filter, before: pageParam ?? ''}})),
    getNextPageParam: last => last.nextBefore ?? undefined,
    staleTime: 60_000,
  });
