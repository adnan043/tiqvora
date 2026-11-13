import {describe, expect, it} from 'vitest';

import {canonicalTimeZone, localParts, timeZoneOptions, weeklyCheckSlot, zonedInstant} from '../src/lib/time-zone';

/** The owner's time zone and the weekly Knowledge health slot (src/lib/time-zone.ts). No database. */
const iso = (d: Date) => d.toISOString();
const HOUR = 3_600_000;

describe('canonicalTimeZone', () => {
  it('keeps valid zones and canonicalises case', () => {
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('Europe/London')).toBe('Europe/London');
    expect(canonicalTimeZone('america/new_york')).toBe('America/New_York');
  });

  it('maps old names and links to the current IANA zone, whatever the engine reports', () => {
    const cases: [string, string][] = [
      ['Asia/Calcutta', 'Asia/Kolkata'],
      ['Asia/Kolkata', 'Asia/Kolkata'],
      ['asia/calcutta', 'Asia/Kolkata'],
      ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
      ['Asia/Katmandu', 'Asia/Kathmandu'],
      ['Europe/Kiev', 'Europe/Kyiv'],
      ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
      ['Africa/Asmera', 'Africa/Asmara'],
      ['US/Eastern', 'America/New_York'],
      ['US/Pacific', 'America/Los_Angeles'],
      ['US/Hawaii', 'Pacific/Honolulu'],
      ['Etc/UTC', 'UTC'],
      ['GMT', 'UTC'],
      ['Zulu', 'UTC'],
    ];
    for (const [given, want] of cases) {
      expect(canonicalTimeZone(given), given).toBe(want);
      expect(canonicalTimeZone(want), want).toBe(want);
    }
  });

  it('maps POSIX-style US zones to the city zone they link to', () => {
    expect(canonicalTimeZone('EST5EDT')).toBe('America/New_York');
    expect(canonicalTimeZone('CST6CDT')).toBe('America/Chicago');
    expect(canonicalTimeZone('MST7MDT')).toBe('America/Denver');
    expect(canonicalTimeZone('PST8PDT')).toBe('America/Los_Angeles');
    expect(canonicalTimeZone('EST')).toBe('America/Panama');
    // A fixed-offset Etc zone is a real IANA zone: kept as it is.
    expect(canonicalTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
  });

  it('refuses junk', () => {
    for (const bad of ['Mars/Olympus', '', ' ', '../x', 'Europe/London ', 'a'.repeat(65), 'Europe/Lon;don', null, undefined, 42, {}]) {
      expect(canonicalTimeZone(bad)).toBeNull();
    }
  });

  it('lists UTC first, deduped, every option canonical', () => {
    const list = timeZoneOptions();
    expect(list[0]).toBe('UTC');
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(10);
    for (const zone of list) expect(canonicalTimeZone(zone)).toBe(zone);
  });

  it('lists no old alias names, only the current ones', () => {
    const list = timeZoneOptions();
    for (const old of ['Africa/Asmera', 'Asia/Calcutta', 'Asia/Saigon', 'Asia/Katmandu', 'Asia/Rangoon', 'Europe/Kiev', 'America/Buenos_Aires', 'America/Godthab', 'Pacific/Truk', 'EST5EDT', 'US/Eastern', 'Etc/UTC']) {
      expect(list, old).not.toContain(old);
    }
    for (const current of ['Asia/Kolkata', 'Europe/Kyiv', 'America/New_York']) expect(list).toContain(current);
    expect(list.slice(1)).toEqual([...list.slice(1)].sort());
  });
});

describe('localParts and zonedInstant', () => {
  it('reads wall-clock parts with Sunday = 0', () => {
    expect(localParts(new Date('2026-11-15T23:30:00Z'), 'UTC')).toEqual({year: 2026, month: 11, day: 15, hour: 23, minute: 30, weekday: 0});
    expect(localParts(new Date('2026-11-16T00:00:00Z'), 'UTC').hour).toBe(0);
    expect(localParts(new Date('2026-11-16T00:00:00Z'), 'Asia/Kolkata')).toMatchObject({day: 16, hour: 5, minute: 30, weekday: 1});
  });

  it('finds the instant of a local time, across DST', () => {
    expect(iso(zonedInstant(2026, 3, 9, 7, 30, 'America/Los_Angeles'))).toBe('2026-03-09T14:30:00.000Z');
    expect(iso(zonedInstant(2026, 3, 2, 7, 30, 'America/Los_Angeles'))).toBe('2026-03-02T15:30:00.000Z');
    expect(iso(zonedInstant(2026, 7, 1, 12, 0, 'Europe/London'))).toBe('2026-07-01T11:00:00.000Z');
  });
});

