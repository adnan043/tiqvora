import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The Knowledge health tick's logic without a database: when it starts the weekly run, what a
 * refused send undoes, the unknown-zone fallback, and the bounded draft sweep. The statements
 * themselves run against Postgres in tests/integration/knowledge-health-run.test.ts.
 */
const h = vi.hoisted(() => ({
  sends: [] as {list: string; data: unknown; options: Record<string, unknown>}[],
  refuseSend: false,
  queued: [] as number[],
  refuseDraftAt: -1,
  slot: {week: '2026-11-09', due: true},
  canonical: (tz: unknown): string | null => (tz === 'Bad/Zone' ? null : String(tz)),
}));

vi.mock('../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options: Record<string, unknown> = {}) => {
      if (h.refuseSend) throw new real.JobRejected('Too many jobs this minute.', 'E_JOBS_RATE_LIMITED', 429);
      h.sends.push({list, data, options});
      return {id: 'job_1', list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});
vi.mock('../src/lib/time-zone', () => ({
  canonicalTimeZone: (tz: unknown) => h.canonical(tz),
  weeklyCheckSlot: (_now: Date, tz: string) => ({
    week: h.slot.week,
    due: h.slot.due,
    tz,
    dueAt: new Date('2026-11-09T07:30:00Z'),
    windowStart: new Date('2026-11-02T07:30:00Z'),
    windowEnd: new Date('2026-11-09T07:30:00Z'),
  }),
}));
vi.mock('../src/server/knowledge/drafts', () => ({
  queueArticleDraft: async (_url: unknown, ticketId: number) => {
    if (h.queued.length === h.refuseDraftAt) return false;
    h.queued.push(ticketId);
    return true;
  },
}));

const {runKnowledgeTick} = await import('../src/server/knowledge/tick');
const {parseWeek} = await import('../src/server/knowledge/health');

interface Call {
  sql: string;
  values: unknown[];
}

/** A tagged-template stand-in for PrismaClient: answers by the statement's text. */
function fakeDb(answers: {timeZone?: string | null; won?: boolean; due?: {id: number; number: number}[]}) {
  const calls: Call[] = [];
  const answer = (sql: string): unknown => {
    if (sql.includes('FROM "helpdesk_settings"')) return answers.timeZone === null ? [] : [{timeZone: answers.timeZone ?? 'UTC'}];
    if (sql.includes('INSERT INTO "knowledge_health_runs"')) return answers.won === false ? [] : [{week: new Date('2026-11-09')}];
    if (sql.includes('stalled_runs')) return [{stalledRuns: 0, gaveUp: 0, stalledTests: 0, pruned: 0}];
    if (sql.includes('SELECT "id", "number" FROM "tickets"')) return answers.due ?? [];
    if (sql.includes('DELETE FROM "knowledge_health_runs"')) return 1;
    throw new Error(`unexpected statement: ${sql}`);
  };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    calls.push({sql, values});
    return Promise.resolve(answer(sql));
  };
  return {db: {$queryRaw: tag, $executeRaw: tag} as never, calls};
}

const NOW = new Date('2026-11-09T08:00:00Z');
const has = (calls: Call[], text: string) => calls.some(c => c.sql.includes(text));
const guardDelete = (calls: Call[]) => calls.find(c => c.sql.includes('DELETE FROM "knowledge_health_runs"') && c.sql.includes(`"phase" = 'gaps'`));

