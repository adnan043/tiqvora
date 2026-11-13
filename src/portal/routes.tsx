import {type QueryClient, useQuery} from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  type ErrorComponentProps,
  Link,
  lazyRouteComponent,
  Outlet,
  useMatches,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {useEffect, useRef, useState} from 'react';

import {isQuestionFilter, isReportRange, type QuestionFilter, type ReportRange} from '../lib/helpdesk-report-types';
import {clearHelpdeskStorage} from '../lib/helpdesk-storage';
import {QUEUES, type Queue, TICKET_PRIORITIES} from '../lib/helpdesk-tickets';
import type {TicketPriority} from '../lib/helpdesk-tones';
import {HEALTH_STATES, HEALTH_TYPES, type HealthState, type HealthType} from '../lib/knowledge-health-types';
import type {Abilities} from '../lib/types';
import {logout} from '../platform/browser';
import {
  auditQuery,
  firstAuditQuery,
  firstUsersQuery,
  healthIssueQuery,
  healthIssuesQuery,
  healthQuery,
  helpdeskOverviewQuery,
  helpdeskQuestionsQuery,
  helpdeskReportQuery,
  helpdeskSettingsQuery,
  helpdeskStatsQuery,
  helpdeskTopQuery,
  helpdeskWeeksQuery,
  inboxAgentsQuery,
  inboxTicketQuery,
  inboxTicketsQuery,
  KB_ALL_ARTICLES,
  KB_DRAFTS,
  kbArticlesQuery,
  kbCategoriesQuery,
  kbFilesQuery,
  kbFilesUsageQuery,
  kbSnippetsQuery,
  meQuery,
  permissionsQuery,
  rolesQuery,
  savedRepliesQuery,
  sessionsQuery,
  siteQuery,
  supportTicketQuery,
  supportTicketsQuery,
  supportUnreadQuery,
  testCasesQuery,
  testRunQuery,
  twoFactorQuery,
  usersQuery,
} from './queries';
import {ticketNumberOf, useMe, useSite} from './shared';
import {
  Avatar,
  Button,
  buttonClass,
  ConfirmProvider,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  initials,
  LoadingBlock,
  Menu,
  ToastProvider,
} from './ui';

/**
 * The portal's screens: a TanStack Router app under `/dashboard` (basepath),
 * served by `src/pages/portal/[...path].astro` (signed-in users only), with
 * data from the Site API through TanStack Query. Links INSIDE the portal use
 * `<Link>`; links to the website (`/`, `/blog/`, `/account/…`) are plain
 * `<a href>`.
 *
 * Add a screen (all five, every time):
 *   1. its reads as `queryOptions` in `queries.ts`, used by the screen with `useQuery(x)`;
 *   2. the component in `screens/<name>.tsx` (a named export);
 *   3. a `createRoute` below: literal `path`, `staticData.title` (the top bar
 *      and the tab), a `loader` that warms its queries, and the component
 *      LAZY (`lazyRouteComponent(() => import('./screens/<name>'), 'Name')`)
 *      so its code loads on first use (or on hover), never in the first bundle;
 *   4. its route in `routeTree`;
 *   5. one item in `NAV_GROUPS` if it belongs in the sidebar.
 * Never a plain `<a href>` to a portal path: it reloads the whole app.
 */

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The screen's name: the top bar's `<h1>` and the tab's title. */
    title?: string;
    /**
     * `'full'`: the screen fills the whole area under the top bar, edge to edge, with no page
     * padding or max width, and scrolls its own panes (the inbox). The shell sets
     * `data-layout="full"` on `.app-shell` (src/styles/app.css, shell section).
     */
    layout?: 'full';
    /**
     * Who the full layout is for: a visitor whose `abilities[ability]` is false gets the normal
     * layout (the screen shows them its "not for you" state in a normal page).
     */
    layoutAbility?: keyof Abilities;
  }
}

/**
 * Warm a screen's queries before it renders (on navigation, and on hover via
 * `defaultPreload: 'intent'`). A failed read is NOT thrown: the screen shows
 * the error in place from the same query, as it always has.
 */
const warm = (...reads: Promise<unknown>[]) => Promise.all(reads.map(read => read.catch(() => undefined))).then(() => undefined);

