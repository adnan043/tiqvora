import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import {useState} from 'react';

// Types only: a value import would pull the router module into this lazy screen's graph.
import type {AnalyticsTab, ANALYTICS_DEFAULTS as Defaults} from '../routes';

import {
  type QuestionFilter,
  type QuestionOutcome,
  type QuestionRow,
  REPORT_RANGES,
  type ReportBucket,
  type ReportRange,
  type ReportTotals,
} from '../../lib/helpdesk-report-types';
import {helpdeskQuestionsQuery, helpdeskReportQuery} from '../queries';
import {ago, useMe, when} from '../shared';
import {
  BarChart,
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
  DefinitionList,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  LoadMore,
  PageHeader,
  ProgressBar,
  SegmentedControl,
  Select,
  Stat,
  StatusBadge,
  Tabs,
  type Tone,
} from '../ui';
import {KnowledgeTab} from './analytics/knowledge';
import {TicketsTab} from './analytics/tickets';

const OUTCOMES: Record<QuestionOutcome, {label: string; tone: Tone}> = {
  answered: {label: 'Answered', tone: 'success'},
  handed_off: {label: 'Handed to a person', tone: 'warning'},
  no_source: {label: 'No article found', tone: 'danger'},
  ai_off: {label: 'Assistant off', tone: 'neutral'},
};

const FILTER_OPTIONS: {value: QuestionFilter; label: string}[] = [
  {value: 'all', label: 'All questions'},
  {value: 'answered', label: 'Answered'},
  {value: 'handed_off', label: 'Handed to a person'},
  {value: 'no_source', label: 'No article found'},
  {value: 'ai_off', label: 'Assistant off'},
  {value: 'unhelpful', label: 'Marked not helpful'},
];

const RANGE_OPTIONS = (Object.keys(REPORT_RANGES) as ReportRange[]).map(value => ({value, label: REPORT_RANGES[value].label}));

const number = new Intl.NumberFormat('en-GB');
const money = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
const weekday = new Intl.DateTimeFormat('en-GB', {weekday: 'short', timeZone: 'UTC'});
const dayMonth = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'});
const longDay = new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeZone: 'UTC'});

/** `part / whole` as a whole percentage, or null when there is nothing to divide. */
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const pct = (value: number | null) => (value === null ? '—' : `${value}%`);

/** A change against the period before, in percentage points (rates) or percent (counts). */
function trendOf(now: number | null, before: number | null, kind: 'count' | 'rate', goodWhenUp = true) {
  if (now === null || before === null) return undefined;
  if (kind === 'count' && before === 0) return undefined;
  const delta = kind === 'rate' ? now - before : Math.round(((now - before) / before) * 100);
  if (delta === 0) return undefined;
  const direction = delta > 0 ? ('up' as const) : ('down' as const);
  const label = `${delta > 0 ? '+' : ''}${delta}${kind === 'rate' ? ' pts' : '%'}`;
  return {label, direction, good: direction === 'up' ? goodWhenUp : !goodWhenUp};
}

const helpfulRate = (t: ReportTotals) => share(t.helpfulUp, t.helpfulUp + t.helpfulDown);

/** Questions longer than this get a "Show all" (the cell shows two lines). */
const QUESTION_CLAMP_FROM = 120;

