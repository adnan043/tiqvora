import {describe, expect, it} from 'vitest';

import {isQuestionFilter, isReportRange, isTopWeek, isWeekCount} from '../src/lib/helpdesk-report-types';
import {weekKey} from '../src/server/helpdesk/state';
import {mondayBefore, normalizeQuestion, rankUnanswered} from '../src/server/helpdesk/weekly';
import {buildOverview, buildReport, buildTop, fillWeeks, type OverviewInput, utcToday} from '../src/server/routes/helpdesk-reports';

const day = (iso: string, n: Partial<Record<string, number>> = {}, micros = 0n) => ({
  day: new Date(`${iso}T00:00:00Z`),
  questions: n.questions ?? 0,
  answered: n.answered ?? 0,
  handedOff: n.handedOff ?? 0,
  noSource: n.noSource ?? 0,
  aiOff: n.aiOff ?? 0,
  helpfulUp: n.helpfulUp ?? 0,
  helpfulDown: n.helpfulDown ?? 0,
  costMicros: micros,
});

const TODAY = new Date('2026-11-12T00:00:00Z');

describe('buildReport', () => {
  it('7 days: daily buckets ending today, the 7 days before as the previous period', () => {
    const report = buildReport(
      '7d',
      [
        day('2026-10-29', {questions: 99}), // before both periods: ignored
        day('2026-10-30', {questions: 4, answered: 1}), // previous period's first day
        day('2026-11-05', {questions: 2, answered: 2}), // previous period's last day
        day('2026-11-06', {questions: 3, answered: 2, noSource: 1, helpfulUp: 1}, 15_000n), // first day
        day('2026-11-12', {questions: 5, handedOff: 4, aiOff: 1, helpfulDown: 2}, 1n), // today
        day('2026-11-13', {questions: 50}), // tomorrow (a clock skew): ignored
      ],
      TODAY
    );
    expect(report.from).toBe('2026-11-06');
    expect(report.to).toBe('2026-11-12');
    expect(report.buckets).toHaveLength(7);
    expect(report.buckets[0]).toEqual({start: '2026-11-06', questions: 3, answered: 2, handedOff: 0, noSource: 1});
    expect(report.buckets[6]).toEqual({start: '2026-11-12', questions: 5, answered: 0, handedOff: 4, noSource: 0});
    expect(report.totals).toEqual({
      questions: 8,
      answered: 2,
      handedOff: 4,
      noSource: 1,
      aiOff: 1,
      helpfulUp: 1,
      helpfulDown: 2,
      costCents: 2, // 15,001 micro-dollars: a started cent shows
    });
    expect(report.previous.questions).toBe(6);
    expect(report.previous.answered).toBe(3);
  });

  it('4 weeks and 13 weeks: weekly buckets of 7 days, the last one ending today', () => {
    const four = buildReport('4w', [day('2026-10-16', {questions: 1}), day('2026-11-05', {questions: 2}), day('2026-11-06', {questions: 3})], TODAY);
    expect(four.from).toBe('2026-10-16');
    expect(four.buckets.map(b => b.start)).toEqual(['2026-10-16', '2026-10-23', '2026-10-30', '2026-11-06']);
    expect(four.buckets.map(b => b.questions)).toEqual([1, 0, 2, 3]);

    const thirteen = buildReport('13w', [], TODAY);
    expect(thirteen.buckets).toHaveLength(13);
    expect(thirteen.buckets.at(-1)!.start).toBe('2026-11-06');
    expect(thirteen.totals.questions).toBe(0);
    expect(thirteen.totals.costCents).toBe(0);
  });

  it('utcToday is midnight UTC whatever the time of day', () => {
    expect(utcToday(new Date('2026-11-12T23:59:59.999Z')).toISOString()).toBe('2026-11-12T00:00:00.000Z');
  });
});

describe('query guards', () => {
  it('accept only the fixed ranges and filters', () => {
    expect(isReportRange('4w')).toBe(true);
    expect(isReportRange('constructor')).toBe(false);
    expect(isReportRange('30d')).toBe(false);
    expect(isQuestionFilter('unhelpful')).toBe(true);
    expect(isQuestionFilter("all' OR 1=1")).toBe(false);
  });

  it('weeks: 4 or 13 only; top: current or previous only', () => {
    expect(isWeekCount('4')).toBe(true);
    expect(isWeekCount('13')).toBe(true);
    expect(isWeekCount('12')).toBe(false);
    expect(isWeekCount(['4'])).toBe(false);
    expect(isTopWeek('previous')).toBe(true);
    expect(isTopWeek('toString')).toBe(false);
  });
});