/** While a slow screen loads (after `defaultPendingMs`). */
export function RoutePending() {
  return (
    <div className="app-page">
      <LoadingBlock rows={4} />
    </div>
  );
}

/** A screen that failed to render or to load its code (an old tab after a Publish: reload). */
export function RouteError({error}: ErrorComponentProps) {
  const router = useRouter();
  const failure = error instanceof Error ? error : new Error('Something went wrong.');
  const stale = /dynamically imported module|module script|Importing a module/i.test(failure.message);
  return (
    <div className="app-page">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? 'This dashboard was updated' : 'This screen could not load'}
        action={
          <Button variant="secondary" icon="refresh" onClick={() => (stale ? window.location.reload() : void router.invalidate())}>
            {stale ? 'Reload' : 'Try again'}
          </Button>
        }>
        {stale ? 'Reload to get the new version.' : failure.message}
      </EmptyState>
    </div>
  );
}

type NavItem = {
  to: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  ability?: keyof Abilities;
  /** A count next to the label: `unread` = my requests with a reply I haven't seen. */
  badge?: 'unread';
};

/**
 * The sidebar, in groups. `ability` hides an item the visitor may not use;
 * that only HIDES it, the route's guard is the enforcement. A group with no
 * visible item is not shown.
 */
const NAV_GROUPS: {label: string; items: NavItem[]}[] = [
  {
    label: 'Workspace',
    items: [
      {to: '/', label: 'Overview', icon: 'dashboard', exact: true},
      // Not exact: `/support/1042` keeps it active.
      {to: '/support', label: 'My support', icon: 'message-square', badge: 'unread'},
      {to: '/account', label: 'Your account', icon: 'user'},
    ],
  },
  {
    label: 'Knowledge base',
    items: [
      {to: '/articles', label: 'Articles', icon: 'file', ability: 'editKnowledge'},
      {to: '/categories', label: 'Categories', icon: 'menu', ability: 'editKnowledge'},
      {to: '/snippets', label: 'Snippets', icon: 'layers', ability: 'editKnowledge'},
      {to: '/import', label: 'Import', icon: 'database', ability: 'editKnowledge'},
      {to: '/files', label: 'Files', icon: 'upload', ability: 'editKnowledge'},
    ],
  },
  {
    label: 'Help desk',
    items: [
      {to: '/inbox', label: 'Inbox', icon: 'inbox', ability: 'useInbox'},
      {to: '/saved-replies', label: 'Saved replies', icon: 'copy', ability: 'useInbox'},
      {to: '/assistant', label: 'Assistant', icon: 'zap', ability: 'manageHelpdesk'},
      {to: '/test-lab', label: 'Test Lab', icon: 'flask', ability: 'manageHelpdesk'},
      {to: '/analytics', label: 'Analytics', icon: 'trending-up', ability: 'seeHelpdeskReports'},
      {to: '/knowledge-health', label: 'Knowledge health', icon: 'check-circle', ability: 'seeHelpdeskReports'},
    ],
  },
  {
    label: 'Manage',
    items: [
      {to: '/users', label: 'Users', icon: 'users', ability: 'manageUsers'},
      {to: '/roles', label: 'Roles', icon: 'shield', ability: 'manageRoles'},
      {to: '/activity', label: 'Activity', icon: 'activity', ability: 'readAudit'},
    ],
  },
  // Only in the Preview and `npm run dev` (never in a build): the UI kit, on screen.
  ...(import.meta.env.DEV
    ? [{label: 'Build', items: [{to: '/components', label: 'Components', icon: 'briefcase' as const}]}]
    : []),
];

/** The screen's title for the top bar and the tab: the deepest route's `staticData.title`. */
function useScreenTitle() {
  const matches = useMatches();
  return [...matches].reverse().find(match => match.staticData.title)?.staticData.title ?? 'Dashboard';
}

/** The deepest route's `staticData.layout`, unless the visitor isn't who that layout is for. */
function useScreenLayout(abilities: Abilities | undefined) {
  const matches = useMatches();
  const data = [...matches].reverse().find(match => match.staticData.layout)?.staticData;
  if (!data?.layout) return undefined;
  if (data.layoutAbility && abilities && !abilities[data.layoutAbility]) return undefined;
  return data.layout;
}

