import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {setCacheModeForTests} from '../../src/platform/cache';
import {setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {deleteOldRateWindows} from '../../src/server/rate-window';
import {env} from './support/cloudflare-workers';
import {
  agentSay,
  configureEnv,
  customerSay,
  DATABASE_URL,
  db,
  expectNoLeak,
  groundTruthCounters,
  type HelpdeskCast,
  helpdeskCast,
  inParallel,
  newKey,
  openTicket,
  resetDatabase,
  resetHelpdeskSettings,
  seedTickets,
  setRateWindow,
  setStatus,
  statusOf,
  storedCounters,
} from './support/harness';

/**
 * "My support" (/site-api/helpdesk/my/*): a customer's own tickets, never anyone else's, never
 * the team's internal notes or the AI summary; replies with an hourly limit; reopening a solved
 * ticket; the rating once. Real Postgres; AI off (no key) so no summary call is made.
 */
const NOTE = 'NOTE-SENTINEL-7f3a';
const SUMMARY = 'SUMMARY-SENTINEL-91c2';
const SOURCE = 'SOURCE-SENTINEL-55d0';

type MyRow = {number: number; subject: string; status: string; unread: boolean; lastMessageAt: string; createdAt: string};
type Thread = {messages: {id: string; sender: string; author: string | null; body: string; citations: unknown[]; confidence: string | null; createdAt: string}[]; nextBefore: string | null};
type MyTicket = {number: number; status: string; resolution: string; csat: number | null; canReply: boolean; canRate: boolean; thread: Thread};

// Each test signs up several accounts (scrypt) and runs requests in parallel: on a busy machine the
// default 10 s hook timeout is too short, and a timed-out beforeEach keeps running into the next test.
vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

describe.skipIf(!DATABASE_URL)('My support (integration, real Postgres)', () => {
  let cast: HelpdeskCast;
  const my = (n: number | string) => `/site-api/helpdesk/my/tickets/${n}`;

  beforeAll(configureEnv);
  afterAll(async () => {
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
      throw new Error('no AI call expected in My support tests');
    });
    cast = await helpdeskCast(app, ['alice', 'bob', 'agentA']);
  });

  it('every customer route: signed out 401', async () => {
    const n = await openTicket(cast.alice);
    const routes: [string, string, unknown?][] = [
      ['GET', '/site-api/helpdesk/my/tickets'],
      ['GET', '/site-api/helpdesk/my/unread'],
      ['GET', my(n)],
      ['POST', `${my(n)}/seen`, {}],
      ['POST', `${my(n)}/messages`, {body: 'Hello?', key: newKey()}],
      ['POST', `${my(n)}/solve`, {}],
      ['POST', `${my(n)}/csat`, {score: 5}],
    ];
    for (const [method, path, body] of routes) {
      const res = await cast.guest.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(await db.message.count()).toBe(1);
  });

  it('another customer\'s ticket is a 404 identical to a missing one, and nothing is written', async () => {
    const n = await openTicket(cast.alice, 'Alice private problem');
    const missing = await cast.bob.get(my(99999));
    const theirs = await cast.bob.get(my(n));
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(theirs.json).toEqual(missing.json);
    expect((await cast.bob.get(my('abc'))).status).toBe(404);

    expect((await customerSay(cast.bob, n, 'I am not alice')).status).toBe(404);
    expect((await cast.bob.post(`${my(n)}/csat`, {score: 1})).status).toBe(404);
    expect([404, 409]).toContain((await cast.bob.post(`${my(n)}/solve`, {})).status);
    await cast.bob.post(`${my(n)}/seen`, {});
    expect(await db.message.count()).toBe(1);
    expect(await statusOf(n)).toBe('waiting');

    // bob's list never shows it.
    const list = await cast.bob.get('/site-api/helpdesk/my/tickets');
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([]);
    expectNoLeak(list.json, ['Alice private problem']);
  });

  it('staff get no wider view through the customer routes: an agent sees only their own tickets there', async () => {
    const aliceTicket = await openTicket(cast.alice);
    const own = await openTicket(cast.agentA, 'My own question as a customer');
    const list = await cast.agentA.get('/site-api/helpdesk/my/tickets');
    expect((list.json.items as MyRow[]).map(r => r.number)).toEqual([own]);
    expect((await cast.agentA.get(my(aliceTicket))).status).toBe(404);
    expect((await customerSay(cast.agentA, aliceTicket, 'hi')).status).toBe(404);
    expect((await cast.agentA.post(`${my(aliceTicket)}/csat`, {score: 5})).status).toBe(404);
  });

  it('the thread never holds internal notes, the AI summary, its sources or anyone\'s email', async () => {
    const n = await openTicket(cast.alice);
    await db.ticket.update({
      where: {number: n},
      data: {aiSummary: SUMMARY, aiSummaryState: 'ready', aiSources: [{id: null, title: SOURCE, url: '/help/articles/x/'}]},
    });
    const before = await cast.alice.get('/site-api/helpdesk/my/tickets');
    const note = await agentSay(cast.agentA, n, NOTE, {kind: 'note'});
    expect(note.status, JSON.stringify(note.json)).toBe(201);
    // A note changes nothing the customer can see: not the list, not the order, not the unread flag.
    const after = await cast.alice.get('/site-api/helpdesk/my/tickets');
    expect(after.json).toEqual(before.json);
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 0});

    const reply = await agentSay(cast.agentA, n, 'Thanks, we are sending a replacement.');
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);

    const res = await cast.alice.get(my(n));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
    expectNoLeak(res.json, [NOTE, SUMMARY, SOURCE, '@example.test', 'aiSummary', 'aiSources', 'assignee', '"note"']);
    const ticket = res.json.ticket as MyTicket;
    expect(ticket.thread.messages.map(m => m.sender).sort()).toEqual(['agent', 'customer']);
    for (const m of ticket.thread.messages) {
      expect(Object.keys(m).sort()).toEqual(['author', 'body', 'citations', 'confidence', 'createdAt', 'id', 'sender']);
      expect(m.confidence).toBeNull();
    }
    expect(ticket.thread.messages.find(m => m.sender === 'agent')!.author).toBe('agent-a');
    expectNoLeak(await cast.alice.get('/site-api/helpdesk/my/tickets'), [NOTE, SUMMARY, '@example.test']);
  });

  it('unread: an agent reply sets it, "seen" clears it; a note never does', async () => {
    const n = await openTicket(cast.alice);
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 0});
    expect((await agentSay(cast.agentA, n, 'We are on it.')).status).toBe(201);
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 1});
    const row = ((await cast.alice.get('/site-api/helpdesk/my/tickets')).json.items as MyRow[])[0]!;
    expect(row).toMatchObject({number: n, unread: true, status: 'pending'});
    // GET never writes: reading the ticket keeps it unread until the screen says "seen".
    await cast.alice.get(my(n));
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 1});
    expect((await cast.alice.post(`${my(n)}/seen`, {})).status).toBe(200);
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 0});
    expect((await agentSay(cast.agentA, n, NOTE, {kind: 'note', expectedStatus: 'pending'})).status).toBe(201);
    expect((await cast.alice.get('/site-api/helpdesk/my/unread')).json).toEqual({count: 0});
  });

  it('a reply: stored once per key, moves the ticket back to waiting, a changed body with the same key is refused', async () => {
    const n = await openTicket(cast.alice);
    expect((await agentSay(cast.agentA, n, 'Can you send a photo?')).status).toBe(201);
    expect(await statusOf(n)).toBe('pending');
    const key = newKey();
    const [one, two] = await Promise.all([customerSay(cast.alice, n, 'Here it is.', key), customerSay(cast.alice, n, 'Here it is.', key)]);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(one.json).toEqual(two.json);
    expect((one.json as {status: string}).status).toBe('waiting');
    expect(await db.message.count({where: {body: 'Here it is.'}})).toBe(1);
    expect(await statusOf(n)).toBe('waiting');
    expect((await customerSay(cast.alice, n, 'Something different', key)).status).toBe(409);
    expect(await storedCounters()).toEqual(await groundTruthCounters());
  });

  it('a reply validates its body: empty, too long, control characters → 422; never a note', async () => {
    const n = await openTicket(cast.alice);
    for (const body of ['', '   ', 'x'.repeat(4001), 'bad \u0007 bell', 42]) {
      const res = await cast.alice.post(`${my(n)}/messages`, {body, key: newKey()});
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const sneaky = await cast.alice.post(`${my(n)}/messages`, {body: 'Plain words', key: newKey(), kind: 'note', internal: true, sender: 'agent'});
    expect([201, 422]).toContain(sneaky.status);
    expect(await db.message.count({where: {sender: {in: ['note', 'agent']}}})).toBe(0);
  });

  it('stored text comes back verbatim (plain text, never HTML)', async () => {
    const n = await openTicket(cast.alice);
    const html = '<img src=x onerror=alert(1)> & <b>bold</b>';
    expect((await customerSay(cast.alice, n, html)).status).toBe(201);
    const thread = ((await cast.alice.get(my(n))).json.ticket as MyTicket).thread;
    expect(thread.messages.some(m => m.body === html)).toBe(true);
  });

  it('30 messages an hour per customer: the 31st is 429, nothing written; per user, not per IP', async () => {
    const n = await openTicket(cast.alice); // the hand-off counts as one
    await setRateWindow(`hd-msg:${cast.ids.alice}`, 29, 'hour');
    const results = await inParallel(20, i => customerSay(cast.alice, n, `Reply ${i}`));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 429)).toHaveLength(19);
    expect(await db.message.count({where: {body: {startsWith: 'Reply '}}})).toBe(1);
    const limited = results.find(r => r.status === 429)!;
    expect(limited.headers.get('cache-control') ?? '').toMatch(/no-store/);

    // The cleanup job never deletes this hour's bucket (it deletes minutes older than an hour).
    await deleteOldRateWindows(db);
    expect((await customerSay(cast.alice, n, 'After cleanup')).status).toBe(429);

    // bob, even from alice's IP, is not limited by her.
    const bobTicket = await openTicket(cast.bob);
    expect((await customerSay(cast.bob, bobTicket, 'Mine')).status).toBe(201);
  });

  it('last hour\'s full bucket does not limit this hour', async () => {
    const n = await openTicket(cast.alice);
    await db.rateWindow.deleteMany({});
    await setRateWindow(`hd-msg:${cast.ids.alice}`, 30, 'prev-hour');
    expect((await customerSay(cast.alice, n, 'New hour')).status).toBe(201);
  });

  it('a solved ticket reopens on a reply; solved more than 14 days ago it is closed (409, nothing written)', async () => {
    const n = await openTicket(cast.alice);
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    expect(await storedCounters()).toEqual({unsolved: 0, waitingOnUs: 0, solvedThisWeek: 1});
    const reopen = await customerSay(cast.alice, n, 'Actually it broke again.');
    expect(reopen.status, JSON.stringify(reopen.json)).toBe(201);
    expect(await statusOf(n)).toBe('waiting');
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 1, solvedThisWeek: 0});
    expect(await storedCounters()).toEqual(await groundTruthCounters());

    const old = await openTicket(cast.alice, 'An old one');
    expect((await setStatus(cast.agentA, old, 'waiting', 'solved')).status).toBe(200);
    await db.ticket.update({where: {number: old}, data: {solvedAt: new Date(Date.now() - 15 * 86400_000)}});
    const view = (await cast.alice.get(my(old))).json.ticket as MyTicket;
    expect(view.canReply).toBe(false);
    const closed = await customerSay(cast.alice, old, 'Hello again');
    expect(closed.status).toBe(409);
    expect(await db.message.count({where: {body: 'Hello again'}})).toBe(0);
    expect(await statusOf(old)).toBe('solved');
  });

  it('the customer marks it solved: resolution confirmed, counters follow', async () => {
    const n = await openTicket(cast.alice);
    const res = await cast.alice.post(`${my(n)}/solve`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const ticket = (await cast.alice.get(my(n))).json.ticket as MyTicket;
    expect(ticket).toMatchObject({status: 'solved', resolution: 'confirmed', canRate: true});
    expect(await storedCounters()).toEqual(await groundTruthCounters());
    // Saying it again is a no-op (200), not a second change: no second audit row, counters unchanged.
    expect((await cast.alice.post(`${my(n)}/solve`, {})).status).toBe(200);
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_solved'}})).toBe(1);
    expect(await storedCounters()).toEqual(await groundTruthCounters());
  });

  it('rating: only once, only when solved, 1–5 integers; 20 at once → one', async () => {
    const n = await openTicket(cast.alice);
    expect((await cast.alice.post(`${my(n)}/csat`, {score: 5})).status).toBe(404);
    for (const score of [0, 6, 2.5, '5', null, -1, undefined]) {
      expect((await cast.alice.post(`${my(n)}/csat`, {score})).status, JSON.stringify(score)).toBe(422);
    }
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    const results = await inParallel(20, i => cast.alice.post(`${my(n)}/csat`, {score: (i % 5) + 1}));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 404)).toHaveLength(19);
    const stored = await db.ticket.findUniqueOrThrow({where: {number: n}, select: {csat: true}});
    expect(stored.csat).toBe((results.findIndex(r => r.status === 200) % 5) + 1);

    // Reopened and solved again: the first rating stays, no second one.
    expect((await customerSay(cast.alice, n, 'One more thing')).status).toBe(201);
    expect((await setStatus(cast.agentA, n, 'waiting', 'solved')).status).toBe(200);
    expect((await cast.alice.post(`${my(n)}/csat`, {score: 1})).status).toBe(404);
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}, select: {csat: true}})).csat).toBe(stored.csat);
    // Agents see it, read-only.
    const staff = await cast.agentA.get(`/site-api/helpdesk/tickets/${n}`);
    expect((staff.json.ticket as {csat: number}).csat).toBe(stored.csat);
  });

  it('the list pages by keyset: only mine, 20 then 5, no duplicates', async () => {
    for (let i = 0; i < 25; i++) {
      await seedTickets(1, {userId: cast.ids.alice, subject: `Alice ${i}`});
      await seedTickets(1, {userId: cast.ids.bob, subject: `Bob ${i}`});
    }
    const seen: MyRow[] = [];
    let next: unknown = null;
    let pages = 0;
    do {
      const res = await cast.alice.get(`/site-api/helpdesk/my/tickets${next ? `?before=${next}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...(res.json.items as MyRow[]));
      next = res.json.nextBefore;
      pages++;
    } while (next && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(25);
    expect(new Set(seen.map(r => r.number)).size).toBe(25);
    expect(seen.every(r => r.subject.startsWith('Alice'))).toBe(true);
    // Newest first.
    const numbers = seen.map(r => r.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    // A garbage cursor is never a 500.
    for (const bad of ['abc', '-1', '99999999999999999999', '1;DROP']) {
      expect((await cast.alice.get(`/site-api/helpdesk/my/tickets?before=${encodeURIComponent(bad)}`)).status).toBeLessThan(500);
    }
  });
});
