import {readFileSync} from 'node:fs';

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {handleJobDelivery} from '../../src/platform/background';
import {setCacheModeForTests} from '../../src/platform/cache';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {background} from '../../src/server/background';
import {assumedCounter, confirmedCounter, confirmResolution, weekKey} from '../../src/server/helpdesk/state';
import {env} from './support/cloudflare-workers';
import {
  agentSay,
  configureEnv,
  customerSay,
  DATABASE_URL,
  db,
  groundTruthCounters,
  type HelpdeskCast,
  helpdeskCast,
  inParallel,
  JOBS_SECRET,
  jobDelivery,
  newKey,
  openTicket,
  resetDatabase,
  resetHelpdeskSettings,
  setStatus,
  storedCounters,
} from './support/harness';

/**
 * Confirmed vs assumed resolutions (owner decision 1): `confirmed:<week>` (the customer marked it
 * solved) and `assumed:<week>` (an agent solved it), by the UTC week of `tickets.solved_at`, kept on
 * write by state.ts in the same statement as the status change, upgraded assumed → confirmed when the
 * customer presses Solve on an agent-solved ticket (inside 14 days), recounted and pruned nightly.
 * After every case the kept counters equal a recount of the tickets. Real Postgres.
 */
const T = '/site-api/helpdesk/tickets';
const my = (n: number) => `/site-api/helpdesk/my/tickets/${n}`;
const DAY = 86_400_000;

// Sign-ups (scrypt) and parallel requests: the default 10 s hook timeout is too short on a busy machine.
vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

/** Every non-zero `confirmed:`/`assumed:` row, as {name: value}. */
async function storedResolutions(): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<{name: string; value: number}[]>`
    SELECT "name", "value" FROM "helpdesk_counters"
    WHERE ("name" LIKE 'confirmed:%' OR "name" LIKE 'assumed:%') AND "value" <> 0 ORDER BY "name"`;
  return Object.fromEntries(rows.map(r => [r.name, r.value]));
}

/** The same, recounted from the tickets: solved ones by resolution and the UTC week of solved_at. */
async function trueResolutions(): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<{name: string; value: number}[]>`
    SELECT c."resolution" || ':' || to_char(date_trunc('week', t."solved_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS name,
           count(*)::int AS value
    FROM "tickets" t JOIN "conversations" c ON c."id" = t."conversation_id"
    WHERE c."status" = 'solved' AND c."resolution" IN ('confirmed', 'assumed')
    GROUP BY 1 ORDER BY 1`;
  return Object.fromEntries(rows.map(r => [r.name, r.value]));
}

async function expectConsistent() {
  expect(await storedResolutions()).toEqual(await trueResolutions());
  expect(await storedCounters()).toEqual(await groundTruthCounters());
}

const W = () => weekKey();

async function resolutionOf(number: number): Promise<string> {
  const row = await db.ticket.findUniqueOrThrow({where: {number}, select: {conversation: {select: {resolution: true}}}});
  return row.conversation.resolution;
}

async function conversationIdOf(number: number): Promise<number> {
  return (await db.ticket.findUniqueOrThrow({where: {number}, select: {conversationId: true}})).conversationId;
}

/** Moves a solved ticket's solved_at back AND its solved:/resolution counters with it (as if solved then). */
async function solvedDaysAgo(number: number, days: number) {
  const at = new Date(Date.now() - days * DAY);
  const resolution = await resolutionOf(number);
  await db.ticket.update({where: {number}, data: {solvedAt: at}});
  for (const prefix of [resolution, 'solved']) {
    await db.$executeRaw`UPDATE "helpdesk_counters" SET "value" = "value" - 1 WHERE "name" = ${`${prefix}:${W()}`}`;
    await db.$executeRaw`
      INSERT INTO "helpdesk_counters" ("name", "value") VALUES (${`${prefix}:${weekKey(at)}`}, 1)
      ON CONFLICT ("name") DO UPDATE SET "value" = "helpdesk_counters"."value" + 1`;
  }
}