/** The nav badge's text: "3", or "9+" (the server caps the count at 10). */
const badgeCount = (count: number) => (count > 9 ? '9+' : String(count));

/**
 * After every in-app navigation (never the first load): the tab title says
 * where you are, and focus moves to the screen's `<h1>` so keyboard and
 * screen reader users start at the new screen (it is read out), as after a
 * page load.
 */
function useNavigationFocus(title: string, siteName: string | undefined) {
  const heading = useRef<HTMLHeadingElement>(null);
  const resolved = useRouterState({select: s => s.resolvedLocation?.pathname});
  const first = useRef(true);
  // "<title> · <site>", as App.astro writes it on the first load.
  const [fallbackName] = useState(() => document.title.split(' · ').slice(1).join(' · ') || 'My site');
  useEffect(() => {
    document.title = `${title} · ${siteName ?? fallbackName}`;
  }, [title, siteName, fallbackName]);
  useEffect(() => {
    if (!resolved) return;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({preventScroll: true});
  }, [resolved]);
  return {heading, resolved};
}

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'site:theme';

/** Light, dark or the device's: `data-theme` on <html> (global.css), remembered in this browser. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage blocked: the choice lasts until the tab closes.
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

/**
 * The app shell: a full-height sidebar (brand, grouped nav, way back to the
 * website), a top bar (screen title, theme, the user's menu) and the screen
 * in between; a drawer with a scrim on small screens. Every screen renders
 * inside it, with toasts (`useToast`) and confirmations (`useConfirm`)
 * mounted once here. Nothing here reloads the page.
 */
const rootRoute = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: function Root() {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </ToastProvider>
    );
  },
  notFoundComponent: () => (
    <div className="app-page">
      <EmptyState
        icon="search"
        title="This page does not exist"
        action={
          <Link className={buttonClass({variant: 'secondary'})} to="/">
            Back to the overview
          </Link>
        }>
        The link may be old, or the page was moved.
      </EmptyState>
    </div>
  ),
});

