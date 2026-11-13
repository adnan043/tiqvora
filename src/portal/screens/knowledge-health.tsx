import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import {type ReactNode, useEffect, useRef, useState} from 'react';

import {ARTICLE_STATUS_LABELS} from '../../lib/helpdesk-tones';
import {KB_LIMITS} from '../../lib/kb-types';
import type {
  AcceptInput,
  AcceptResult,
  HealthEvidence,
  HealthIssueDetail,
  HealthIssueRow,
  HealthState,
  HealthType,
} from '../../lib/knowledge-health-types';
import {api, ApiError, read} from '../api';
import {healthIssueQuery, healthIssuesQuery, type HealthTypeFilter, helpdeskSettingsQuery, kbCategoriesQuery, restartDraftPoll} from '../queries';
import {ago, useMe, when} from '../shared';
import {
  ArticleEditor,
  Badge,
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  LoadMore,
  Menu,
  Notice,
  PageHeader,
  rules,
  SegmentedControl,
  Select,
  Stat,
  Tabs,
  type Tone,
  useConfirm,
  useForm,
  useToast,
} from '../ui';
import {ArticlePreview} from './articles';

/**
 * Holders of `site:helpdesk:reports`: what the weekly check and solved tickets found
 * (`/site-api/helpdesk/health`). Accept saves the suggested text as a DRAFT article (it needs
 * `site:kb:edit` too); nothing here ever publishes. Tab, type filter and the open issue are
 * in the URL (routes.tsx `parseKnowledgeHealthSearch`).
 */

const TYPES: Record<HealthType, {label: string; plural: string; tone: Tone; icon: 'search' | 'clock' | 'alert' | 'trending-down'}> = {
  gap: {label: 'Gap', plural: 'Gaps', tone: 'info', icon: 'search'},
  stale: {label: 'Stale', plural: 'Stale', tone: 'warning', icon: 'clock'},
  conflict: {label: 'Conflict', plural: 'Conflicts', tone: 'danger', icon: 'alert'},
  low_rated: {label: 'Low rated', plural: 'Low rated', tone: 'warning', icon: 'trending-down'},
};
const TYPE_ORDER: HealthType[] = ['gap', 'stale', 'conflict', 'low_rated'];

const TYPE_FILTERS: {value: HealthTypeFilter; label: string}[] = [
  {value: 'all', label: 'All'},
  ...TYPE_ORDER.map(type => ({value: type, label: TYPES[type].plural})),
];

const STATE_TABS: {value: HealthState; label: string}[] = [
  {value: 'open', label: 'Open'},
  {value: 'accepted', label: 'Accepted'},
  {value: 'dismissed', label: 'Dismissed'},
];

/** The same words as Assistant and Test Lab: the key is an owner secret, the cap is in Assistant. */
const AI_OFF_MESSAGE = 'Add the ANTHROPIC_API_KEY secret in your site settings and set a monthly cap above $0 in Assistant.';
/** Accept's slug comes from the title (there is no slug field here), so its error lands on the title. */
const SLUG_TAKEN_MESSAGE = 'Another article already uses the web address made from this title. Change the title.';

const DRAFT_ERRORS: Record<'off' | 'cap' | 'failed', string> = {
  off: AI_OFF_MESSAGE,
  cap: 'This month’s AI budget is used up.',
  failed: 'The assistant couldn’t write a draft. Try again.',
};
/** "Write a draft" is allowed three times per issue (the server's `draft_attempts < 3`). */
const DRAFT_ATTEMPTS = 3;

const number = new Intl.NumberFormat('en-GB');
const shortDay = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'});
const longDay = new Intl.DateTimeFormat('en-GB', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
/** A `YYYY-MM-DD` or ISO date, as "9 Nov" (the date as written, never shifted by the browser's zone). */
const dayOf = (value: string | undefined) => {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : shortDay.format(date);
};
const plural = (n: number, one: string, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;
const zoneLabel = (zone: string) => zone.replaceAll('_', ' ');

/**
 * Focus goes back to what opened a drawer once it closes: the drawer unmounts (so the native
 * dialog can't return it). Call the returned function just before opening.
 */
function useReturnFocus(open: boolean) {
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open || !trigger.current) return;
    const element = trigger.current;
    trigger.current = null;
    if (element.isConnected) element.focus();
  }, [open]);
  return () => {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
}
/**
 * After a dismissed row leaves the list, focus would fall to the page: put it on the page heading
 * instead (only when nothing else holds it).
 */
