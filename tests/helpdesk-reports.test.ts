import {describe, expect, it} from 'vitest';

import {isQuestionFilter, isReportRange} from '../src/lib/helpdesk-report-types';
import {buildReport, utcToday} from '../src/server/routes/helpdesk-reports';

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
});
