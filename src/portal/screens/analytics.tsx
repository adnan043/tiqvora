import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {useState} from 'react';

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
import {ago, when} from '../shared';
import {
  BarChart,
  Button,
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
  type Tone,
} from '../ui';

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

/**
 * Holders of `site:helpdesk:reports`: how the assistant is doing. Totals come from
 * `question_stats_daily` (kept on write), the list from the question log
 * (`/site-api/helpdesk/reports`).
 */
export function Analytics() {
  // In the URL (`?range=7d&filter=no_source`, routes.tsx `parseAnalyticsSearch`): a link opens this view.
  const search = useSearch({from: '/analytics'});
  const navigate = useNavigate();
  const range: ReportRange = search.range ?? '4w';
  const filter: QuestionFilter = search.filter ?? 'all';
  const setRange = (next: ReportRange) =>
    void navigate({to: '/analytics', search: prev => ({...prev, range: next === '4w' ? undefined : next}), replace: true});
  const setFilter = (next: QuestionFilter) =>
    void navigate({to: '/analytics', search: prev => ({...prev, filter: next === 'all' ? undefined : next}), replace: true});
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
    <div className="app-page screen-analytics">
      <PageHeader
        title="Assistant analytics"
        description="How many questions the assistant answered on its own, and which ones it couldn't. Days are counted in UTC."
        actions={<SegmentedControl label="Period" value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />

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
          label="AI cost"
          icon="zap"
          value={tile(x => money.format(x.costCents / 100))}
          hint={t && t.answered > 0 ? `${money.format(t.costCents / 100 / t.answered)} per answer` : `${REPORT_RANGES[range].label}`}
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
              <EmptyState icon="message-square" title="No questions yet">
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
            <EmptyState icon="inbox" title={filter === 'all' ? 'No questions yet' : 'Nothing here'}>
              {filter === 'all'
                ? 'Questions show here as customers ask the assistant.'
                : 'No question matches this filter. Try “All questions”.'}
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={questions} />
    </div>
  );
}