function focusHeadingIfLost() {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const heading = document.querySelector<HTMLElement>('h1.app-title');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus();
  });
}
/** 99+ past 99 (the server caps the counts at 100). */
const countText = (n: number) => (n > 99 ? '99+' : number.format(n));

/** The share of "not helpful" votes, 0–100, or null with no votes. */
function notHelpfulPct(e: HealthEvidence): number | null {
  const votes = (e.helpful ?? 0) + (e.notHelpful ?? 0);
  if (votes > 0) return Math.round(((e.notHelpful ?? 0) / votes) * 100);
  if (typeof e.rate === 'number') return Math.round(e.rate <= 1 ? e.rate * 100 : e.rate);
  return null;
}

/** One line on why an issue is listed: the table's "Why" column. */
function whyText(issue: HealthIssueRow): string {
  const e = issue.evidence ?? {};
  const ticket = issue.ticketNumber ?? e.ticketNumber;
  if (e.source === 'ticket' && ticket) return `From ticket #${ticket}`;
  if (issue.type === 'stale' && typeof e.daysSinceReview === 'number') return `Not reviewed for ${plural(e.daysSinceReview, 'day')}`;
  if (issue.type === 'low_rated') {
    const pct = notHelpfulPct(e);
    const votes = (e.helpful ?? 0) + (e.notHelpful ?? 0);
    if (pct !== null) return `${pct}% not helpful${votes ? ` (${plural(votes, 'vote')}, all time)` : ''}`;
  }
  if (typeof e.questions === 'number') {
    const parts = [`${plural(e.questions, 'question')} this week`];
    if (e.noSource) parts.push(`${number.format(e.noSource)} with no answer`);
    else if (e.lowConfidence) parts.push(`${number.format(e.lowConfidence)} answered with low confidence`);
    return parts.join(', ');
  }
  if (ticket) return `From ticket #${ticket}`;
  return '—';
}

/** The article an issue is about, in words. */
function articleText(issue: HealthIssueRow): ReactNode {
  if (issue.article) {
    return (
      <div>
        <span>{issue.article.title}</span>
        <span className="cell-sub">{ARTICLE_STATUS_LABELS[issue.article.status]}</span>
      </div>
    );
  }
  // Stale and low-rated issues are always about an article: none left means it was deleted.
  return <span className="muted">{issue.type === 'stale' || issue.type === 'low_rated' ? 'Article deleted' : 'New article'}</span>;
}

/** The weekly check's line under the header. */
function LastRun({lastRun, zone, canManage}: {lastRun: {week: string; timeZone: string; state: string} | null | undefined; zone: string | null; canManage: boolean}) {
  if (lastRun === undefined) return null;
  if (!lastRun) {
    return (
      <p className="muted health-last-run">
        The first check runs Monday at 07:30{zone ? ` (${zoneLabel(zone)})` : ''}.{' '}
        {canManage && (
          <>
            Change the time zone in <Link to="/assistant">Assistant</Link>.
          </>
        )}
      </p>
    );
  }
  if (lastRun.state === 'running') return <p className="muted health-last-run">Checking now…</p>;
  if (lastRun.state === 'failed') {
    return (
      <Notice tone="warning" title="Last week’s check didn’t finish">
        It runs again next Monday.
      </Notice>
    );
  }
  const day = new Date(`${lastRun.week}T00:00:00Z`);
  return (
    <p className="muted health-last-run">
      Checked {Number.isNaN(day.getTime()) ? 'Monday' : longDay.format(day)} at 07:30 ({zoneLabel(lastRun.timeZone)}).
    </p>
  );
}