describe('weeks (UTC Mondays)', () => {
  it('Sunday 23:59 UTC is the old week, Monday 00:00 UTC the new one', () => {
    expect(weekKey(new Date('2026-11-15T23:59:59.999Z'))).toBe('2026-11-09');
    expect(weekKey(new Date('2026-11-16T00:00:00.000Z'))).toBe('2026-11-16');
    expect(mondayBefore('2026-11-09', 2)).toBe('2026-10-26');
    expect(mondayBefore('2026-11-02', 1)).toBe('2026-10-26'); // across the end of summer time: still UTC
  });

  it('fillWeeks: exactly count weeks ending with this one, gaps as zeros, newest updatedAt', () => {
    const row = (week: string, n: number, updated: string) => ({
      week: new Date(`${week}T00:00:00Z`),
      ticketsCreated: n,
      ticketsSolved: n,
      solvedConfirmed: 1,
      solvedAssumed: n - 1,
      firstResponses: 1,
      firstResponseMedianSecs: 600,
      csatCount: 1,
      csatSum: 5,
      updatedAt: new Date(updated),
    });
    const report = fillWeeks(
      [row('2026-10-19', 3, '2026-10-26T04:00:00Z'), row('2026-11-09', 2, '2026-11-13T04:00:00Z')],
      '2026-11-09',
      4
    );
    expect(report.weeks.map(w => w.week)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(report.weeks.map(w => w.ticketsCreated)).toEqual([3, 0, 0, 2]);
    expect(report.weeks[1]).toMatchObject({firstResponseMedianSecs: null, csatCount: 0});
    expect(report.updatedAt).toBe('2026-11-13T04:00:00.000Z');

    const empty = fillWeeks([], '2026-11-09', 13);
    expect(empty.weeks).toHaveLength(13);
    expect(empty.weeks[0]!.week).toBe('2026-08-17');
    expect(empty.updatedAt).toBeNull();
  });
});

describe('unanswered questions', () => {
  it('normalizes case, spaces and punctuation at the ends', () => {
    expect(normalizeQuestion('  Where is   my ORDER?? ')).toBe('where is my order');
    expect(normalizeQuestion('where is my order')).toBe('where is my order');
    expect(normalizeQuestion('¿Dónde está mi pedido?')).toBe('dónde está mi pedido');
    expect(normalizeQuestion("can't log in!")).toBe("can't log in");
    expect(normalizeQuestion('?!')).toBe('');
    expect(normalizeQuestion('…«Where is my order?»…')).toBe('where is my order');
    expect(normalizeQuestion('a 😀')).toBe('a 😀'); // an emoji is not punctuation
  });

  it('a long run of punctuation is trimmed in linear time (no regex backtracking)', () => {
    const junk = 'a' + '!'.repeat(50_000) + 'b' + '?'.repeat(200_000);
    const start = performance.now();
    expect(normalizeQuestion(junk)).toBe('a' + '!'.repeat(50_000) + 'b');
    expect(normalizeQuestion('!'.repeat(200_000))).toBe('');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('ranks by times asked, ties by most recent, shows the newest wording, ≤ 10', () => {
    const asked = [
      'Where is my order?', // newest
      'refund',
      'where is my order',
      'Refund!',
      'shipping cost',
      'WHERE IS MY ORDER',
      '???', // nothing left after normalising: skipped
    ];
    expect(rankUnanswered(asked)).toEqual([
      {question: 'Where is my order?', asked: 3},
      {question: 'refund', asked: 2},
      {question: 'shipping cost', asked: 1},
    ]);
    const many = Array.from({length: 30}, (_, i) => `question ${i}`);
    expect(rankUnanswered(many)).toHaveLength(10);
    expect(rankUnanswered(many)[0]!.question).toBe('question 0');
  });
});

describe('overview', () => {
  const base = (o: Partial<OverviewInput> = {}): OverviewInput => ({
    today: new Date('2026-11-12T15:00:00Z'), // a Thursday
    days: [],
    usage: {month: '2026-11', spentCents: 0, requests: 0},
    capCents: 2000,
    hasKey: true,
    openIssues: [],
    failedFiles: null,
    canSettings: true,
    ...o,
  });
  const kinds = (o: Partial<OverviewInput>) => buildOverview(base(o)).health.map(h => h.kind);

  it('sums Monday to today and fills the days with no row', () => {
    const day = (iso: string, answered: number) => ({
      day: new Date(`${iso}T00:00:00Z`),
      questions: answered + 1,
      answered,
      handedOff: 1,
      noSource: 0,
      helpfulUp: 0,
      helpfulDown: 0,
    });
    const o = buildOverview(base({days: [day('2026-11-08', 50), day('2026-11-09', 2), day('2026-11-11', 3)]}));
    expect(o.week).toEqual({from: '2026-11-09', to: '2026-11-12'});
    expect(o.answeredByDay).toEqual([2, 0, 3, 0]); // last Sunday ignored
    expect(o).toMatchObject({questions: 7, answered: 5, handedOff: 2});
    expect(buildOverview(base({today: new Date('2026-11-09T00:00:00Z')})).answeredByDay).toEqual([0]);
    expect(buildOverview(base({today: new Date('2026-11-15T23:59:00Z')})).answeredByDay).toHaveLength(7);
  });

  it('AI state: off, used up, at 80 %, under 80 %', () => {
    expect(kinds({hasKey: false})).toEqual(['assistant_off']);
    expect(kinds({capCents: 0})).toEqual(['assistant_off']);
    expect(buildOverview(base({hasKey: false})).aiReady).toBe(false);
    expect(kinds({usage: {month: '2026-11', spentCents: 2000, requests: 9}})).toEqual(['cap_reached']);
    const near = buildOverview(base({usage: {month: '2026-11', spentCents: 1600, requests: 9}}));
    expect(near.health).toEqual([{kind: 'cap_near', count: 80, more: false}]);
    expect(near.spend).toEqual({month: '2026-11', spentCents: 1600, capCents: 2000, requests: 9});
    expect(kinds({usage: {month: '2026-11', spentCents: 1599, requests: 9}})).toEqual([]);
  });

  it('spend only for who holds the assistant settings: absent otherwise', () => {
    expect(buildOverview(base({canSettings: true})).spend).toEqual({month: '2026-11', spentCents: 0, capCents: 2000, requests: 0});
    const reporter = buildOverview(base({canSettings: false, usage: {month: '2026-11', spentCents: 1900, requests: 9}}));
    expect('spend' in reporter).toBe(false);
    expect(JSON.stringify(reporter)).not.toMatch(/1900|spentCents|capCents/);
  });

  it('the week does not depend on the clock: any time on Monday 00:00…Sunday 23:59 UTC', () => {
    const one = {questions: 1, answered: 1, handedOff: 0, noSource: 0, helpfulUp: 0, helpfulDown: 0};
    const monday = buildOverview(base({today: new Date('2026-11-16T00:00:00.000Z'), days: [{day: new Date('2026-11-16T00:00:00Z'), ...one}, {day: new Date('2026-11-15T00:00:00Z'), ...one}]}));
    expect(monday.week).toEqual({from: '2026-11-16', to: '2026-11-16'});
    expect(monday.answeredByDay).toEqual([1]);
    const sunday = buildOverview(base({today: new Date('2026-11-15T23:59:59.999Z'), days: [{day: new Date('2026-11-15T00:00:00Z'), ...one}]}));
    expect(sunday.week).toEqual({from: '2026-11-09', to: '2026-11-15'});
    expect(sunday.answeredByDay).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it('who sees what: AI items need settings, failed files need knowledge editing', () => {
    expect(kinds({hasKey: false, canSettings: false})).toEqual([]);
    expect(kinds({failedFiles: null})).toEqual([]);
    expect(kinds({failedFiles: 0})).toEqual([]);
    // 7 are read: exactly 6 is "6", 7 is "6+".
    expect(buildOverview(base({failedFiles: 6})).health).toEqual([{kind: 'failed_files', count: 6, more: false}]);
    expect(buildOverview(base({failedFiles: 7})).health).toEqual([{kind: 'failed_files', count: 6, more: true}]);
    expect(buildOverview(base({failedFiles: 2})).health).toEqual([{kind: 'failed_files', count: 2, more: false}]);
  });

  it('orders by urgency, counts gaps only (not conflicts), caps at 6, and marks a full scan as "more"', () => {
    const all = buildOverview(
      base({
        hasKey: false,
        failedFiles: 1,
        days: [{day: new Date('2026-11-10T00:00:00Z'), questions: 4, answered: 1, handedOff: 0, noSource: 3, helpfulUp: 0, helpfulDown: 0}],
        openIssues: [
          {type: 'stale', n: 2},
          {type: 'low_rated', n: 1},
          {type: 'conflict', n: 1},
          {type: 'gap', n: 4},
        ],
      })
    );
    expect(all.health.map(h => h.kind)).toEqual(['assistant_off', 'failed_files', 'no_source', 'knowledge_gaps', 'low_rated', 'stale_articles']);
    expect(all.health.find(h => h.kind === 'knowledge_gaps')).toEqual({kind: 'knowledge_gaps', count: 4, more: false});
    // Conflicts alone: no "knowledge gaps" item (it links to type=gap).
    expect(kinds({openIssues: [{type: 'conflict', n: 3}]})).toEqual([]);
    expect(all.health.find(h => h.kind === 'no_source')!.count).toBe(3);

    const capped = buildOverview(base({hasKey: true, usage: {month: '2026-11', spentCents: 2000, requests: 1}, failedFiles: 1,
      days: [{day: new Date('2026-11-10T00:00:00Z'), questions: 1, answered: 0, handedOff: 0, noSource: 1, helpfulUp: 0, helpfulDown: 0}],
      openIssues: [{type: 'gap', n: 97}, {type: 'stale', n: 3}]}));
    expect(capped.health.length).toBeLessThanOrEqual(6);
    expect(capped.health.find(h => h.kind === 'stale_articles')).toEqual({kind: 'stale_articles', count: 3, more: true});
    expect(capped.health.find(h => h.kind === 'knowledge_gaps')!.more).toBe(true);
  });
});

describe('buildTop', () => {
  const at = new Date('2026-11-13T04:00:00Z');
  const row = (list: string, rank: number, extra: Partial<Record<string, unknown>> = {}) => ({
    list,
    rank,
    question: '',
    value: 0,
    value2: 0,
    updated_at: at,
    article_id: null,
    title: null,
    slug: null,
    ...extra,
  });

  it('splits the lists in rank order; an article no longer published is null', () => {
    const computed = new Date('2026-11-13T04:00:05Z');
    const top = buildTop('2026-11-09', [
      row('used', 2, {value: 3}),
      row('used', 1, {value: 9, article_id: 7, title: 'Returns', slug: 'returns'}),
      row('unanswered', 1, {question: 'Where is my order?', value: 4}),
      row('low_rated', 1, {value: 6, value2: 1, article_id: 8, title: 'Sizes', slug: 'sizes'}),
    ], computed);
    expect(top).toEqual({
      week: '2026-11-09',
      updatedAt: '2026-11-13T04:00:05.000Z',
      unanswered: [{question: 'Where is my order?', asked: 4}],
      mostUsed: [
        {article: {id: 7, title: 'Returns', slug: 'returns'}, answered: 9},
        {article: null, answered: 3},
      ],
      lowestRated: [{article: {id: 8, title: 'Sizes', slug: 'sizes'}, helpful: 1, notHelpful: 6}],
    });
  });

  it('updatedAt is when the week was worked out: null = never; set with no rows = nothing to rank', () => {
    expect(buildTop('2026-11-09', [], null).updatedAt).toBeNull();
    expect(buildTop('2026-11-09', [row('used', 1)], null).updatedAt).toBe('2026-11-13T04:00:00.000Z');
    // A computed week with no rankings: the query's one row of nulls.
    const nulls = {list: null, rank: null, question: null, value: null, value2: null, updated_at: null, article_id: null, title: null, slug: null};
    const empty = buildTop('2026-11-09', [nulls as never], at);
    expect(empty).toEqual({week: '2026-11-09', updatedAt: '2026-11-13T04:00:00.000Z', unanswered: [], mostUsed: [], lowestRated: []});
  });
});
