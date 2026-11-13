import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import type {WeekCount, WeeklyRow} from '../../../lib/helpdesk-report-types';
import {helpdeskWeeksQuery} from '../../queries';
import {useMe, when} from '../../shared';
import {BarChart, buttonClass, Card, type Column, DataTable, EmptyState, ErrorNote, LoadingBlock, Notice, SegmentedControl, Sparkline, Stat} from '../../ui';

/**
 * Analytics › Tickets: the last 4 or 13 UTC weeks from the nightly weekly rows
 * (`/site-api/helpdesk/reports/weeks`). Resolutions are ticket-based (owner decision 1):
 * confirmed = the customer marked it solved, assumed = the team did (it can still be reopened
 * or confirmed for 14 days). Customer rating is shown on its own, never mixed in.
 */

const number = new Intl.NumberFormat('en-GB');
const dayMonth = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'});
const longDay = new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeZone: 'UTC'});

const WEEK_OPTIONS: {value: '4' | '13'; label: string}[] = [
  {value: '4', label: '4 weeks'},
  {value: '13', label: '13 weeks'},
];

const weekLabel = (week: string) => dayMonth.format(new Date(`${week}T00:00:00Z`));

/** Seconds as people say them: "45 s", "12 min", "2 h 10 min", "3 days 4 h". */
export function duration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return '—';
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} h` : `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "4.6 / 5", or '—' with no ratings. */
const rating = (sum: number, count: number) => (count > 0 ? `${(sum / count).toFixed(1)} / 5` : '—');