describe('knowledge health tick', () => {
  beforeEach(() => {
    h.sends.length = 0;
    h.queued.length = 0;
    h.refuseSend = false;
    h.refuseDraftAt = -1;
    h.slot = {week: '2026-11-09', due: true};
    vi.restoreAllMocks();
  });

  it('starts the weekly run once the slot is due and this tick wins the guard row', async () => {
    const {db, calls} = fakeDb({timeZone: 'Europe/London'});
    const result = await runKnowledgeTick(db, 'https://shop.example', NOW);
    expect(result.started).toBe('2026-11-09');
    expect(h.sends).toEqual([
      {list: 'knowledge-health', data: {week: '2026-11-09'}, options: {key: 'kh-2026-11-09', label: 'Knowledge health · week of 2026-11-09'}},
    ]);
    const insert = calls.find(c => c.sql.includes('INSERT INTO "knowledge_health_runs"'));
    expect(insert?.values).toEqual(['2026-11-09', 'Europe/London', new Date('2026-11-02T07:30:00Z'), new Date('2026-11-09T07:30:00Z')]);
    expect(guardDelete(calls)).toBeUndefined();
  });

  it('sends nothing when another tick already holds this week', async () => {
    const {db} = fakeDb({won: false});
    expect((await runKnowledgeTick(db, 'https://shop.example', NOW)).started).toBeNull();
    expect(h.sends).toEqual([]);
  });

  it('does not touch the guard before Monday 07:30 local, but still does the housekeeping', async () => {
    h.slot = {week: '2026-11-02', due: false};
    const {db, calls} = fakeDb({});
    expect((await runKnowledgeTick(db, 'https://shop.example', NOW)).started).toBeNull();
    expect(has(calls, 'INSERT INTO "knowledge_health_runs"')).toBe(false);
    expect(has(calls, 'stalled_runs')).toBe(true);
    expect(h.sends).toEqual([]);
  });

  it('deletes the guard row when the send is refused, so the next tick tries again', async () => {
    h.refuseSend = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const {db, calls} = fakeDb({});
    expect((await runKnowledgeTick(db, 'https://shop.example', NOW)).started).toBeNull();
    expect(guardDelete(calls)?.values).toEqual(['2026-11-09']);
    expect(warn).toHaveBeenCalledWith('[knowledge] weekly run not sent: E_JOBS_RATE_LIMITED');
  });

  it('reads an unknown stored zone as UTC (and says so), and a missing settings row as UTC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = fakeDb({timeZone: 'Bad/Zone'});
    await runKnowledgeTick(bad.db, 'https://shop.example', NOW);
    expect(warn).toHaveBeenCalledWith('[knowledge] unknown time zone, using UTC');
    expect(bad.calls.find(c => c.sql.includes('INSERT INTO "knowledge_health_runs"'))?.values[1]).toBe('UTC');

    const none = fakeDb({timeZone: null});
    await runKnowledgeTick(none.db, 'https://shop.example', NOW);
    expect(none.calls.find(c => c.sql.includes('INSERT INTO "knowledge_health_runs"'))?.values[1]).toBe('UTC');
  });

  it('re-sends at most 3 missed article drafts and stops at the first refusal', async () => {
    const due = [
      {id: 11, number: 1011},
      {id: 12, number: 1012},
      {id: 13, number: 1013},
    ];
    const all = fakeDb({due});
    expect((await runKnowledgeTick(all.db, 'https://shop.example', NOW)).draftsQueued).toBe(3);
    expect(h.queued).toEqual([11, 12, 13]);
    const sweep = all.calls.find(c => c.sql.includes('SELECT "id", "number" FROM "tickets"'));
    expect(sweep?.values).toEqual([3]);

    h.queued.length = 0;
    h.refuseDraftAt = 1;
    const refused = fakeDb({due});
    expect((await runKnowledgeTick(refused.db, 'https://shop.example', NOW)).draftsQueued).toBe(1);
    expect(h.queued).toEqual([11]);
  });

  it('runs at most 4 statements per tick: the settings and the sweep read together, then the housekeeping', async () => {
    const {db, calls} = fakeDb({due: [{id: 1, number: 1001}]});
    await runKnowledgeTick(db, 'https://shop.example', NOW);
    expect(calls.length).toBeLessThanOrEqual(4);
    // Both reads are sent before anything else (one round trip).
    expect(calls[0]!.sql).toContain('FROM "helpdesk_settings"');
    expect(calls[1]!.sql).toContain('SELECT "id", "number" FROM "tickets"');

    h.slot = {week: '2026-11-02', due: false};
    const quiet = fakeDb({});
    await runKnowledgeTick(quiet.db, 'https://shop.example', NOW);
    expect(quiet.calls).toHaveLength(3);
  });

  it('the housekeeping fails health drafts left pending for 15 minutes, in the same statement', async () => {
    const {db, calls} = fakeDb({});
    await runKnowledgeTick(db, 'https://shop.example', NOW);
    const housekeeping = calls.filter(c => c.sql.includes('stalled_runs'));
    expect(housekeeping).toHaveLength(1);
    const sql = housekeeping[0]!.sql;
    expect(sql).toContain('UPDATE "health_issues" SET "draft_state" = \'failed\', "draft_error" = \'failed\'');
    expect(sql).toMatch(/"state" = 'open' AND "draft_state" = 'pending' AND "updated_at" < now\(\) - interval '15 minutes'/);
  });
});

describe('knowledge health week input', () => {
  it('takes a real YYYY-MM-DD date only', () => {
    expect(parseWeek('2026-11-09')).toBe('2026-11-09');
    expect(parseWeek('2024-02-29')).toBe('2024-02-29');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-09', '2026-11-09T00:00', ' 2026-11-09', '', null, 20261109, {}]) {
      expect(parseWeek(bad)).toBeNull();
    }
  });
});
