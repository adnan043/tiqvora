import {describe, expect, it} from 'vitest';

import {
  CUSTOMER_STATUS_LABELS,
  customerCanReply,
  customerOf,
  DELETED_CUSTOMER_NAME,
  TICKET_LIMITS,
  ticketSubject,
} from '../src/lib/helpdesk-tickets';
import {solvedCounter, weekKey} from '../src/server/helpdesk/state';

describe('weekKey (the solved-this-week counter)', () => {
  it('is the UTC Monday of the week, like Postgres date_trunc(week)', () => {
    expect(weekKey(new Date('2026-11-12T10:00:00Z'))).toBe('2026-11-09'); // Thursday
    expect(weekKey(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09'); // Monday 00:00
    expect(weekKey(new Date('2026-11-15T23:59:59.999Z'))).toBe('2026-11-09'); // Sunday night
    expect(weekKey(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16'); // the next Monday
    expect(weekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-12-28'); // across a year
    expect(weekKey(new Date('2028-03-01T12:00:00Z'))).toBe('2028-02-28'); // across a leap day
  });

  it('uses UTC, not the local time zone', () => {
    // Monday 00:30 in UTC+2 is still Sunday in UTC.
    expect(weekKey(new Date('2026-11-16T00:30:00+02:00'))).toBe('2026-11-09');
  });

  it('names a counter row that fits VARCHAR(32)', () => {
    expect(solvedCounter(weekKey())).toMatch(/^solved:\d{4}-\d{2}-\d{2}$/);
    expect(solvedCounter(weekKey()).length).toBeLessThanOrEqual(32);
  });
});

describe('ticketSubject', () => {
  it('collapses whitespace and keeps short text as it is', () => {
    expect(ticketSubject('  My order\n\nnever   arrived ')).toBe('My order never arrived');
    expect(ticketSubject('')).toBe('');
  });

  it('cuts long text to 120 characters at a word, with an ellipsis', () => {
    const subject = ticketSubject(`${'word '.repeat(40)}end`);
    expect(subject.length).toBeLessThanOrEqual(TICKET_LIMITS.subject);
    expect(subject.endsWith('word…')).toBe(true);
  });

  it('cuts mid-word when there is no space to cut at', () => {
    const subject = ticketSubject('x'.repeat(300));
    expect(subject).toBe(`${'x'.repeat(119)}…`);
  });
});

describe('customerCanReply', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  it('is open while unsolved, and for 14 days after solved', () => {
    expect(customerCanReply('waiting', null, now)).toBe(true);
    expect(customerCanReply('pending', null, now)).toBe(true);
    expect(customerCanReply('solved', daysAgo(13), now)).toBe(true);
    expect(customerCanReply('solved', daysAgo(14).toISOString(), now)).toBe(false);
    expect(customerCanReply('solved', daysAgo(30), now)).toBe(false);
  });
});

describe('customer words', () => {
  it('a deleted customer is anonymised', () => {
    expect(customerOf(null)).toEqual({id: null, name: DELETED_CUSTOMER_NAME});
    expect(DELETED_CUSTOMER_NAME).toBe('Deleted customer');
    expect(customerOf({id: 4, name: 'Ana'})).toEqual({id: 4, name: 'Ana'});
  });

  it('never shows the staff words to customers', () => {
    expect(CUSTOMER_STATUS_LABELS).toEqual({
      waiting: 'With our team',
      open: 'With our team',
      pending: 'Waiting for you',
      solved: 'Solved',
    });
  });
});

describe('the widget and the server agree on the hand-off limits', () => {
  it('HANDOFF_LIMITS (browser) mirror TICKET_LIMITS (server)', async () => {
    const {HANDOFF_LIMITS} = await import('../src/lib/helpdesk-handoff');
    expect(HANDOFF_LIMITS.lines).toBe(TICKET_LIMITS.transcriptLines);
    expect(HANDOFF_LIMITS.text).toBe(TICKET_LIMITS.body);
    expect(HANDOFF_LIMITS.chars).toBe(TICKET_LIMITS.transcriptChars);
    expect(HANDOFF_LIMITS.citations).toBe(TICKET_LIMITS.citationsPerLine);
    expect(HANDOFF_LIMITS.note).toBe(TICKET_LIMITS.note);
  });
});

describe('ticket text is rendered as text, never HTML', () => {
  it('no Phase 3 screen or the widget uses dangerouslySetInnerHTML / innerHTML', async () => {
    const {readFileSync, readdirSync, existsSync} = await import('node:fs');
    const files = ['src/portal/screens/inbox.tsx', 'src/portal/screens/support.tsx', 'src/portal/screens/canned.tsx', 'src/lib/helpdesk-widget.ts'];
    if (existsSync('src/portal/screens/inbox')) {
      for (const f of readdirSync('src/portal/screens/inbox')) files.push(`src/portal/screens/inbox/${f}`);
    }
    for (const file of files.filter(f => existsSync(f))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/);
    }
  });
});