describe.skipIf(!DATABASE_URL)('resolution counters: confirmed vs assumed (integration, real Postgres)', () => {
  let cast: HelpdeskCast;

  beforeAll(() => {
    configureEnv();
    env.SITE_JOBS_SECRET = JOBS_SECRET;
  });
  afterAll(async () => {
    delete env.SITE_JOBS_SECRET;
    setCacheModeForTests(null);
    setAiProviderForTests(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    setCacheModeForTests('memory');
    await resetHelpdeskSettings();
    delete env.ANTHROPIC_API_KEY;
    setAiProviderForTests(async () => {
      throw new Error('no AI call expected in the resolution counter tests');
    });
    cast = await helpdeskCast(app, ['alice', 'bob', 'agentA', 'admin']);
  });

  it('an agent solve counts as assumed; a customer solve as confirmed; reply-with-solve as assumed', async () => {
    const [a, b, c] = [await openTicket(cast.alice), await openTicket(cast.alice), await openTicket(cast.bob)];
    expect((await setStatus(cast.agentA, a, 'waiting', 'solved')).status).toBe(200);
    expect((await cast.alice.post(`${my(b)}/solve`, {})).status).toBe(200);
    const reply = await agentSay(cast.agentA, c, 'This should fix it.', {setStatus: 'solved'});
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 2, [confirmedCounter(W())]: 1});
    await expectConsistent();
  });

  it('the customer presses Solve on an agent-solved ticket: assumed → confirmed in one go, once', async () => {
    const n = await openTicket(cast.alice);
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    expect(await resolutionOf(n)).toBe('assumed');
    const solvedAt = (await db.ticket.findUniqueOrThrow({where: {number: n}})).solvedAt;
    const before = await storedCounters();

    const res = await cast.alice.post(`${my(n)}/solve`, {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({status: 'solved', confirmed: true});
    expect(await resolutionOf(n)).toBe('confirmed');
    expect(await storedResolutions()).toEqual({[confirmedCounter(W())]: 1});
    // The ticket stays solved in the week it was solved; the other tiles don't move.
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}})).solvedAt).toEqual(solvedAt);
    expect(await storedCounters()).toEqual(before);
    await expectConsistent();

    // A second press changes nothing, says so, and writes no second audit row.
    const again = await cast.alice.post(`${my(n)}/solve`, {});
    expect(again.status).toBe(200);
    expect(again.json).toEqual({status: 'solved', confirmed: false});
    expect(await storedResolutions()).toEqual({[confirmedCounter(W())]: 1});
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_confirmed'}})).toBe(1);
    // The agent's solve is not audited again either, and no article-draft job ran for the press.
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_solved'}})).toBe(1);

    // My support shows it confirmed.
    expect((await cast.alice.get(my(n))).json.ticket).toMatchObject({status: 'solved', resolution: 'confirmed'});
  });

  it('another customer can\'t confirm it: 404, nothing moves', async () => {
    const n = await openTicket(cast.alice);
    await setStatus(cast.agentA, n, 'waiting', 'solved');
    expect((await cast.bob.post(`${my(n)}/solve`, {})).status).toBe(404);
    expect(await resolutionOf(n)).toBe('assumed');
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1});
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_confirmed'}})).toBe(0);
  });

  it('after the 14-day window an assumed resolution is final: the press changes nothing', async () => {
    const n = await openTicket(cast.alice);
    await setStatus(cast.agentA, n, 'waiting', 'solved');
    await solvedDaysAgo(n, 15);
    const before = await storedResolutions();
    expect(before).toEqual({[assumedCounter(weekKey(new Date(Date.now() - 15 * DAY)))]: 1});

    const res = await cast.alice.post(`${my(n)}/solve`, {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({status: 'solved', confirmed: false});
    expect(await resolutionOf(n)).toBe('assumed');
    expect(await storedResolutions()).toEqual(before);
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_confirmed'}})).toBe(0);
    // Straight at the function: null.
    expect(await confirmResolution(db, await conversationIdOf(n))).toBeNull();
  });

  it('inside the window but in an earlier week: the counters of THAT week move', async () => {
    const n = await openTicket(cast.alice);
    await setStatus(cast.agentA, n, 'waiting', 'solved');
    await solvedDaysAgo(n, 10);
    const week = weekKey(new Date(Date.now() - 10 * DAY));
    expect((await cast.alice.post(`${my(n)}/solve`, {})).status).toBe(200);
    expect(await storedResolutions()).toEqual({[confirmedCounter(week)]: 1});
    await expectConsistent();
  });

  it('10 presses at once move the counters once and audit once', async () => {
    const n = await openTicket(cast.alice);
    await setStatus(cast.agentA, n, 'waiting', 'solved');
    const results = await inParallel(10, () => cast.alice.post(`${my(n)}/solve`, {}));
    expect(results.map(r => r.status)).toEqual(Array(10).fill(200));
    // Exactly one press did it; the others say nothing changed.
    expect(results.filter(r => r.json.confirmed === true)).toHaveLength(1);
    for (const r of results) expect(r.json.status).toBe('solved');
    expect(await storedResolutions()).toEqual({[confirmedCounter(W())]: 1});
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_confirmed'}})).toBe(1);
    await expectConsistent();
  });

  it('confirm against an agent reopen, at once, many times: one order wins and the counters agree', async () => {
    const tickets: number[] = [];
    for (let i = 0; i < 6; i++) tickets.push(await openTicket(cast.alice, `Problem ${i}`));
    for (const n of tickets) expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    const results = await Promise.all(
      tickets.flatMap(n => [cast.alice.post(`${my(n)}/solve`, {}), setStatus(cast.agentA, n, 'solved', 'open')])
    );
    expect(results.map(r => r.status).filter(s => s !== 200)).toEqual([]);
    for (const [i, n] of tickets.entries()) {
      const row = await db.ticket.findUniqueOrThrow({where: {number: n}, select: {solvedAt: true, conversation: {select: {status: true, resolution: true}}}});
      const press = results[i * 2]!.json as {status: string; confirmed: boolean};
      // Every reopen succeeds (from solved). Either the press came first or found it still solved
      // (confirmed, or nothing, then undone by the reopen: open), or the press saw the reopen first
      // and solved it again as confirmed (solved). Both are valid; the press answers what it is now.
      if (row.conversation.status === 'open') {
        expect(row.conversation.resolution).toBe('none');
        expect(row.solvedAt).toBeNull();
      } else {
        expect(row.conversation).toEqual({status: 'solved', resolution: 'confirmed'});
        expect(row.solvedAt).not.toBeNull();
        expect(press).toEqual({status: 'solved', confirmed: true});
      }
      expect(['open', 'solved']).toContain(press.status);
    }
    await expectConsistent();
  });

  it('reply-with-solve sent twice with the same key counts once (an idempotent replay moves nothing)', async () => {
    const n = await openTicket(cast.alice);
    const key = newKey();
    const first = await agentSay(cast.agentA, n, 'This should fix it.', {setStatus: 'solved', key});
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const replay = await agentSay(cast.agentA, n, 'This should fix it.', {setStatus: 'solved', key});
    expect(replay.status, JSON.stringify(replay.json)).toBe(201);
    const idOf = (r: {json: unknown}) => (r.json as {message: {id: string}}).message.id;
    expect(idOf(replay)).toBe(idOf(first));
    expect(await db.message.count({where: {conversation: {ticket: {is: {number: n}}}, sender: 'agent'}})).toBe(1);
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1});
    await expectConsistent();
  });

  it('a reopen takes 1 off the old resolution\'s week; solving again counts in this week', async () => {
    const n = await openTicket(cast.alice);
    await cast.alice.post(`${my(n)}/solve`, {}); // confirmed, this week
    await solvedDaysAgo(n, 8);
    const old = weekKey(new Date(Date.now() - 8 * DAY));
    expect(await storedResolutions()).toEqual({[confirmedCounter(old)]: 1});

    // The customer reopens it with a reply (inside 14 days): the old week's confirmed goes.
    expect((await customerSay(cast.alice, n, 'Actually it broke again.')).status).toBe(201);
    expect(await storedResolutions()).toEqual({});
    await expectConsistent();

    // An agent solves it now: assumed, this week.
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1});
    await expectConsistent();
  });

  it('deleting a solved ticket takes it out of its resolution counter; an unsolved one moves none', async () => {
    const [a, b, c] = [await openTicket(cast.alice), await openTicket(cast.alice), await openTicket(cast.bob)];
    await setStatus(cast.agentA, a, 'waiting', 'solved');
    await cast.alice.post(`${my(b)}/solve`, {});
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1, [confirmedCounter(W())]: 1});
    for (const n of [a, b, c]) expect((await cast.admin.request('DELETE', `${T}/${n}`)).status).toBe(200);
    expect(await storedResolutions()).toEqual({});
    await expectConsistent();
  });

  it('the nightly recount fixes drifted resolution counters, is a no-op twice, and prunes all three prefixes', async () => {
    const [a, b, c] = [await openTicket(cast.alice), await openTicket(cast.alice), await openTicket(cast.bob)];
    await setStatus(cast.agentA, a, 'waiting', 'solved');
    await setStatus(cast.agentA, b, 'waiting', 'solved');
    await cast.bob.post(`${my(c)}/solve`, {});
    await cast.alice.post(`${my(b)}/solve`, {}); // upgrade: assumed 1, confirmed 2
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1, [confirmedCounter(W())]: 2});

    // Drift on this week's rows, plus rows older and newer than 8 weeks.
    await db.$executeRaw`UPDATE "helpdesk_counters" SET "value" = 40 WHERE "name" IN (${confirmedCounter(W())}, ${assumedCounter(W())})`;
    const old = weekKey(new Date(Date.now() - 9 * 7 * DAY));
    const kept = weekKey(new Date(Date.now() - 7 * 7 * DAY));
    await db.helpdeskCounter.createMany({
      data: ['solved', 'confirmed', 'assumed'].flatMap(p => [
        {name: `${p}:${old}`, value: 3},
        {name: `${p}:${kept}`, value: 0},
      ]),
    });

    const run = (id: string) =>
      inRequestScope(async () => {
        const res = await handleJobDelivery(jobDelivery({id, list: 'helpdesk-counters', data: null}), background);
        await getDb()?.$disconnect();
        return res;
      });
    expect((await run('job_recount_res_1')).status).toBe(200);
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 1, [confirmedCounter(W())]: 2});
    await expectConsistent();
    const names = (await db.helpdeskCounter.findMany({select: {name: true}})).map(r => r.name);
    for (const p of ['solved', 'confirmed', 'assumed']) {
      expect(names, p).not.toContain(`${p}:${old}`);
      expect(names, p).toContain(`${p}:${kept}`);
    }
    const before = await db.helpdeskCounter.findMany({orderBy: {name: 'asc'}, select: {name: true, value: true}});
    expect((await run('job_recount_res_2')).status).toBe(200);
    expect(await db.helpdeskCounter.findMany({orderBy: {name: 'asc'}, select: {name: true, value: true}})).toEqual(before);
  });

  it('the recount running alongside confirms and solves never loses a change', async () => {
    const tickets: number[] = [];
    for (let i = 0; i < 6; i++) tickets.push(await openTicket(i % 2 ? cast.alice : cast.bob, `Thing ${i}`));
    for (const n of tickets.slice(0, 3)) await setStatus(cast.agentA, n, 'waiting', 'solved');
    const recount = () =>
      inRequestScope(async () => {
        const res = await handleJobDelivery(jobDelivery({id: `job_recount_mix_${Math.random()}`, list: 'helpdesk-counters', data: null}), background);
        await getDb()?.$disconnect();
        return res;
      });
    const results = await Promise.all([
      recount(),
      ...tickets.slice(0, 3).map((n, i) => (i % 2 ? cast.alice : cast.bob).post(`${my(n)}/solve`, {})),
      ...tickets.slice(3).map(n => setStatus(cast.agentA, n, 'waiting', 'solved')),
      recount(),
    ]);
    expect(results.map(r => r.status).filter(s => s !== 200)).toEqual([]);
    await expectConsistent();
    expect(await storedResolutions()).toEqual({[assumedCounter(W())]: 3, [confirmedCounter(W())]: 3});
  });

  it('background.json: 11 lists and 5 schedules; files are read one at a time; no weekly-stats schedule', () => {
    const config = JSON.parse(readFileSync('background.json', 'utf8')) as {
      lists: Record<string, {retries: number; concurrency: number}>;
      schedules: Record<string, {cron?: string; label?: string; list?: string}>;
    };
    expect(Object.keys(config.lists)).toHaveLength(11);
    expect(Object.keys(config.schedules)).toHaveLength(5);
    expect(config.lists['kb-extract']).toEqual({retries: 3, concurrency: 1});
    expect(config.lists['kb-sources-sweep']).toEqual({retries: 1, concurrency: 1});
    expect(config.schedules['kb-sources-sweep']?.cron).toBe('7,22,37,52 * * * *');
    expect(Object.keys(config.lists)).not.toContain('helpdesk-stats-weekly');
    // Every list has a handler, and every handler a list.
    expect(Object.keys(background.handlers).sort()).toEqual(Object.keys(config.lists).sort());
  });

  it('a kb-extract job with bad data is not retried', async () => {
    for (const data of [null, {sourceId: 0, round: 0, step: 0}, {sourceId: 1, round: -1, step: 0}, {sourceId: 1, round: 0, step: 1.5}, {sourceId: '1', round: 0, step: 0}]) {
      const res = await inRequestScope(async () => {
        const r = await handleJobDelivery(jobDelivery({id: `job_bad_${Math.random()}`, list: 'kb-extract', data}), background);
        await getDb()?.$disconnect();
        return r;
      });
      // DontRetry: 422, the platform fails it at once (a 500 would be retried).
      expect(res.status, JSON.stringify(data)).toBe(422);
      expect(await res.text(), JSON.stringify(data)).toMatch(/Bad file job/);
    }
  });
});