function Shell() {
  const me = useMe();
  const site = useSite();
  const navigate = useNavigate();
  const title = useScreenTitle();
  const siteName = site.data?.site?.name;
  const {heading, resolved} = useNavigationFocus(title, siteName);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  // `logout()` reloads the page when it is done, so pending never needs resetting.
  const [signingOut, setSigningOut] = useState(false);
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  const layout = useScreenLayout(abilities);
  // My requests with a reply I haven't seen (the "My support" badge). Cheap: ≤ 10 ids, one index.
  const unread = useQuery({...supportUnreadQuery, enabled: viewer?.state === 'user'});
  // Signed out meanwhile (or never signed in, in the editor Preview, where
  // the host page cannot see the session): go and sign in, then come back.
  const signedOut = viewer !== undefined && viewer.state !== 'user';
  useEffect(() => {
    if (!signedOut) return;
    const back = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.replace(`/account/login/?next=${back}`);
  }, [signedOut]);
  // The drawer closes on navigation and on Esc.
  useEffect(() => setOpen(false), [resolved]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (signedOut) return null;

  const name = siteName ?? 'My site';
  const logo = site.data?.site?.logo;
  return (
    <div className="app-shell" data-nav-open={open ? '' : undefined} data-layout={layout}>
      <aside className="app-sidebar" aria-label="Sidebar">
        <a className="app-brand" href="/">
          <span className="app-brand-mark">{logo ? <img src={logo} alt="" /> : initials(name) || '·'}</span>
          <span className="app-brand-name">{name}</span>
        </a>
        <nav className="app-nav" aria-label="Dashboard">
          {NAV_GROUPS.map(group => {
            const items = group.items.filter(item => !item.ability || abilities?.[item.ability]);
            if (!items.length) return null;
            return (
              <div className="app-nav-group" key={group.label}>
                <p className="app-nav-label">{group.label}</p>
                {items.map(item => {
                  const count = item.badge === 'unread' ? (unread.data?.count ?? 0) : 0;
                  return (
                    <Link key={item.to} to={item.to} className="app-nav-link" activeOptions={{exact: item.exact ?? false}}>
                      <Icon name={item.icon} size={18} />
                      {item.label}
                      {count > 0 && (
                        <span className="app-nav-badge">
                          {badgeCount(count)}
                          <span className="visually-hidden"> with a new reply</span>
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="app-sidebar-foot">
          <a className="app-nav-link" href="/">
            <Icon name="arrow-left" size={18} />
            Back to the website
          </a>
        </div>
      </aside>
      <button type="button" className="app-scrim" aria-label="Close the menu" tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="app-main">
        <header className="app-topbar">
          <IconButton
            className="app-menu-button"
            icon={open ? 'x' : 'menu'}
            label={open ? 'Close the menu' : 'Open the menu'}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          />
          <h1 className="app-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <div className="app-topbar-actions">
            <Menu
              label={`Theme: ${theme}`}
              trigger={<Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} size={18} />}
              items={[
                {label: 'Light', icon: 'sun', onSelect: () => setTheme('light')},
                {label: 'Dark', icon: 'moon', onSelect: () => setTheme('dark')},
                {label: 'Same as this device', icon: 'monitor', onSelect: () => setTheme('system')},
              ]}
            />
            {viewer && (
              <Menu
                label={`Account menu for ${viewer.name ?? 'you'}`}
                trigger={
                  <>
                    {signingOut ? <span className="spinner" aria-hidden="true" /> : <Avatar name={viewer.name ?? ''} size="sm" />}
                    <span className="app-viewer-name">{signingOut ? 'Signing out…' : viewer.name}</span>
                    <Icon name="chevron-down" size={16} />
                  </>
                }
                disabled={signingOut}
                items={[
                  {label: 'Your account', icon: 'user', onSelect: () => void navigate({to: '/account'})},
                  {label: 'Back to the website', icon: 'globe', onSelect: () => window.location.assign('/')},
                  'separator',
                  {
                    label: 'Sign out',
                    icon: 'log-out',
                    onSelect: () => {
                      setSigningOut(true);
                      // The public chat keeps this tab's conversation, a hand-off in progress and
                      // the last request's number; the next person on it mustn't see them.
                      let storage: Storage | null = null;
                      try {
                        storage = sessionStorage;
                      } catch {
                        // Storage blocked: nothing was kept.
                      }
                      clearHelpdeskStorage(storage);
                      void logout();
                    },
                  },
                ]}
              />
            )}
          </div>
        </header>
        <main className="app-content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// One `createRoute` per screen, with a LITERAL path (`<Link to>` is typed from
// them), a title, a loader over the screen's own queryOptions, a lazy screen.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  staticData: {title: 'Overview'},
  loader: async ({context: {queryClient}}) => {
    // The tiles the visitor may see, as the screen's `enabled` flags decide.
    const [me] = await Promise.all([queryClient.ensureQueryData(meQuery).catch(() => null), warm(queryClient.ensureQueryData(healthQuery), queryClient.ensureQueryData(twoFactorQuery), queryClient.ensureQueryData(siteQuery))]);
    const can = me?.abilities;
    await warm(
      // Agents see the help desk tiles; everyone else, their own open requests.
      can?.useInbox ? queryClient.ensureQueryData(helpdeskStatsQuery) : queryClient.ensureInfiniteQueryData(supportTicketsQuery),
      ...(can?.manageUsers ? [queryClient.ensureQueryData(firstUsersQuery)] : []),
      ...(can?.editKnowledge
        ? [queryClient.ensureQueryData(kbCategoriesQuery), queryClient.ensureInfiniteQueryData(kbArticlesQuery(KB_DRAFTS))]
        : []),
      ...(can?.readAudit ? [queryClient.ensureQueryData(firstAuditQuery)] : []),
      // The assistant tiles, this month's spend and the health issues.
      ...(can?.seeHelpdeskReports ? [queryClient.ensureQueryData(helpdeskOverviewQuery)] : [])
    );
  },
  component: lazyRouteComponent(() => import('./screens/overview'), 'Overview'),
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  staticData: {title: 'Your account'},
  // `?tab=security`: a link can open one section of the account screen.
  // Every key is returned (undefined when bad): the router merges the raw search over it.
  validateSearch: (search: Record<string, unknown>): {tab?: string} => ({tab: typeof search.tab === 'string' ? search.tab : undefined}),
  loader: ({context: {queryClient}}) =>
    warm(
      queryClient.ensureQueryData(meQuery),
      queryClient.ensureQueryData(twoFactorQuery),
      queryClient.ensureQueryData(sessionsQuery)
    ),
  component: lazyRouteComponent(() => import('./screens/account'), 'Account'),
});
// The knowledge base (holders of `site:kb:edit`; the routes' guards enforce it).
export type ArticlesSearch = {new?: boolean; edit?: number};

/**
 * `new` only as true; `edit` only as a positive whole number. Anything else is dropped: EVERY key
 * is returned, undefined when bad, because the router merges the raw search params over what a
 * parser leaves out (a bad value would otherwise reach the screen).
 */
export function parseArticlesSearch(search: Record<string, unknown>): ArticlesSearch {
  return {
    new: search.new === true || search.new === 'true' ? true : undefined,
    edit: positiveId(search.edit) ?? undefined,
  };
}

/** A database id from the URL (`12` or `"12"`), or null. */
function positiveId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const articlesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles',
  staticData: {title: 'Articles'},
  // `?new=true` (the overview's "Write an article"): open the editor on a blank article.
  // `?edit=12` (Knowledge health's "Open draft"): open that article's editor.
  validateSearch: parseArticlesSearch,
  loader: ({context: {queryClient}}) =>
    warm(queryClient.ensureInfiniteQueryData(kbArticlesQuery(KB_ALL_ARTICLES)), queryClient.ensureQueryData(kbCategoriesQuery)),
  component: lazyRouteComponent(() => import('./screens/articles'), 'Articles'),
});
const categoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories',
  staticData: {title: 'Categories'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(kbCategoriesQuery)),
  component: lazyRouteComponent(() => import('./screens/categories'), 'Categories'),
});
const snippetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/snippets',
  staticData: {title: 'Snippets'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(kbSnippetsQuery(''))),
  component: lazyRouteComponent(() => import('./screens/snippets'), 'Snippets'),
});
const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/import',
  staticData: {title: 'Import'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(kbCategoriesQuery)),
  component: lazyRouteComponent(() => import('./screens/import'), 'Import'),
});
// Knowledge files: upload a PDF, Word, text or Markdown file, read into draft articles.
const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
  staticData: {title: 'Knowledge files'},
  loader: async ({context: {queryClient}}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    // Not allowed: the screen shows the API's refusal; nothing to fetch.
    if (!me?.abilities.editKnowledge) return;
    await warm(
      queryClient.ensureInfiniteQueryData(kbFilesQuery),
      queryClient.ensureQueryData(kbFilesUsageQuery),
      queryClient.ensureQueryData(kbCategoriesQuery)
    );
  },
  component: lazyRouteComponent(() => import('./screens/files'), 'Files'),
});
// The help desk (holders of `site:helpdesk:settings`; the routes' guards enforce it).
const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assistant',
  staticData: {title: 'Assistant'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(helpdeskSettingsQuery)),
  component: lazyRouteComponent(() => import('./screens/assistant'), 'Assistant'),
});
// Help desk analytics (holders of `site:helpdesk:reports`; the routes' guards enforce it).
// Three tabs, each view in the URL (`/analytics?tab=tickets&weeks=13`,
// `/analytics?filter=no_source`); absent = the defaults (the Assistant tab, the last 4 weeks,
// every question, 4 weeks of tickets, this week's rankings). The loader warms the active tab only.
export type AnalyticsTab = 'assistant' | 'tickets' | 'knowledge';
export type AnalyticsSearch = {
  tab?: Exclude<AnalyticsTab, 'assistant'>;
  range?: ReportRange;
  filter?: QuestionFilter;
  weeks?: 13;
  week?: 'previous';
};
export const ANALYTICS_DEFAULTS = {tab: 'assistant', range: '4w', filter: 'all', weeks: 4, week: 'current'} as const;