describe('weeklyCheckSlot', () => {
  it('UTC: Monday 07:30', () => {
    const before = weeklyCheckSlot(new Date('2026-11-16T07:29:59Z'), 'UTC');
    expect(before).toMatchObject({week: '2026-11-16', due: false});
    expect(iso(before.dueAt)).toBe('2026-11-16T07:30:00.000Z');
    const after = weeklyCheckSlot(new Date('2026-11-16T07:30:00Z'), 'UTC');
    expect(after.due).toBe(true);
    expect(iso(after.windowStart)).toBe('2026-11-09T07:30:00.000Z');
    expect(after.windowEnd).toEqual(after.dueAt);
    expect(after.windowEnd.getTime() - after.windowStart.getTime()).toBe(168 * HOUR);
  });

  it('America/Los_Angeles on the DST Mondays: 07:30 local both weeks', () => {
    const spring = weeklyCheckSlot(new Date('2026-03-09T15:00:00Z'), 'America/Los_Angeles');
    expect(spring.week).toBe('2026-03-09');
    expect(iso(spring.dueAt)).toBe('2026-03-09T14:30:00.000Z');
    expect(spring.due).toBe(true);
    expect(iso(spring.windowStart)).toBe('2026-03-02T15:30:00.000Z');
    expect(spring.windowEnd.getTime() - spring.windowStart.getTime()).toBe(167 * HOUR);

    const fall = weeklyCheckSlot(new Date('2026-11-02T15:00:00Z'), 'America/Los_Angeles');
    expect(fall.week).toBe('2026-11-02');
    expect(iso(fall.dueAt)).toBe('2026-11-02T15:30:00.000Z');
    expect(fall.due).toBe(false);
    expect(iso(fall.windowStart)).toBe('2026-10-26T14:30:00.000Z');
    expect(fall.windowEnd.getTime() - fall.windowStart.getTime()).toBe(169 * HOUR);
  });

  it('Asia/Kolkata: due at 02:00Z', () => {
    const slot = weeklyCheckSlot(new Date('2026-11-16T02:00:00Z'), 'Asia/Kolkata');
    expect(slot).toMatchObject({week: '2026-11-16', due: true});
    expect(iso(slot.dueAt)).toBe('2026-11-16T02:00:00.000Z');
  });

  it('Asia/Kathmandu: due at 01:45Z, so the first */30 tick that is due is 02:00Z', () => {
    expect(iso(weeklyCheckSlot(new Date('2026-11-16T01:30:00Z'), 'Asia/Kathmandu').dueAt)).toBe('2026-11-16T01:45:00.000Z');
    expect(weeklyCheckSlot(new Date('2026-11-16T01:30:00Z'), 'Asia/Kathmandu').due).toBe(false);
    expect(weeklyCheckSlot(new Date('2026-11-16T02:00:00Z'), 'Asia/Kathmandu')).toMatchObject({week: '2026-11-16', due: true});
  });

  it('Pacific/Kiritimati (+14): Monday 07:30 local is Sunday 17:30Z', () => {
    const slot = weeklyCheckSlot(new Date('2026-11-15T17:30:00Z'), 'Pacific/Kiritimati');
    expect(slot).toMatchObject({week: '2026-11-16', due: true});
    expect(iso(slot.dueAt)).toBe('2026-11-15T17:30:00.000Z');
    expect(weeklyCheckSlot(new Date('2026-11-15T17:00:00Z'), 'Pacific/Kiritimati')).toMatchObject({week: '2026-11-16', due: false});
  });

  it('Sunday 23:59 local belongs to the previous Monday’s week', () => {
    const slot = weeklyCheckSlot(new Date('2026-11-23T04:59:00Z'), 'America/New_York');
    expect(localParts(new Date('2026-11-23T04:59:00Z'), 'America/New_York')).toMatchObject({weekday: 0, hour: 23, minute: 59});
    expect(slot).toMatchObject({week: '2026-11-16', due: true});
    expect(iso(slot.dueAt)).toBe('2026-11-16T12:30:00.000Z');
  });

  it('crosses month and year boundaries', () => {
    expect(weeklyCheckSlot(new Date('2027-01-02T12:00:00Z'), 'UTC').week).toBe('2026-12-28');
    expect(iso(weeklyCheckSlot(new Date('2026-12-01T12:00:00Z'), 'UTC').windowStart)).toBe('2026-11-23T07:30:00.000Z');
  });

  it('the window is always 7 local days', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'Australia/Sydney', 'America/Sao_Paulo', 'Asia/Kathmandu']) {
      for (let day = 0; day < 365; day += 5) {
        const slot = weeklyCheckSlot(new Date(Date.UTC(2026, 0, 1) + day * 24 * HOUR), tz);
        const start = localParts(slot.windowStart, tz);
        const end = localParts(slot.windowEnd, tz);
        expect([start.weekday, start.hour, start.minute]).toEqual([1, 7, 30]);
        expect([end.weekday, end.hour, end.minute]).toEqual([1, 7, 30]);
        const hours = (slot.windowEnd.getTime() - slot.windowStart.getTime()) / HOUR;
        expect([167, 168, 169]).toContain(hours);
      }
    }
  });
});
