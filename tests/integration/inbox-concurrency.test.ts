import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {setCacheModeForTests} from '../../src/platform/cache';
import {inRequestScope} from '../../src/platform/request-scope';
import {handleJobDelivery} from '../../src/platform/background';
import {getDb} from '../../src/platform/db';
import {setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {background} from '../../src/server/background';
import {weekKey} from '../../src/server/helpdesk/state';
import {env} from './support/cloudflare-workers';
import {
  agentSay,
  type Browser,
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
  seedTickets,
  setStatus,
  signedIn,
  statusOf,
  storedCounters,
} from './support/harness';

/**
 * The races the database must decide (docs/agent/orders-and-stock.md › Prove it): two agents
 * assigning at once, many solves of one ticket, a solve against the customer's reply, deletes
 * against changes, a storm of mixed changes — and after each, the kept tiles equal a recount
 * of the tickets. Plus what an account deletion leaves (the ticket, anonymised) and the
 * nightly recount. Real Postgres, many requests in flight together.
 */
const T = '/site-api/helpdesk/tickets';

/** A small seeded PRNG (mulberry32): the same storm for the same seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every non-zero `confirmed:`/`assumed:` row, as {name: value} (copied from resolution-counters.test.ts). */
async function storedResolutions(): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<{name: string; value: number}[]>`
    SELECT "name", "value" FROM "helpdesk_counters"
    WHERE ("name" LIKE 'confirmed:%' OR "name" LIKE 'assumed:%') AND "value" <> 0 ORDER BY "name"`;
  return Object.fromEntries(rows.map(r => [r.name, r.value]));
}

/** The same, recounted from the tickets: solved ones by resolution and the UTC week of solved_at (copied too). */
async function trueResolutions(): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<{name: string; value: number}[]>`
    SELECT c."resolution" || ':' || to_char(date_trunc('week', t."solved_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS name,
           count(*)::int AS value
    FROM "tickets" t JOIN "conversations" c ON c."id" = t."conversation_id"
    WHERE c."status" = 'solved' AND c."resolution" IN ('confirmed', 'assumed')
    GROUP BY 1 ORDER BY 1`;
  return Object.fromEntries(rows.map(r => [r.name, r.value]));
}

// Each test signs up several accounts (scrypt) and runs requests in parallel: on a busy machine the
// default 10 s hook timeout is too short, and a timed-out beforeEach keeps running into the next test.
vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