/**
 * Anything invalid or default is dropped, so the plain address is the default view. Every key is
 * returned (undefined when dropped): the router merges the raw search over missing keys.
 */
export function parseAnalyticsSearch(search: Record<string, unknown>): AnalyticsSearch {
  return {
    tab: search.tab === 'tickets' || search.tab === 'knowledge' ? search.tab : undefined,
    range: isReportRange(search.range) && search.range !== ANALYTICS_DEFAULTS.range ? search.range : undefined,
    filter: isQuestionFilter(search.filter) && search.filter !== ANALYTICS_DEFAULTS.filter ? search.filter : undefined,
    weeks: search.weeks === 13 || search.weeks === '13' ? 13 : undefined,
    week: search.week === 'previous' ? 'previous' : undefined,
  };
}

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  staticData: {title: 'Analytics'},
  validateSearch: parseAnalyticsSearch,
  loaderDeps: ({search}) => ({
    tab: search.tab ?? ANALYTICS_DEFAULTS.tab,
    range: search.range ?? ANALYTICS_DEFAULTS.range,
    filter: search.filter ?? ANALYTICS_DEFAULTS.filter,
    weeks: search.weeks ?? ANALYTICS_DEFAULTS.weeks,
    week: search.week ?? ANALYTICS_DEFAULTS.week,
  }),
  loader: async ({context: {queryClient}, deps}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    // Not allowed: the screen shows the API's refusal; nothing to fetch.
    if (!me?.abilities.seeHelpdeskReports) return;
    if (deps.tab === 'tickets') return warm(queryClient.ensureQueryData(helpdeskWeeksQuery(deps.weeks)));
    if (deps.tab === 'knowledge') return warm(queryClient.ensureQueryData(helpdeskTopQuery(deps.week)));
    await warm(
      queryClient.ensureQueryData(helpdeskReportQuery(deps.range)),
      queryClient.ensureInfiniteQueryData(helpdeskQuestionsQuery(deps.filter))
    );
  },
  component: lazyRouteComponent(() => import('./screens/analytics'), 'Analytics'),
});
// Knowledge health (holders of `site:helpdesk:reports`; the routes' guards enforce it).
// The tab, the type filter and the open issue are in the URL
// (`/knowledge-health?state=dismissed&type=gap&issue=12`); absent = open issues of every type.
export type KnowledgeHealthSearch = {state?: Exclude<HealthState, 'open'>; type?: HealthType; issue?: number};

