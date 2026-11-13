import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {handleJobDelivery} from '../../src/platform/background';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {setAiProviderForTests, setCountTokensForTests} from '../../src/server/ai/provider';
import {background} from '../../src/server/background';
import {weekKey} from '../../src/server/helpdesk/state';
import {mondayBefore} from '../../src/server/helpdesk/weekly';
import {KB_EXTRACT_WORDS} from '../../src/server/kb/sources/pipeline';
import {setStoredFileReaderForTests} from '../../src/server/kb/sources/read';
import {env} from './support/cloudflare-workers';
import {configureEnv, DATABASE_URL, db, JOBS_SECRET, jobDelivery, resetDatabase, resetHelpdeskSettings, seedTickets} from './support/harness';

/** Jobs a handler sends are captured, never run inline (locally `sendJob` would run them at once). */
const sent = vi.hoisted(() => [] as {list: string; data: unknown}[]);
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown) => {
      sent.push({list, data});
      return {id: `job_w${sent.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});

/**
 * The background handlers wired end to end: a signed delivery through the platform's job endpoint
 * (`handleJobDelivery` with the site's `background`), not the functions called directly. Real Postgres.
 */
vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

const utf8 = new TextEncoder();
const FILE_ID = 'file_0123456789abcdefghijklmnop';
const UPLOADER = 4242;
let seq = 0;

const deliver = (list: string, data: unknown) =>
  inRequestScope(async () => {
    const res = await handleJobDelivery(jobDelivery({id: `job_wiring_${++seq}_${Date.now()}`, list, data}), background);
    await getDb()?.$disconnect();
    return res;
  });

/** 'YYYY-MM-DD' of a Date column (a UTC date). */
const day = (d: Date) => d.toISOString().slice(0, 10);

describe.skipIf(!DATABASE_URL)('background wiring: jobs delivered through the endpoint (integration, real Postgres)', () => {
  let categoryId: number;

  beforeAll(() => {
    configureEnv();
    env.SITE_JOBS_SECRET = JOBS_SECRET;
  });
  afterAll(async () => {
    delete env.SITE_JOBS_SECRET;
    setAiProviderForTests(null);
    setCountTokensForTests(null);
    setStoredFileReaderForTests(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    configureEnv();
    await resetDatabase();
    await resetHelpdeskSettings();
    sent.length = 0;
    setAiProviderForTests(async () => {
      throw new Error('no AI call expected in the wiring tests');
    });
    setCountTokensForTests(async () => {
      throw new Error('no count_tokens call expected in the wiring tests');
    });
    setStoredFileReaderForTests(async () => utf8.encode('# Returns\n\nSend it back within 30 days.\n\n# Shipping\n\nWe ship in 2 days.'));
    categoryId = (await db.kbCategory.create({data: {name: 'Help', slug: 'help'}, select: {id: true}})).id;
  });

  it('helpdesk-counters also writes the weekly report: rows for this week, the previous and the one before', async () => {
    const current = weekKey();
    const previous = mondayBefore(current, 1);
    const earlier = mondayBefore(current, 2);
    const older = mondayBefore(current, 3);
    const inWeek = (monday: string) => new Date(Date.parse(`${monday}T00:00:00Z`) + 3_600_000);
    // Solved tickets in each recomputed week (agent-solved: assumed), and one in a frozen week.
    for (const [monday, n] of [[current, 1], [previous, 2], [earlier, 3], [older, 4]] as const) {
      await seedTickets(n, {userId: null, status: 'solved', solvedAt: inWeek(monday)});
    }
    await db.conversation.updateMany({data: {resolution: 'assumed'}});
    // A frozen week's row (older than 3 weeks) is history: never recomputed.
    await db.helpdeskStatsWeekly.create({data: {week: new Date(`${older}T00:00:00Z`), ticketsSolved: 99}});

    const res = await deliver('helpdesk-counters', null);
    expect(res.status, await res.clone().text()).toBe(200);

    const rows = await db.helpdeskStatsWeekly.findMany({orderBy: {week: 'desc'}});
    expect(rows.map(r => [day(r.week), r.ticketsSolved, r.solvedAssumed, r.solvedConfirmed])).toEqual([
      [current, 1, 1, 0],
      [previous, 2, 2, 0],
      [earlier, 3, 3, 0],
      [older, 99, 0, 0],
    ]);
    // The tiles were recounted in the same run.
    expect((await db.helpdeskCounter.findUnique({where: {name: `solved:${current}`}}))?.value).toBe(1);
  });

  it('kb-extract {sourceId, round 0, step 0} for a Markdown file: 200 and the row drafted', async () => {
    const {id} = await db.kbSource.create({
      data: {fileId: FILE_ID, name: 'guide.md', kind: 'md', size: 1000, state: 'queued', categoryId, createdBy: UPLOADER},
      select: {id: true},
    });
    const res = await deliver('kb-extract', {sourceId: id, round: 0, step: 0});
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await db.kbSource.findUniqueOrThrow({where: {id}})).toMatchObject({state: 'drafted', draftsCreated: 2, error: ''});
    expect((await db.kbArticle.findMany({where: {sourceId: id}, orderBy: {id: 'asc'}})).map(a => [a.title, a.status])).toEqual([
      ['Returns', 'draft'],
      ['Shipping', 'draft'],
    ]);
    expect(sent).toEqual([]);
  });

  it('kb-sources-sweep without the site address: a 3 h old extracting row fails, and nothing is sent', async () => {
    delete env.SITE_URL;
    const stuck = await db.kbSource.create({
      data: {fileId: FILE_ID, name: 'guide.md', kind: 'md', size: 1000, state: 'extracting', categoryId, createdBy: UPLOADER},
      select: {id: true},
    });
    // Idle 20 minutes: a send would be due, but there is no address to send it to.
    const idle = await db.kbSource.create({
      data: {fileId: 'file_0123456789abcdefghijklmnoq', name: 'other.md', kind: 'md', size: 1000, state: 'extracting', categoryId, createdBy: UPLOADER},
      select: {id: true},
    });
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '3 hours' WHERE "id" = ${stuck.id}`;
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '20 minutes' WHERE "id" = ${idle.id}`;

    const res = await deliver('kb-sources-sweep', null);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await db.kbSource.findUniqueOrThrow({where: {id: stuck.id}})).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.stopped});
    expect((await db.kbSource.findUniqueOrThrow({where: {id: idle.id}})).state).toBe('extracting');
    expect(await db.auditEvent.count({where: {action: 'kb_file_failed', targetId: String(stuck.id)}})).toBe(1);
    expect(sent).toEqual([]);
  });
});