describe.skipIf(!DATABASE_URL)('help desk under concurrency (integration, real Postgres)', () => {
  let cast: HelpdeskCast;

  const assign = (who: Browser, n: number, from: number | null, to: number | null) => who.post(`${T}/${n}/assignee`, {from, to});
  /** The kept tiles AND the confirmed:/assumed: rows equal a recount; the route shows them. */
  const expectTilesTrue = async (why: string) => {
    const truth = await groundTruthCounters();
    expect(await storedCounters(), why).toEqual(truth);
    const resolutions = await trueResolutions();
    expect(await storedResolutions(), `${why} (resolutions)`).toEqual(resolutions);
    const tiles = (await cast.agentA.get(`${T}/tiles`)).json;
    expect(tiles, `${why} (tiles route)`).toMatchObject({
      ...truth,
      confirmedThisWeek: resolutions[`confirmed:${weekKey()}`] ?? 0,
      assumedThisWeek: resolutions[`assumed:${weekKey()}`] ?? 0,
    });
    expect(Array.isArray(tiles.waitingLongest), why).toBe(true);
  };

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
      throw new Error('no AI call expected here');
    });
    cast = await helpdeskCast(app, ['alice', 'bob', 'agentA', 'agentB', 'admin']);
  });

  it('two agents take the same ticket at once, 20 times: exactly one wins each, one audit row each', async () => {
    const numbers = await seedTickets(20, {userId: cast.ids.alice});
    for (const n of numbers) {
      const [a, b] = await Promise.all([assign(cast.agentA, n, null, cast.ids.agentA), assign(cast.agentB, n, null, cast.ids.agentB)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, `#${n} ${JSON.stringify([a.json, b.json])}`).toEqual([200, 409]);
      const winner = a.status === 200 ? cast.ids.agentA : cast.ids.agentB;
      const stored = await db.ticket.findUniqueOrThrow({where: {number: n}, select: {assigneeId: true}});
      expect(stored.assigneeId).toBe(winner);
    }
    const events = await db.auditEvent.groupBy({by: ['targetId'], where: {action: 'helpdesk_ticket_assigned'}, _count: {_all: true}});
    expect(events).toHaveLength(20);
    expect(events.every(e => e._count._all === 1)).toBe(true);
  });

  it('the loser of an assign race is told who has it (409 carries the current assignee)', async () => {
    const [n] = await seedTickets(1, {userId: cast.ids.alice});
    expect((await assign(cast.agentA, n!, null, cast.ids.agentA)).status).toBe(200);
    const stale = await assign(cast.agentB, n!, null, cast.ids.agentB);
    expect(stale.status).toBe(409);
    expect(stale.json.assignee).toEqual({id: cast.ids.agentA, name: 'agent-a'});
  });

  it('20 solves of one ticket at once: one 200, 19 × 409; the tiles move once', async () => {
    const n = await openTicket(cast.alice);
    const results = await inParallel(20, i => setStatus(i % 2 ? cast.agentA : cast.agentB, n, 'waiting', 'solved'));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(19);
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_solved'}})).toBe(1);
    expect(await storedCounters()).toEqual({unsolved: 0, waitingOnUs: 0, solvedThisWeek: 1});
    await expectTilesTrue('after 20 solves');
  });

  it('20 agent replies at once, each moving waiting → pending: one is sent, 19 told it changed, nothing half-saved', async () => {
    const n = await openTicket(cast.alice);
    const results = await inParallel(20, i => agentSay(i % 2 ? cast.agentA : cast.agentB, n, `Reply ${i}`, {expectedStatus: 'waiting'}));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(19);
    expect(await db.message.count({where: {body: {startsWith: 'Reply '}}})).toBe(1);
    expect(await statusOf(n)).toBe('pending');
    await expectTilesTrue('after 20 replies');
  });

  it('20 customer replies at once (distinct keys): all stored, the ticket ends waiting, tiles right', async () => {
    const n = await openTicket(cast.alice);
    expect((await agentSay(cast.agentA, n, 'A question for you')).status).toBe(201);
    const results = await inParallel(20, i => customerSay(cast.alice, n, `Answer ${i}`));
    // Each reply re-reads the status under the idempotency transaction: the first moves
    // pending → waiting, the rest find waiting. Any 409 is a retryable "changed", never a lost row.
    const ok = results.filter(r => r.status === 201).length;
    expect(results.every(r => r.status === 201 || r.status === 409), JSON.stringify(results.map(r => r.status))).toBe(true);
    expect(await db.message.count({where: {body: {startsWith: 'Answer '}}})).toBe(ok);
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(await statusOf(n)).toBe('waiting');
    await expectTilesTrue('after 20 customer replies');
  });

  it('an agent solving while the customer replies, 15 times: never a lost reply, never a reply hidden under "solved"', async () => {
    for (let i = 0; i < 15; i++) {
      const n = await openTicket(cast.alice, `Race ${i}`);
      expect((await agentSay(cast.agentA, n, 'Anything else?')).status).toBe(201); // → pending
      const [solve, reply] = await Promise.all([setStatus(cast.agentB, n, 'pending', 'solved'), customerSay(cast.alice, n, `Yes, one more thing ${i}`)]);
      const rows = await db.message.count({where: {body: `Yes, one more thing ${i}`}});
      const status = await statusOf(n);
      expect([200, 409]).toContain(solve.status);
      expect([201, 409]).toContain(reply.status);
      if (reply.status === 201) {
        // Stored, and the ticket is with the team again, whatever order they ran in.
        expect(rows, `run ${i}`).toBe(1);
        expect(status, `run ${i}`).toBe('waiting');
      } else {
        expect(rows, `run ${i}`).toBe(0);
      }
      if (solve.status === 200 && reply.status === 409) expect(status).toBe('solved');
      expect(solve.status === 409 && reply.status === 409, `run ${i}: both refused`).toBe(false);
    }
    await expectTilesTrue('after the solve/reply races');
  });

  it('delete racing a status change, 10 times: one of them, and the tiles stay right', async () => {
    for (let i = 0; i < 10; i++) {
      const n = await openTicket(i % 2 ? cast.alice : cast.bob, `Delete race ${i}`);
      const [del, solve] = await Promise.all([cast.admin.delete(`${T}/${n}`), setStatus(cast.agentA, n, 'waiting', 'solved')]);
      expect(del.status, `run ${i}`).toBe(200);
      expect([200, 404, 409]).toContain(solve.status);
      expect(await db.ticket.count({where: {number: n}})).toBe(0);
    }
    await expectTilesTrue('after delete races');
  });

  for (const seed of [7, 1234]) {
    it(`a storm of mixed changes (seed ${seed}): the kept tiles equal a recount`, async () => {
      const customers = [cast.alice, cast.bob, await signedIn(app, `carol${seed}@example.test`, undefined, '203.0.113.141'), await signedIn(app, `dan${seed}@example.test`, undefined, '203.0.113.142')];
      // 4 customers × 5 hand-offs, all at once.
      const handoffs = await Promise.all(customers.flatMap((who, c) => Array.from({length: 5}, (_, i) => openTicket(who, `Storm ${c}-${i}`))));
      expect(new Set(handoffs).size).toBe(20);
      await expectTilesTrue('after 20 hand-offs');
      expect(await storedCounters()).toEqual({unsolved: 20, waitingOnUs: 20, solvedThisWeek: 0});

      const owner = new Map(handoffs.map((n, i) => [n, customers[Math.floor(i / 5)]!]));
      const rand = prng(seed);
      const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
      for (let round = 0; round < 3; round++) {
        const live = (await db.ticket.findMany({select: {number: true, conversation: {select: {status: true}}}})).map(t => ({n: t.number, status: t.conversation.status}));
        const ops = Array.from({length: 30}, () => {
          const t = pick(live);
          const agent = rand() < 0.5 ? cast.agentA : cast.agentB;
          const r = rand();
          const tag = <R>(label: string, p: Promise<R>) => p.then(res => ({label: `${label} #${t.n} (${t.status})`, res}));
          if (r < 0.25) return tag('solve', setStatus(agent, t.n, t.status, 'solved'));
          if (r < 0.4) return tag('pending', setStatus(agent, t.n, t.status, 'pending'));
          if (r < 0.5) return tag('open', setStatus(agent, t.n, t.status, 'open'));
          if (r < 0.7) return tag('customer reply', customerSay(owner.get(t.n)!, t.n, `Storm reply ${rand()}`));
          if (r < 0.85) return tag('agent reply', agentSay(agent, t.n, `Agent storm ${rand()}`, {expectedStatus: t.status, setStatus: pick(['open', 'pending', 'solved'])}));
          if (r < 0.92) return tag('note', agentSay(agent, t.n, `Note ${rand()}`, {kind: 'note'}));
          return tag('delete', cast.admin.delete(`${T}/${t.n}`));
        });
        const results = await Promise.all(ops);
        const bad = results.filter(({res}) => res.status >= 500 || ![200, 201, 404, 409, 422].includes(res.status));
        const all = results.map(({label, res}) => `${label}: ${res.status}`).join('\n');
        // Whatever failed rolled back whole: the tiles still equal a recount.
        await expectTilesTrue(`seed ${seed} round ${round}`);
        expect(bad.map(({label, res}) => [label, res.status]), `round ${round}\n${all}`).toEqual([]);
      }
    });
  }

  it('a customer deletes their account: their tickets stay for the team, anonymised; the tiles do not drift', async () => {
    const open = await openTicket(cast.alice, 'Open one');
    const solved = await openTicket(cast.alice, 'Solved one');
    const bobs = await openTicket(cast.bob, 'Bob keeps his');
    expect((await setStatus(cast.agentA, solved, 'waiting', 'solved')).status).toBe(200);
    const before = await storedCounters();

    const res = await cast.alice.post('/site-api/auth/delete-account', {password: 'a long test passphrase', confirm: 'DELETE'});
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    // Nothing cascaded: the conversations and their lines are there, with no owner.
    const rows = await db.conversation.findMany({where: {ticket: {is: {number: {in: [open, solved]}}}}, select: {userId: true, messages: {select: {id: true}}}});
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.userId === null && r.messages.length > 0)).toBe(true);
    expect(await storedCounters()).toEqual(before);
    await expectTilesTrue('after the account deletion');

    // The team still works them.
    const list = await cast.agentA.get(`${T}?queue=waiting`);
    expect(list.status).toBe(200);
    expect((list.json.items as {number: number; customer: {id: number | null; name: string}}[]).find(r => r.number === open)?.customer).toEqual({id: null, name: 'Deleted customer'});
    expect((await cast.agentA.get(`${T}/${solved}`)).status).toBe(200);
    expect((await agentSay(cast.agentA, open, 'Closing this out.', {setStatus: 'solved'})).status).toBe(201);
    await expectTilesTrue('after working a deleted customer\'s ticket');
    // No one else's My support shows them.
    const bobList = (await cast.bob.get('/site-api/helpdesk/my/tickets')).json.items as {number: number}[];
    expect(bobList.map(r => r.number)).toEqual([bobs]);
  });

  it('week rollover: reopening a ticket solved last week takes it from last week, not this one', async () => {
    const n = await openTicket(cast.alice);
    const other = await openTicket(cast.bob);
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    expect((await setStatus(cast.agentA, other, 'waiting', 'solved')).status).toBe(200);
    // Move ticket n's solve into last week, as if it had happened then (ticket and counters both:
    // `solved:` and its resolution's `assumed:` — an agent solved it).
    const lastWeek = new Date(Date.now() - 7 * 86400_000);
    await db.ticket.update({where: {number: n}, data: {solvedAt: lastWeek}});
    for (const prefix of ['solved', 'assumed']) {
      await db.$executeRaw`UPDATE "helpdesk_counters" SET "value" = "value" - 1 WHERE "name" = ${`${prefix}:${weekKey()}`}`;
      await db.$executeRaw`INSERT INTO "helpdesk_counters" ("name", "value") VALUES (${`${prefix}:${weekKey(lastWeek)}`}, 1)
        ON CONFLICT ("name") DO UPDATE SET "value" = 1`;
    }
    expect(await storedResolutions()).toEqual({[`assumed:${weekKey(lastWeek)}`]: 1, [`assumed:${weekKey()}`]: 1});
    expect(await storedCounters()).toEqual({unsolved: 0, waitingOnUs: 0, solvedThisWeek: 1});

    expect((await setStatus(cast.agentA, n, 'solved', 'open')).status).toBe(200);
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 1, solvedThisWeek: 1});
    const last = await db.helpdeskCounter.findMany({where: {name: {in: [`solved:${weekKey(lastWeek)}`, `assumed:${weekKey(lastWeek)}`]}}, select: {value: true}});
    expect(last.map(row => row.value)).toEqual([0, 0]);
    expect(await storedResolutions()).toEqual({[`assumed:${weekKey()}`]: 1});
    await expectTilesTrue('after the rollover');
  });

  it('the nightly recount repairs drifted tiles and prunes old presence rows; running it twice changes nothing', async () => {
    const a = await openTicket(cast.alice);
    await openTicket(cast.bob);
    await setStatus(cast.agentA, a, 'waiting', 'solved');
    await cast.agentA.post(`${T}/${a}/presence`, {});
    await db.ticketView.updateMany({data: {viewedAt: new Date(Date.now() - 8 * 86400_000)}});
    await cast.agentB.post(`${T}/${a}/presence`, {});
    // Drift, as a bug or a manual edit would leave it.
    await db.$executeRaw`UPDATE "helpdesk_counters" SET "value" = 99`;
    const run = (id: string) =>
      inRequestScope(async () => {
        const res = await handleJobDelivery(jobDelivery({id, list: 'helpdesk-counters', data: null}), background);
        await getDb()?.$disconnect();
        return res;
      });
    expect((await run('job_recount_1')).status).toBe(200);
    expect(await storedCounters()).toEqual(await groundTruthCounters());
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 1, solvedThisWeek: 1});
    expect(await db.ticketView.count()).toBe(1);
    expect((await run('job_recount_2')).status).toBe(200);
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 1, solvedThisWeek: 1});
  });

  it('two hand-offs per customer with new keys and one repeated key, all at once, across customers: tickets = distinct keys', async () => {
    const shared = newKey();
    const results = await Promise.all([
      ...Array.from({length: 5}, () => cast.alice.request('POST', '/site-api/helpdesk/conversations', {key: shared, transcript: [{role: 'customer', text: 'Same key'}]})),
      ...Array.from({length: 5}, () => cast.bob.request('POST', '/site-api/helpdesk/conversations', {key: shared, transcript: [{role: 'customer', text: 'Same key'}]})),
      // From another connection: alice's own five above fill this one's 5-a-minute window.
      cast.alice.request('POST', '/site-api/helpdesk/conversations', {key: newKey(), transcript: [{role: 'customer', text: 'Other'}]}, {'cf-connecting-ip': '198.51.100.77'}),
    ]);
    expect(results.map(r => r.status).filter(st => st !== 200 && st !== 201)).toEqual([]);
    expect(await db.ticket.count()).toBe(3);
    await expectTilesTrue('after mixed hand-offs');
  });
});