export function TicketsTab({weeks, onWeeks}: {weeks: WeekCount; onWeeks: (next: WeekCount) => void}) {
  const me = useMe();
  const report = useQuery(helpdeskWeeksQuery(weeks));
  const data = report.data;
  const rows = data?.weeks ?? [];
  const sum = (pick: (row: WeeklyRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const created = sum(row => row.ticketsCreated);
  const solved = sum(row => row.ticketsSolved);
  const confirmed = sum(row => row.solvedConfirmed);
  const assumed = sum(row => row.solvedAssumed);
  const csatCount = sum(row => row.csatCount);
  const csatSum = sum(row => row.csatSum);
  // The latest COMPLETE week is the one before the current (last) one.
  const lastFull = rows.length >= 2 ? rows[rows.length - 2] : undefined;
  // Team-solved tickets of the last 2 weeks can still change (reopened or confirmed within 14 days).
  const provisional = rows.slice(-2).some(row => row.solvedAssumed > 0);
  // The nightly job has not written any week yet: every number would be a made-up zero.
  const notYet = data?.updatedAt === null;
  const empty = Boolean(data) && rows.every(row => row.ticketsCreated === 0 && row.ticketsSolved === 0 && row.csatCount === 0);
  // `null` is the tile's skeleton: only while loading. A failed read shows a dash.
  const tile = (value: () => string) => (notYet ? '—' : data ? value() : report.error ? '—' : null);
  const failedHint = report.error ? "Couldn't load" : notYet ? 'Not worked out yet' : undefined;
  const span = rows.length ? `${longDay.format(new Date(`${rows[0]!.week}T00:00:00Z`))} to today` : undefined;

  const columns: Column<WeeklyRow>[] = [
    {key: 'week', header: 'Week of', cell: row => <span className="cell-title">{longDay.format(new Date(`${row.week}T00:00:00Z`))}</span>},
    {key: 'created', header: 'Created', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.ticketsCreated)}</span>},
    {key: 'solved', header: 'Solved', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.ticketsSolved)}</span>},
    {key: 'confirmed', header: 'Confirmed', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.solvedConfirmed)}</span>},
    {key: 'assumed', header: 'Assumed', align: 'end', width: 'shrink', cell: row => <span className="analytics-number">{number.format(row.solvedAssumed)}</span>},
    {
      key: 'first',
      header: 'First reply (median)',
      align: 'end',
      width: 'shrink',
      cell: row => <span className="analytics-number">{duration(row.firstResponseMedianSecs)}</span>,
    },
    {
      key: 'rating',
      header: 'Rating',
      align: 'end',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => <span className="analytics-number">{rating(row.csatSum, row.csatCount)}</span>,
    },
    {
      key: 'ratings',
      header: 'Ratings',
      align: 'end',
      width: 'shrink',
      hideOnMobile: true,
      cell: row => <span className="analytics-number">{number.format(row.csatCount)}</span>,
    },
  ];

  return (
    <div className="analytics-tab">
      <div className="toolbar">
        <SegmentedControl label="Weeks shown" value={String(weeks) as '4' | '13'} onChange={next => onWeeks(next === '13' ? 13 : 4)} options={WEEK_OPTIONS} />
      </div>

      {data && data.updatedAt === null && (
        <Notice tone="info" title="No weekly numbers yet">
          Weekly numbers are worked out every night. The first ones appear tomorrow.
        </Notice>
      )}
      {provisional && (
        <Notice tone="info">
          Team-solved tickets from the last 14 days can still be reopened or confirmed, so these numbers can still change.
        </Notice>
      )}

      <div className="stat-grid">
        <Stat label="Tickets created" icon="inbox" value={tile(() => number.format(created))} hint={failedHint ?? `In ${rows.length} weeks`}>
          {data && !notYet && (
            <Sparkline
              values={rows.map(row => row.ticketsCreated)}
              label={`Tickets created per week: ${rows.map(row => `${weekLabel(row.week)} ${row.ticketsCreated}`).join(', ')}`}
            />
          )}
        </Stat>
        <Stat
          label="Solved"
          icon="check-circle"
          value={tile(() => number.format(solved))}
          hint={failedHint ?? `${number.format(confirmed)} confirmed · ${number.format(assumed)} assumed`}
        />
        <Stat
          label="Median first reply"
          icon="clock"
          value={tile(() => duration(lastFull?.firstResponseMedianSecs ?? null))}
          hint={
            failedHint ??
            (lastFull
              ? lastFull.firstResponseMedianSecs === null
                ? `No first replies in the week of ${weekLabel(lastFull.week)}`
                : `Week of ${weekLabel(lastFull.week)}, the last full week`
              : 'The last full week')
          }
        />
        <Stat
          label="Customer rating"
          icon="trending-up"
          value={tile(() => rating(csatSum, csatCount))}
          hint={failedHint ?? (csatCount === 1 ? '1 rating' : `${number.format(csatCount)} ratings`)}
        />
      </div>

      {report.error ? (
        <ErrorNote error={report.error} />
      ) : !data ? (
        <LoadingBlock rows={4} />
      ) : notYet ? null : empty ? (
        <Card>
          <EmptyState
            icon="inbox"
            title="No tickets yet"
            action={
              me.data?.abilities.useInbox ? (
                <Link className={buttonClass({variant: 'secondary'})} to="/inbox">
                  Open the inbox
                </Link>
              ) : undefined
            }>
            Tickets show here once customers ask for a person and the team works on them.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid-2">
            <Card title="Tickets created per week" description={span}>
              <BarChart
                label="Tickets created per week"
                data={rows.map(row => ({label: weekLabel(row.week), value: row.ticketsCreated}))}
                format={value => number.format(value)}
              />
            </Card>
            <Card title="Tickets solved per week" description="Counted in the week they were solved.">
              <BarChart
                label="Tickets solved per week"
                data={rows.map(row => ({label: weekLabel(row.week), value: row.ticketsSolved}))}
                format={value => number.format(value)}
              />
            </Card>
          </div>

          <Card
            title="Week by week"
            description={`Newest first. Confirmed: the customer said it was solved. Assumed: the team marked it solved.${data.updatedAt ? ` Worked out ${when(data.updatedAt)}.` : ''}`}
            flush>
            <DataTable caption="Tickets week by week" columns={columns} rows={[...rows].reverse()} rowKey={row => row.week} />
          </Card>
        </>
      )}
    </div>
  );
}