export function KnowledgeHealth() {
  const search = useSearch({from: '/knowledge-health'});
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const me = useMe();
  const can = me.data?.abilities;

  // The route's parser drops bad values; never trust them here either (a bad tab would crash the caption).
  const state: HealthState = STATE_TABS.some(tab => tab.value === search.state) ? (search.state as HealthState) : 'open';
  const type: HealthTypeFilter = search.type && search.type in TYPES ? search.type : 'all';
  const rememberTrigger = useReturnFocus(Boolean(search.issue));
  const openIssue = (id: number) => {
    rememberTrigger();
    go({issue: id});
  };
  const go = (next: {state?: HealthState; type?: HealthTypeFilter; issue?: number | undefined}) =>
    void navigate({
      to: '/knowledge-health',
      search: prev => {
        const merged = {...prev, ...next};
        return {
          state: merged.state === 'open' ? undefined : merged.state,
          type: merged.type === 'all' ? undefined : merged.type,
          issue: merged.issue,
        };
      },
      replace: true,
    });

  const issues = useInfiniteQuery(healthIssuesQuery(state, type));
  // Only to name the time zone before the first run (Assistant's holders can read it).
  const settings = useQuery({...helpdeskSettingsQuery, enabled: Boolean(can?.manageHelpdesk)});
  const first = issues.data?.pages[0];
  const rows = issues.data?.pages.flatMap(page => page.items);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['helpdesk', 'health']});

  // The draft saved by the last Accept: a link to it stays on the page until closed.
  const [saved, setSaved] = useState<AcceptResult['article'] | null>(null);

  const dismiss = useMutation({
    mutationFn: (id: number) => read(api.helpdesk.health[':id'].dismiss.$post({param: {id: String(id)}})),
    onSettled: refresh,
  });
  const askDismiss = (issue: HealthIssueRow) =>
    void confirm({
      title: 'Dismiss this issue?',
      body: 'It won’t be flagged again for 90 days.',
      confirmLabel: 'Dismiss issue',
      pendingLabel: 'Dismissing…',
      tone: 'primary',
      action: () =>
        dismiss.mutateAsync(issue.id).then(
          () => {
            toast.success('Issue dismissed.');
            void refresh().then(focusHeadingIfLost);
          },
          err => {
            // Accepted or dismissed by someone else meanwhile: nothing to retry.
            if (err instanceof ApiError && err.status === 409) return toast.danger('Someone else already handled this issue.');
            throw err;
          }
        ),
    });

  const busyKey = dismiss.isPending ? (dismiss.variables ?? null) : null;

  const columns: Column<HealthIssueRow>[] = [
    {
      key: 'issue',
      header: 'Issue',
      cell: issue => (
        <div className="health-issue">
          <Button variant="link" className="health-issue-title" onClick={() => openIssue(issue.id)}>
            {issue.title}
          </Button>
          <span className="health-issue-badges">
            <Badge tone={TYPES[issue.type].tone}>{TYPES[issue.type].label}</Badge>
            {issue.state === 'open' && issue.draftState === 'ready' && <Badge tone="success">Draft ready</Badge>}
            {issue.state === 'open' && issue.draftState === 'pending' && <Badge tone="neutral">Writing a draft…</Badge>}
          </span>
        </div>
      ),
    },
    {key: 'why', header: 'Why', hideOnMobile: true, cell: issue => whyText(issue)},
    {key: 'article', header: 'Article', hideOnMobile: true, cell: articleText},
    {
      key: 'found',
      header: state === 'open' ? 'Found' : state === 'accepted' ? 'Accepted' : 'Dismissed',
      width: 'shrink',
      cell: issue => {
        const at = state === 'open' ? issue.createdAt : (issue.resolvedAt ?? issue.createdAt);
        return (
          <time className="muted" dateTime={at} title={when(at)}>
            {ago(at)}
          </time>
        );
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: issue => (
        <Menu
          label={`Actions for “${issue.title}”`}
          disabled={busyKey !== null}
          items={[
            {label: 'Review', icon: 'eye', onSelect: () => openIssue(issue.id)},
            ...(issue.state === 'open' ? [{label: 'Dismiss', icon: 'x' as const, onSelect: () => askDismiss(issue)}] : []),
          ]}
        />
      ),
    },
  ];

  const counts = first?.openCounts;
  // The weekly check's zone: the last run's, else the setting (only Assistant's holders can read it).
  const zone = first?.lastRun?.timeZone ?? settings.data?.timeZone ?? null;
  const countsTile = (t: HealthType) => (counts ? countText(counts[t] ?? 0) : issues.error ? '—' : null);

  return (
    <div className="app-page screen-knowledge-health">
      <PageHeader
        title="Knowledge health"
        description="Questions the assistant couldn't answer, articles that need a look, and drafts written from solved tickets. Nothing is published until you publish it in Articles."
      />
      <LastRun lastRun={first?.lastRun} zone={zone} canManage={Boolean(can?.manageHelpdesk)} />

      {saved && (
        <Notice
          tone="success"
          title={saved.mode === 'updated' ? `Draft “${saved.title}” updated in Articles` : `Draft “${saved.title}” saved in Articles`}
          action={
            <>
              {can?.editKnowledge && (
                <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to="/articles" search={{edit: saved.id}}>
                  Open draft
                </Link>
              )}
              <Button variant="ghost" size="sm" onClick={() => setSaved(null)}>
                Close
              </Button>
            </>
          }>
          It stays a draft until someone publishes it.
        </Notice>
      )}

      <div className="stat-grid">
        {TYPE_ORDER.map(t => (
          <Stat
            key={t}
            label={`${TYPES[t].plural} open`}
            icon={TYPES[t].icon}
            value={countsTile(t)}
            to="/knowledge-health"
            search={{type: t}}
            hint={type === t && state === 'open' ? 'Showing these' : 'Show these'}
          />
        ))}
      </div>

      <Tabs label="Issues" items={STATE_TABS} value={state} onChange={next => go({state: next})}>
        <div className="toolbar">
          <SegmentedControl label="Type" value={type} onChange={next => go({type: next})} options={TYPE_FILTERS} />
        </div>

        <Card flush>
          <DataTable
            caption={`${(STATE_TABS.find(tab => tab.value === state) ?? STATE_TABS[0]!).label} issues`}
            columns={columns}
            rows={rows}
            rowKey={issue => issue.id}
            loading={issues.isPending}
            error={issues.error}
            busyKey={busyKey}
            empty={
              state === 'open' && type === 'all' ? (
                <EmptyState icon="check-circle" title="Nothing needs a look">
                  The weekly check runs Mondays at 07:30{zone ? ` (${zoneLabel(zone)})` : ''}. Drafts from solved tickets show up here too.
                </EmptyState>
              ) : (
                <EmptyState
                  icon="inbox"
                  title="Nothing here yet"
                  action={
                    type !== 'all' ? (
                      <Button variant="secondary" onClick={() => go({type: 'all'})}>
                        Show every type
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          />
        </Card>
        {issues.error && rows?.length ? <ErrorNote error={issues.error} /> : null}
        <LoadMore query={issues} />
      </Tabs>

      {search.issue && (
        <IssueDrawer
          key={search.issue}
          id={search.issue}
          row={rows?.find(row => row.id === search.issue)}
          canEditKb={Boolean(can?.editKnowledge)}
          canSeeInbox={Boolean(can?.useInbox)}
          onClose={() => go({issue: undefined})}
          onAccepted={result => {
            setSaved(result.article);
            go({issue: undefined});
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ drawer --

const EMPTY_DRAFT = {title: '', categoryId: '', body: ''};
type DraftForm = typeof EMPTY_DRAFT;

const BODY_BYTES = new TextEncoder();
/**
 * The SAME limits Accept enforces (`readArticle`, src/server/kb/articles.ts). The category is
 * optional when the issue has an article (the server keeps that article's), required otherwise.
 */
const draftRules = (needsCategory: boolean) => ({
  title: [rules.required('Enter a title.'), rules.maxLength(KB_LIMITS.articleTitle)],
  categoryId: needsCategory ? [rules.required('Pick a category.')] : [],
  body: [
    rules.required('Write the article.'),
    (value: string) =>
      value.length > KB_LIMITS.articleBody ? `Write the article: 1 to ${KB_LIMITS.articleBody.toLocaleString('en-US')} characters.` : null,
    (value: string) =>
      BODY_BYTES.encode(value).length > KB_LIMITS.articleBodyBytes ? 'This article is too long. Split it into two articles.' : null,
  ],
});

/** "Why it's here", from the evidence (every field optional). */
function evidenceItems(issue: HealthIssueDetail, canSeeInbox: boolean): {label: ReactNode; value: ReactNode}[] {
  const e = issue.evidence ?? {};
  const items: {label: ReactNode; value: ReactNode}[] = [];
  const ticket = issue.ticketNumber ?? e.ticketNumber;
  items.push({label: 'Found by', value: e.source === 'ticket' || ticket ? 'A solved ticket' : 'The weekly check'});
  if (ticket) {
    items.push({
      label: 'Ticket',
      value: canSeeInbox ? (
        <Link to="/inbox" search={{ticket}}>
          #{ticket}
        </Link>
      ) : (
        `#${ticket}`
      ),
    });
  }
  if (e.summary) items.push({label: 'What happened', value: e.summary});
  const from = dayOf(e.from);
  const to = dayOf(e.to);
  if (from && to) items.push({label: 'Period', value: `${from} to ${to}`});
  if (typeof e.questions === 'number') items.push({label: 'Questions asked', value: number.format(e.questions)});
  if (typeof e.noSource === 'number') items.push({label: 'With no answer', value: number.format(e.noSource)});
  if (typeof e.lowConfidence === 'number') items.push({label: 'Answered with low confidence', value: number.format(e.lowConfidence)});
  if (e.lastReviewedAt) items.push({label: 'Last reviewed', value: when(e.lastReviewedAt)});
  if (typeof e.daysSinceReview === 'number') items.push({label: 'Not reviewed for', value: plural(e.daysSinceReview, 'day')});
  if (typeof e.views === 'number') items.push({label: 'Views', value: number.format(e.views)});
  if (typeof e.helpful === 'number' || typeof e.notHelpful === 'number') {
    const pct = notHelpfulPct(e);
    items.push({
      label: 'Votes (all time)',
      value: `${number.format(e.helpful ?? 0)} helpful · ${number.format(e.notHelpful ?? 0)} not helpful${pct !== null ? ` (${pct}% not helpful)` : ''}`,
    });
  }
  if (issue.article) {
    items.push({label: 'Article', value: `${issue.article.title} (${ARTICLE_STATUS_LABELS[issue.article.status]})`});
  } else {
    items.push({label: 'Article', value: issue.type === 'stale' || issue.type === 'low_rated' ? 'Article deleted' : 'A new article'});
  }
  if (e.noDraftReason) items.push({label: 'No draft because', value: e.noDraftReason});
  return items;
}

function IssueDrawer({
  id,
  row,
  canEditKb,
  canSeeInbox,
  onClose,
  onAccepted,
}: {
  id: number;
  row: HealthIssueRow | undefined;
  canEditKb: boolean;
  canSeeInbox: boolean;
  onClose: () => void;
  onAccepted: (result: AcceptResult) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // Each opening polls a pending draft afresh (before the query's first refetch interval is read).
  useState(() => restartDraftPoll(id));
  const detail = useQuery(healthIssueQuery(id));
  const issue = detail.data?.issue;
  const categories = useQuery({...kbCategoriesQuery, enabled: canEditKb});
  const form = useForm(EMPTY_DRAFT, draftRules(!issue?.article));
  const refresh = () => queryClient.invalidateQueries({queryKey: ['helpdesk', 'health']});

  // Fill the form ONCE per ready draft (a refetch never overwrites what the reviewer typed).
  const filled = useRef<string | null>(null);
  useEffect(() => {
    if (!issue || issue.draftState !== 'ready') return;
    const mark = `${issue.id}:${issue.draftAttempts}`;
    if (filled.current === mark) return;
    filled.current = mark;
    form.reset({title: issue.title, categoryId: issue.article ? String(issue.article.categoryId) : '', body: issue.suggestedBody});
    // Only when a new draft arrives; `form` is new on every render.
  }, [issue?.id, issue?.draftState, issue?.draftAttempts]);

  // The list shows "Draft ready": refresh it when the draft's state changes here.
  const lastDraftState = useRef(issue?.draftState);
  useEffect(() => {
    if (!issue) return;
    if (lastDraftState.current && lastDraftState.current !== issue.draftState) void queryClient.invalidateQueries({queryKey: ['helpdesk', 'health', 'issues']});
    lastDraftState.current = issue.draftState;
  }, [issue?.draftState]);

  /** Deleted meanwhile (or never there): say so, refresh, close. */
  const gone = () => {
    toast.danger('This issue no longer exists.');
    void refresh();
    onClose();
  };

  /** Someone else accepted or dismissed it meanwhile: say so, refresh, close. */
  const handled = () => {
    toast.danger('Someone else already handled this issue.');
    void refresh();
    onClose();
  };

  const accept = useMutation({
    mutationFn: (values: DraftForm) => {
      // Excerpt and web address are left to the server (from the body and the title).
      const json = {
        title: values.title.trim(),
        body: values.body,
        // Empty: the server keeps the article's own category (it refuses none for a new article).
        categoryId: values.categoryId ? Number(values.categoryId) : undefined,
        excerpt: undefined,
        slug: undefined,
      } satisfies AcceptInput;
      return read<AcceptResult>(api.helpdesk.health[':id'].accept.$post({param: {id: String(id)}, json}));
    },
    onSuccess: result => {
      toast.success('Draft saved in Articles.');
      void refresh();
      // Articles lists the new draft.
      void queryClient.invalidateQueries({queryKey: ['kb']});
      onAccepted(result);
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      // Field errors first (422). The slug is made from the title: its error goes on the title.
      if (Object.keys(err.fields).length) {
        const {slug, ...fields} = err.fields;
        form.setServerErrors(slug ? {...fields, title: fields.title ?? SLUG_TAKEN_MESSAGE} : fields);
      } else if (err.status === 409) handled();
      else if (err.status === 404) gone();
    },
  });
  const writeDraft = useMutation({
    mutationFn: () => read<{draftState: 'pending'}>(api.helpdesk.health[':id'].draft.$post({param: {id: String(id)}})),
    onSuccess: () => {
      restartDraftPoll(id);
      queryClient.setQueryData(healthIssueQuery(id).queryKey, current =>
        current ? {issue: {...current.issue, draftState: 'pending' as const, draftError: null}} : current
      );
      void queryClient.invalidateQueries({queryKey: ['helpdesk', 'health', 'issues']});
    },
    onError: err => {
      if (err instanceof ApiError && err.status === 404) gone();
    },
  });
  const writeDraftError =
    writeDraft.error instanceof ApiError && writeDraft.error.code === 'ai_off'
      ? AI_OFF_MESSAGE
      : writeDraft.error && !(writeDraft.error instanceof ApiError && writeDraft.error.status === 404)
        ? writeDraft.error.message
        : null;
  const dismiss = useMutation({
    mutationFn: () => read(api.helpdesk.health[':id'].dismiss.$post({param: {id: String(id)}})),
    onSuccess: () => {
      toast.success('Issue dismissed.');
      void refresh().then(focusHeadingIfLost);
      onClose();
    },
  });
  const askDismiss = () =>
    void confirm({
      title: 'Dismiss this issue?',
      body: 'It won’t be flagged again for 90 days.',
      confirmLabel: 'Dismiss issue',
      pendingLabel: 'Dismissing…',
      tone: 'primary',
      action: () =>
        dismiss.mutateAsync().catch(err => {
          // Already handled by someone else: not an error to retry; close and say so.
          if (err instanceof ApiError && err.status === 409) return handled();
          throw err;
        }),
    });

  const busy = accept.isPending || dismiss.isPending;
  const open = issue ? issue.state === 'open' : row?.state === 'open';
  const ready = issue?.state === 'open' && issue.draftState === 'ready';
  const acceptFailed =
    accept.error &&
    !(accept.error instanceof ApiError && (accept.error.status === 409 || accept.error.status === 404 || Object.keys(accept.error.fields).length));
  const categoryList = categories.data?.categories;
  const categoryOptions = [
    {
      value: '',
      label: issue?.article ? 'Keep the article’s category' : categoryList?.length ? 'Pick a category' : 'No categories yet',
    },
    ...(categoryList ?? []).map(category => ({value: String(category.id), label: category.name})),
  ];
  const missing = issue?.evidence?.missingFacts?.filter(Boolean) ?? [];
  const samples = (issue?.evidence?.samples ?? (issue?.evidence?.question ? [issue.evidence.question] : [])).slice(0, 5);

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!busy}
      title={issue?.title ?? row?.title ?? 'Issue'}
      description={issue ? `${TYPES[issue.type].label} · found ${ago(issue.createdAt)}` : undefined}
      onSubmit={ready ? form.submit(values => accept.mutate(values)) : undefined}
      footer={
        open ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {ready ? 'Cancel' : 'Close'}
            </Button>
            <Button variant="secondary" onClick={askDismiss} disabled={busy || !issue}>
              Dismiss
            </Button>
            <Button
              type={ready ? 'submit' : 'button'}
              pending={accept.isPending}
              pendingLabel="Saving draft…"
              disabled={!ready || !canEditKb || dismiss.isPending}>
              Accept
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }>
      {detail.isPending ? (
        <LoadingBlock rows={5} />
      ) : !issue ? (
        <ErrorNote error={detail.error ?? new Error('This issue could not load.')} title="This issue could not load" />
      ) : (
        <div className="form-stack">
          {issue.state === 'accepted' && (
            <Notice
              tone="success"
              title="Accepted"
              action={
                issue.acceptedArticleId && canEditKb ? (
                  <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to="/articles" search={{edit: issue.acceptedArticleId}}>
                    Open draft
                  </Link>
                ) : undefined
              }>
              Saved as a draft in Articles {ago(issue.resolvedAt)}.
            </Notice>
          )}
          {issue.state === 'dismissed' && (
            <Notice tone="info" title="Dismissed">
              Dismissed {ago(issue.resolvedAt)}. It isn’t flagged again for 90 days.
            </Notice>
          )}

          <section className="health-section">
            <h3>Why it’s here</h3>
            <DefinitionList items={evidenceItems(issue, canSeeInbox)} />
          </section>

          {samples.length > 0 && (
            <section className="health-section">
              <h3>Sample questions</h3>
              <ul className="list health-samples">
                {samples.map((sample, index) => (
                  <li key={index} className="list-row">
                    <span className="list-row-text">{sample}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {issue.state === 'open' && (
            <section className="health-section">
              <h3>Suggested draft</h3>
              {issue.draftState === 'ready' ? (
                <div className="form-stack">
                  {missing.length > 0 && (
                    <Notice tone="warning" title="Fill these in before you publish">
                      <ul className="health-missing">
                        {missing.map((fact, index) => (
                          <li key={index}>{fact}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  <Field id="f-title" label="Title" hint="The question or task, in the customer's words." error={form.error('title')}>
                    <input {...form.field('title')} maxLength={KB_LIMITS.articleTitle} autoComplete="off" disabled={!canEditKb} />
                  </Field>
                  <Field
                    id="f-categoryId"
                    label="Category"
                    hint={issue.article ? 'The article’s own category, unless you pick another.' : undefined}
                    error={form.error('categoryId')}>
                    <Select {...form.field('categoryId')} options={categoryOptions} disabled={!canEditKb || !categoryList?.length} />
                  </Field>
                  {categories.error && <ErrorNote error={categories.error} title="The categories could not load" />}
                  <ArticleEditor
                    label="Article"
                    hint="Markdown. Check every fact against what your team really does."
                    {...form.field('body')}
                    error={form.error('body')}
                    maxLength={KB_LIMITS.articleBody}
                    disabled={!canEditKb}
                    renderPreview={markdown => <ArticlePreview markdown={markdown} />}
                  />
                  {issue.article?.status === 'published' && (
                    <Notice tone="info">
                      Accept saves this as a new draft. The published article stays as it is until you publish.
                    </Notice>
                  )}
                  {issue.article?.status === 'draft' && (
                    <Notice tone="info">Accept replaces the text of the draft “{issue.article.title}”, unless someone has edited it since this issue was raised. Then it makes a new draft.</Notice>
                  )}
                  {!canEditKb && (
                    <p className="field-hint">You need permission to edit the knowledge base to accept a draft.</p>
                  )}
                  {acceptFailed && <ErrorNote error={accept.error!} />}
                </div>
              ) : issue.draftState === 'pending' ? (
                <div className="form-stack">
                  <LoadingBlock rows={3} />
                  <p className="muted">Writing a draft. This takes up to a minute.</p>
                </div>
              ) : (
                <EmptyState
                  icon="file"
                  title="No draft yet"
                  action={
                    <Button
                      variant="secondary"
                      icon="zap"
                      pending={writeDraft.isPending}
                      pendingLabel="Starting…"
                      disabled={busy || issue.draftAttempts >= DRAFT_ATTEMPTS}
                      onClick={() => writeDraft.mutate()}>
                      Write a draft
                    </Button>
                  }>
                  {writeDraftError
                    ? writeDraftError
                    : issue.draftAttempts >= DRAFT_ATTEMPTS
                      ? 'Tried three times. Write this one in Articles.'
                      : issue.draftState === 'failed'
                        ? DRAFT_ERRORS[issue.draftError ?? 'failed']
                        : 'The assistant can write a first draft from the evidence above. You review it before anything is saved.'}
                </EmptyState>
              )}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