/**
 * Anything invalid or default is dropped, so the plain address is the default view. Every key is
 * returned (undefined when dropped): the router merges the raw search over missing keys, so
 * `?state=bogus` would otherwise reach the screen.
 */
export function parseKnowledgeHealthSearch(search: Record<string, unknown>): KnowledgeHealthSearch {
  return {
    state:
      HEALTH_STATES.includes(search.state as HealthState) && search.state !== 'open'
        ? (search.state as Exclude<HealthState, 'open'>)
        : undefined,
    type: HEALTH_TYPES.includes(search.type as HealthType) ? (search.type as HealthType) : undefined,
    issue: positiveId(search.issue) ?? undefined,
  };
}

const knowledgeHealthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/knowledge-health',
  staticData: {title: 'Knowledge health'},
  validateSearch: parseKnowledgeHealthSearch,
  loaderDeps: ({search}) => ({state: search.state ?? ('open' as const), type: search.type ?? ('all' as const), issue: search.issue}),
  loader: async ({context: {queryClient}, deps}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    // Not allowed: the screen shows the API's refusal; nothing to fetch.
    if (!me?.abilities.seeHelpdeskReports) return;
    // The picked issue loads in the background: opening one never waits on the router.
    if (deps.issue) void queryClient.prefetchQuery(healthIssueQuery(deps.issue));
    await warm(queryClient.ensureInfiniteQueryData(healthIssuesQuery(deps.state, deps.type)));
  },
  component: lazyRouteComponent(() => import('./screens/knowledge-health'), 'KnowledgeHealth'),
});
// Test Lab (holders of `site:helpdesk:settings`; the routes' guards enforce it).
const testLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/test-lab',
  staticData: {title: 'Test Lab'},
  loader: async ({context: {queryClient}}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (!me?.abilities.manageHelpdesk) return;
    await warm(
      queryClient.ensureInfiniteQueryData(testCasesQuery),
      queryClient.ensureQueryData(testRunQuery),
      queryClient.ensureQueryData(helpdeskSettingsQuery)
    );
  },
  component: lazyRouteComponent(() => import('./screens/test-lab'), 'TestLab'),
});
// The help desk inbox (holders of `site:helpdesk:inbox`; the routes' guards enforce it).
// Its state is in the URL, so a shared link opens exactly it: `/inbox?view=mine&ticket=1042`.
export type InboxSearch = {view?: Queue; priority?: TicketPriority; ticket?: number};