/** A customer's question: two lines at most, the whole of it in the tooltip and behind "Show all". */
function QuestionText({text}: {text: string}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > QUESTION_CLAMP_FROM;
  return (
    <>
      <span className="cell-title analytics-question-text" title={long && !expanded ? text : undefined} data-expanded={expanded ? '' : undefined}>
        {text}
      </span>
      {long && (
        <Button variant="link" size="sm" className="analytics-question-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </>
  );
}

function bucketLabel(bucket: ReportBucket, range: ReportRange) {
  const day = new Date(`${bucket.start}T00:00:00Z`);
  return REPORT_RANGES[range].bucketDays === 1 ? weekday.format(day) : dayMonth.format(day);
}

/** routes.tsx `ANALYTICS_DEFAULTS` (what an absent search key means), checked against it by type. */
const DEFAULTS = {tab: 'assistant', range: '4w', filter: 'all', weeks: 4, week: 'current'} as const satisfies typeof Defaults;

const TABS: {value: AnalyticsTab; label: string; description: string}[] = [
  {
    value: 'assistant',
    label: 'Assistant',
    description: "How many questions the assistant answered on its own, and which ones it couldn't. Days are counted in UTC.",
  },
  {
    value: 'tickets',
    label: 'Tickets',
    description: 'Tickets created and solved, how fast the team first replied, and how customers rated it. Weeks start Monday (UTC).',
  },
  {
    value: 'knowledge',
    label: 'Knowledge',
    description: 'Questions your articles missed, the articles the assistant used most and the ones rated lowest. Weeks start Monday (UTC).',
  },
];

/**
 * Holders of `site:helpdesk:reports`: three tabs, each view in the URL (routes.tsx
 * `parseAnalyticsSearch`: `?tab=tickets&weeks=13`, `?filter=no_source`), so a link (the
 * Overview's "Needs attention") opens exactly it.
 * - Assistant: `question_stats_daily` totals (kept on write) and the question log.
 * - Tickets: the nightly weekly rows (`/reports/weeks`).
 * - Knowledge: the nightly rankings (`/reports/top`).
 */
export function Analytics() {
  const search = useSearch({from: '/analytics'});
  const navigate = useNavigate({from: '/analytics'});
  const tab: AnalyticsTab = search.tab ?? DEFAULTS.tab;
  const setTab = (next: AnalyticsTab) =>
    void navigate({to: '/analytics', search: prev => ({...prev, tab: next === 'assistant' ? undefined : next}), replace: true});
  const current = TABS.find(item => item.value === tab) ?? TABS[0]!;
  // Not a report holder (a customer, a knowledge editor): ONE refusal, not one per section.
  const me = useMe();
  if (me.data && !me.data.abilities.seeHelpdeskReports) {
    return (
      <div className="app-page screen-analytics">
        <PageHeader title="Analytics" />
        <EmptyState
          icon="lock"
          title="Analytics is for your support team"
          action={
            <Link className={buttonClass({variant: 'secondary'})} to="/">
              Back to the overview
            </Link>
          }>
          Your account can't see the help desk's reports. Ask an admin if you need them.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="app-page screen-analytics">
      <PageHeader title="Analytics" description={current.description} />
      <Tabs label="Report" items={TABS} value={tab} onChange={setTab}>
        {tab === 'tickets' ? (
          <TicketsTab
            weeks={search.weeks ?? DEFAULTS.weeks}
            onWeeks={next =>
              void navigate({to: '/analytics', search: prev => ({...prev, weeks: next === 13 ? 13 : undefined}), replace: true})
            }
          />
        ) : tab === 'knowledge' ? (
          <KnowledgeTab
            week={search.week ?? DEFAULTS.week}
            onWeek={next =>
              void navigate({to: '/analytics', search: prev => ({...prev, week: next === 'previous' ? 'previous' : undefined}), replace: true})
            }
          />
        ) : (
          <AssistantTab />
        )}
      </Tabs>
    </div>
  );
}

/** The Assistant tab: the period's totals against the period before, the chart and the question log. */
function AssistantTab() {
  // In the URL (`?range=7d&filter=no_source`): a link opens this view.
  const search = useSearch({from: '/analytics'});
  const navigate = useNavigate({from: '/analytics'});
  const range: ReportRange = search.range ?? DEFAULTS.range;
  const filter: QuestionFilter = search.filter ?? DEFAULTS.filter;
  const setRange = (next: ReportRange) =>
    void navigate({to: '/analytics', search: prev => ({...prev, range: next === DEFAULTS.range ? undefined : next}), replace: true});
  const setFilter = (next: QuestionFilter) =>
    void navigate({to: '/analytics', search: prev => ({...prev, filter: next === DEFAULTS.filter ? undefined : next}), replace: true});
  const report = useQuery(helpdeskReportQuery(range));
  const questions = useInfiniteQuery(helpdeskQuestionsQuery(filter));

  const data = report.data;
  const t = data?.totals;
  const p = data?.previous;
  // `null` is the tile's skeleton: only while loading. A failed read shows a dash, not a skeleton forever.
  const tile = <V,>(value: (totals: ReportTotals) => V) => (t ? value(t) : report.error ? '—' : null);
  const vsHint = report.error ? "Couldn't load" : `vs the ${REPORT_RANGES[range].label} before`;
  const questionsTrend = t && p ? trendOf(t.questions, p.questions, 'count') : undefined;
  // A trend needs a period before to compare with: say so instead of a dangling "vs …".
  const questionsHint =
    !t || !p || questionsTrend
      ? vsHint
      : p.questions === 0
        ? 'No questions the period before'
        : `Same as the ${REPORT_RANGES[range].label} before`;

  const columns: Column<QuestionRow>[] = [
    {
      key: 'question',
      header: 'Question',
      cell: row => (
        <div className="analytics-question">
          <QuestionText text={row.question} />
          {row.article && (
            <span className="muted">
              Best match:{' '}
              <a href={`/help/articles/${encodeURIComponent(row.article.slug)}/`} target="_blank" rel="noopener noreferrer">
                {row.article.title}
              </a>
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      width: 'shrink',
      cell: row => <StatusBadge tone={OUTCOMES[row.outcome].tone}>{OUTCOMES[row.outcome].label}</StatusBadge>,
    },
    {
      key: 'helpful',
      header: 'Feedback',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => (row.helpful === null ? <span className="muted">—</span> : row.helpful ? 'Helpful' : 'Not helpful'),
    },
    {
      key: 'when',
      header: 'Asked',
      width: 'shrink',
      cell: row => <time dateTime={row.createdAt} title={when(row.createdAt)}>{ago(row.createdAt)}</time>,
    },
  ];

  const rows = questions.data?.pages.flatMap(page => page.items);

  return (
    <div className="analytics-tab">
      <div className="toolbar">
        <SegmentedControl label="Period" value={range} onChange={setRange} options={RANGE_OPTIONS} />
      </div>

      <div className="stat-grid">
        <Stat
          label="Questions"
          icon="message-square"
          value={tile(x => number.format(x.questions))}
          trend={questionsTrend}
          hint={questionsHint}
        />
        <Stat
          label="Answered by the assistant"
          icon="check-circle"
          value={tile(x => pct(share(x.answered, x.questions)))}
          trend={t && p ? trendOf(share(t.answered, t.questions), share(p.answered, p.questions), 'rate') : undefined}
          hint={t ? `${number.format(t.answered)} of ${number.format(t.questions)}` : vsHint}
        />
        <Stat
          label="Found helpful"
          icon="trending-up"
          value={tile(x => pct(helpfulRate(x)))}
          trend={t && p ? trendOf(helpfulRate(t), helpfulRate(p), 'rate') : undefined}
          hint={t ? `${number.format(t.helpfulUp + t.helpfulDown)} rated` : vsHint}
        />
        <Stat
          label="Answer cost"
          icon="zap"
          value={tile(x => money.format(x.costCents / 100))}
          hint="Assistant answers only; summaries, drafts and files are in the monthly spend"
        />
      </div>

      <div className="grid-2">
        <Card
          title="Questions asked"
          description={data ? `${longDay.format(new Date(`${data.from}T00:00:00Z`))} to ${longDay.format(new Date(`${data.to}T00:00:00Z`))}` : undefined}>
          {data ? (
            data.totals.questions > 0 ? (
              <BarChart
                label={`Questions asked per ${REPORT_RANGES[range].bucketDays === 1 ? 'day' : 'week'}`}
                data={data.buckets.map(bucket => ({label: bucketLabel(bucket, range), value: bucket.questions}))}
                format={value => number.format(value)}
              />
            ) : (
              <EmptyState
                icon="message-square"
                title="No questions yet"
                action={
                  <a className={buttonClass({variant: 'secondary'})} href="/help/">
                    Open your help center
                  </a>
                }>
                Questions show here once customers use the chat on your site.
              </EmptyState>
            )
          ) : report.error ? (
            <ErrorNote error={report.error} />
          ) : (
            <LoadingBlock rows={3} />
          )}
        </Card>

        <Card title="What happened to each question" description="Every question ends one of four ways.">
          {t ? (
            <div className="analytics-outcomes">
              {(
                [
                  ['answered', t.answered],
                  ['handed_off', t.handedOff],
                  ['no_source', t.noSource],
                  ['ai_off', t.aiOff],
                ] as const
              ).map(([outcome, count]) => (
                <div key={outcome} className="analytics-outcome">
                  <div className="analytics-outcome-head">
                    <span>{OUTCOMES[outcome].label}</span>
                    <span className="muted">
                      {number.format(count)} · {pct(share(count, t.questions))}
                    </span>
                  </div>
                  <ProgressBar value={count} max={Math.max(1, t.questions)} label={`${OUTCOMES[outcome].label}: ${pct(share(count, t.questions))}`} />
                </div>
              ))}
              <DefinitionList
                items={[
                  {label: 'Thumbs up', value: number.format(t.helpfulUp)},
                  {label: 'Thumbs down', value: number.format(t.helpfulDown)},
                ]}
              />
            </div>
          ) : report.error ? (
            <ErrorNote error={report.error} />
          ) : (
            <LoadingBlock rows={3} />
          )}
        </Card>
      </div>

      <Card
        title="Questions customers asked"
        description="Newest first. “No article found” and “Marked not helpful” show what your help center is missing."
        actions={
          <Select
            aria-label="Show"
            value={filter}
            onChange={event => setFilter(event.target.value as QuestionFilter)}
            options={FILTER_OPTIONS}
          />
        }
        flush>
        <DataTable
          caption="Questions customers asked"
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          loading={questions.isPending}
          error={questions.error}
          empty={
            filter === 'all' ? (
              <EmptyState
                icon="inbox"
                title="No questions yet"
                action={
                  <a className={buttonClass({variant: 'secondary'})} href="/help/">
                    Open your help center
                  </a>
                }>
                Questions show here as customers ask the assistant.
              </EmptyState>
            ) : (
              <EmptyState
                icon="inbox"
                title="Nothing here"
                action={
                  <Button variant="secondary" onClick={() => setFilter('all')}>
                    Show all questions
                  </Button>
                }>
                No question matches this filter.
              </EmptyState>
            )
          }
        />
      </Card>
      <LoadMore query={questions} />
    </div>
  );
}