/**
 * Anything invalid is dropped (unknown view → absent = "Waiting on us"). Every key is returned
 * (undefined when dropped): the router merges the raw search over missing keys.
 */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  return {
    view: QUEUES.includes(search.view as Queue) ? (search.view as Queue) : undefined,
    priority: TICKET_PRIORITIES.includes(search.priority as TicketPriority) ? (search.priority as TicketPriority) : undefined,
    ticket: ticketNumberOf(search.ticket) ?? undefined,
  };
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  staticData: {title: 'Inbox', layout: 'full', layoutAbility: 'useInbox'},
  validateSearch: parseInboxSearch,
  loaderDeps: ({search}) => ({view: search.view, priority: search.priority, ticket: search.ticket}),
  loader: async ({context: {queryClient}, deps}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    // Not an agent: the screen says so; nothing to fetch (the API would answer 403).
    if (!me?.abilities.useInbox) return;
    // The picked ticket loads in the background: picking one never waits on the router.
    if (deps.ticket) void queryClient.prefetchQuery(inboxTicketQuery(deps.ticket));
    await warm(
      queryClient.ensureInfiniteQueryData(inboxTicketsQuery({view: deps.view, priority: deps.priority})),
      queryClient.ensureQueryData(inboxAgentsQuery)
    );
  },
  component: lazyRouteComponent(() => import('./screens/inbox'), 'Inbox'),
});
// The agents' saved replies (`site:helpdesk:inbox`): read and written by agents.
const savedRepliesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/saved-replies',
  staticData: {title: 'Saved replies'},
  loader: async ({context: {queryClient}}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me?.abilities.useInbox) await warm(queryClient.ensureInfiniteQueryData(savedRepliesQuery('')));
  },
  component: lazyRouteComponent(() => import('./screens/canned'), 'CannedReplies'),
});
// My support: every signed-in person's OWN requests (the server scopes every read to them).
const supportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/support',
  staticData: {title: 'My support'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(supportTicketsQuery)),
  component: lazyRouteComponent(() => import('./screens/support'), 'Support'),
});
const supportTicketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/support/$ticketId',
  staticData: {title: 'Your request'},
  loader: ({context: {queryClient}, params}) => {
    // A malformed number fetches nothing: the screen shows "We couldn't find this request".
    const number = ticketNumberOf(params.ticketId);
    return number === null ? undefined : warm(queryClient.ensureQueryData(supportTicketQuery(number)));
  },
  component: lazyRouteComponent(() => import('./screens/support'), 'SupportTicket'),
});
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  staticData: {title: 'Users'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(usersQuery({email: '', status: ''}))),
  component: lazyRouteComponent(() => import('./screens/users'), 'Users'),
});
const rolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/roles',
  staticData: {title: 'Roles'},
  loader: ({context: {queryClient}}) =>
    warm(queryClient.ensureQueryData(rolesQuery), queryClient.ensureQueryData(permissionsQuery)),
  component: lazyRouteComponent(() => import('./screens/roles'), 'Roles'),
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  staticData: {title: 'Activity'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(auditQuery)),
  component: lazyRouteComponent(() => import('./screens/activity'), 'Activity'),
});

// The UI kit on screen, for the owner and their agent. Dev only: the whole route (and its
// chunk) is left out of a build, because `import.meta.env.DEV` is `false` there.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/components',
        staticData: {title: 'Components'},
        component: lazyRouteComponent(() => import('./screens/components'), 'Components'),
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  accountRoute,
  articlesRoute,
  categoriesRoute,
  snippetsRoute,
  importRoute,
  filesRoute,
  assistantRoute,
  testLabRoute,
  analyticsRoute,
  knowledgeHealthRoute,
  inboxRoute,
  savedRepliesRoute,
  supportRoute,
  supportTicketRoute,
  usersRoute,
  rolesRoute,
  activityRoute,
  ...devRoutes,
]);
