import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {setCacheModeForTests} from '../../src/platform/cache';
import {setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {waitingLongestSql} from '../../src/server/routes/inbox';
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
  setStatus,
  statusOf,
  storedCounters,
} from './support/harness';

/**
 * The staff inbox (/site-api/helpdesk/tickets/*) and saved replies (/site-api/helpdesk/canned/*):
 * who may use them, the queues and their keyset paging, replies vs internal notes, status,
 * priority and assignment (conditional), delete (its own permission), presence, the tiles, the
 * audit trail — and that no response ever carries an email address. Real Postgres; AI off.
 */
const T = '/site-api/helpdesk/tickets';
const NOTE = 'NOTE-SENTINEL-7f3a';

type Row = {number: number; subject: string; status: string; priority: string; customer: {id: number | null; name: string}; assignee: {id: number; name: string} | null; lastMessageAt: string};
type Page = {items: Row[]; next: string | null};
type Staff = {
  number: number;
  status: string;
  priority: string;
  customer: {id: number | null; name: string};
  canSeeUser: boolean;
  assignee: {id: number; name: string} | null;
  aiSummary: string | null;
  thread: {messages: {sender: string; author: string | null; body: string}[]};
};

// Each test signs up several accounts (scrypt) and runs requests in parallel: on a busy machine the
// default 10 s hook timeout is too short, and a timed-out beforeEach keeps running into the next test.
vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

describe.skipIf(!DATABASE_URL)('help desk inbox (integration, real Postgres)', () => {
  let cast: HelpdeskCast;

  /** Every page of a queue, following `next` (bounded). */
  async function allPages(queue: string, extra = '', who = cast.agentA) {
    const items: Row[] = [];
    const sizes: number[] = [];
    let next: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await who.get(`${T}?queue=${queue}${extra}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const page = res.json as unknown as Page;
      items.push(...page.items);
      sizes.push(page.items.length);
      next = page.next;
      if (!next) break;
    }
    return {items, sizes};
  }

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
      throw new Error('no AI call expected in inbox tests');
    });
    cast = await helpdeskCast(app);
  });

  it('every staff route: signed out 401; a customer or a KB-only editor 403; nothing written', async () => {
    const n = await openTicket(cast.alice);
    const before = {messages: await db.message.count(), audit: await db.auditEvent.count()};
    const routes: [string, string, unknown?][] = [
      ['GET', `${T}?queue=waiting`],
      ['GET', `${T}/tiles`],
      ['GET', `${T}/agents`],
      ['GET', `${T}/${n}`],
      ['POST', `${T}/${n}/presence`, {}],
      ['POST', `${T}/${n}/messages`, {kind: 'reply', body: 'Hi', key: newKey(), expectedStatus: 'waiting'}],
      ['POST', `${T}/${n}/status`, {from: 'waiting', to: 'solved'}],
      ['POST', `${T}/${n}/priority`, {from: 'normal', to: 'urgent'}],
      ['POST', `${T}/${n}/assignee`, {from: null, to: cast.ids.agentA}],
      ['DELETE', `${T}/${n}`],
      ['GET', '/site-api/helpdesk/canned'],
      ['POST', '/site-api/helpdesk/canned', {title: 'Hello', body: 'Hi there'}],
      ['PATCH', '/site-api/helpdesk/canned/1', {title: 'Hello again'}],
      ['DELETE', '/site-api/helpdesk/canned/1'],
    ];
    for (const [method, path, body] of routes) {
      expect((await cast.guest.request(method, path, body)).status, `guest ${method} ${path}`).toBe(401);
      expect((await cast.alice.request(method, path, body)).status, `customer ${method} ${path}`).toBe(403);
      expect((await cast.kbOnly.request(method, path, body)).status, `kbOnly ${method} ${path}`).toBe(403);
    }
    expect(await db.message.count()).toBe(before.messages);
    expect(await db.auditEvent.count()).toBe(before.audit);
    expect(await statusOf(n)).toBe('waiting');
    expect(await db.helpdeskCannedReply.count()).toBe(0);
  });

  it('an unknown ticket number is 404 on every route', async () => {
    for (const n of ['99999', 'abc', '0', '-1']) {
      const routes: [string, string, unknown?][] = [
        ['GET', `${T}/${n}`],
        ['POST', `${T}/${n}/presence`, {}],
        ['POST', `${T}/${n}/messages`, {kind: 'note', body: 'Hi', key: newKey()}],
        ['POST', `${T}/${n}/status`, {from: 'waiting', to: 'solved'}],
        ['POST', `${T}/${n}/priority`, {from: 'normal', to: 'urgent'}],
        ['POST', `${T}/${n}/assignee`, {from: null, to: null}],
      ];
      for (const [method, path, body] of routes) {
        expect((await cast.agentA.request(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
      expect((await cast.admin.delete(`${T}/${n}`)).status).toBe(404);
    }
    expect(await db.message.count()).toBe(0);
  });

  it('delete has its own permission: an agent 403, an admin deletes, counters and audit follow', async () => {
    const n = await openTicket(cast.alice);
    await agentSay(cast.agentA, n, NOTE, {kind: 'note'});
    expect((await cast.agentA.delete(`${T}/${n}`)).status).toBe(403);
    expect(await db.ticket.count()).toBe(1);

    const res = await cast.admin.delete(`${T}/${n}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await db.ticket.count()).toBe(0);
    expect(await db.conversation.count()).toBe(0);
    expect(await db.message.count()).toBe(0);
    expect(await storedCounters()).toEqual({unsolved: 0, waitingOnUs: 0, solvedThisWeek: 0});
    const events = await db.auditEvent.findMany({where: {action: 'helpdesk_ticket_deleted'}, select: {actorUserId: true, meta: true, targetType: true, targetId: true}});
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(cast.ids.admin);
    expectNoLeak(events, ['@', NOTE, 'My grinder'], 'audit');
    expect((await cast.admin.delete(`${T}/${n}`)).status).toBe(404);
    // Deleting solved and pending ones takes them out of the right tiles.
    const [a, b] = [await openTicket(cast.alice), await openTicket(cast.bob)];
    expect((await setStatus(cast.agentA, a, 'waiting', 'solved')).status).toBe(200);
    expect((await setStatus(cast.agentA, b, 'waiting', 'pending')).status).toBe(200);
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 0, solvedThisWeek: 1});
    expect((await cast.admin.delete(`${T}/${a}`)).status).toBe(200);
    expect((await cast.admin.delete(`${T}/${b}`)).status).toBe(200);
    expect(await storedCounters()).toEqual({unsolved: 0, waitingOnUs: 0, solvedThisWeek: 0});
  });

  it('losing the role mid-session closes the inbox on the next request', async () => {
    expect((await cast.agentA.get(`${T}?queue=waiting`)).status).toBe(200);
    const role = await db.role.findUniqueOrThrow({where: {slug: 'p3-agent'}, select: {id: true}});
    await db.userRole.deleteMany({where: {userId: cast.ids.agentA, roleId: role.id}});
    expect((await cast.agentA.get(`${T}?queue=waiting`)).status).toBe(403);
  });

  it('no staff response carries an email; the customer panel links to Users only for site:user:read', async () => {
    const n = await openTicket(cast.alice);
    await db.ticket.update({where: {number: n}, data: {aiSummary: 'Customer needs a replacement.', aiSummaryState: 'ready'}});
    await agentSay(cast.agentA, n, NOTE, {kind: 'note'});
    await agentSay(cast.agentA, n, 'We will replace it.');
    await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.agentA});
    await cast.agentB.post(`${T}/${n}/presence`, {});
    for (const who of [cast.agentA, cast.admin]) {
      for (const path of [`${T}?queue=pending`, `${T}?queue=mine`, `${T}/${n}`, `${T}/agents`, `${T}/tiles`]) {
        const res = await who.get(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
        expectNoLeak(res.json, ['@', 'passwordHash', 'password'], path);
      }
      expectNoLeak((await who.post(`${T}/${n}/presence`, {})).json, ['@'], 'presence');
    }
    const agentView = (await cast.agentA.get(`${T}/${n}`)).json.ticket as Staff;
    expect(agentView.customer).toEqual({id: cast.ids.alice, name: 'alice'});
    expect(agentView.canSeeUser).toBe(false);
    expect(agentView.aiSummary).toBe('Customer needs a replacement.');
    expect(agentView.thread.messages.map(m => m.sender)).toEqual(['agent', 'note', 'customer']);
    expect(((await cast.admin.get(`${T}/${n}`)).json.ticket as Staff).canSeeUser).toBe(true);
    // Audit rows carry ids and statuses only.
    const audit = await db.auditEvent.findMany({where: {action: {startsWith: 'helpdesk_'}}, select: {meta: true}});
    expectNoLeak(audit, ['@', NOTE, 'replace', 'alice'], 'audit');
  });

  it('a reply moves the ticket (default pending) and marks it unread; a note changes nothing the customer sees', async () => {
    const n = await openTicket(cast.alice);
    const conv = () => db.conversation.findFirstOrThrow({select: {status: true, lastMessageAt: true, customerUnread: true}});
    const start = await conv();

    const note = await agentSay(cast.agentA, n, NOTE, {kind: 'note'});
    expect(note.status, JSON.stringify(note.json)).toBe(201);
    expect(await conv()).toEqual(start);
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}, select: {firstResponseAt: true}})).firstResponseAt).toBeNull();

    const reply = await agentSay(cast.agentA, n, 'Thanks for writing in.');
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    expect(reply.json).toMatchObject({status: 'pending', message: {sender: 'agent', author: 'agent-a', body: 'Thanks for writing in.'}});
    const after = await conv();
    expect(after.status).toBe('pending');
    expect(after.customerUnread).toBe(true);
    expect(after.lastMessageAt.getTime()).toBeGreaterThanOrEqual(start.lastMessageAt.getTime());
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}, select: {firstResponseAt: true}})).firstResponseAt).not.toBeNull();
    expect(await storedCounters()).toEqual(await groundTruthCounters());

    // Stale expectedStatus: 409, the message is not saved.
    const stale = await agentSay(cast.agentB, n, 'Me too!', {expectedStatus: 'waiting'});
    expect(stale.status).toBe(409);
    expect(await db.message.count({where: {body: 'Me too!'}})).toBe(0);

    // Reply and solve in one go; the same key twice stores it once.
    const key = newKey();
    const [s1, s2] = await Promise.all([
      agentSay(cast.agentA, n, 'Solved, enjoy!', {expectedStatus: 'pending', setStatus: 'solved', key}),
      agentSay(cast.agentA, n, 'Solved, enjoy!', {expectedStatus: 'pending', setStatus: 'solved', key}),
    ]);
    expect([s1.status, s2.status]).toEqual([201, 201]);
    expect(await db.message.count({where: {body: 'Solved, enjoy!'}})).toBe(1);
    expect(await statusOf(n)).toBe('solved');
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_solved'}})).toBe(1);
    expect(await storedCounters()).toEqual(await groundTruthCounters());

    // Validation.
    for (const body of [
      {kind: 'reply', body: '', key: newKey(), expectedStatus: 'solved'},
      {kind: 'reply', body: 'x'.repeat(4001), key: newKey(), expectedStatus: 'solved'},
      {kind: 'reply', body: 'ok', key: 'short', expectedStatus: 'solved'},
      {kind: 'reply', body: 'ok', key: newKey()},
      {kind: 'reply', body: 'ok', key: newKey(), expectedStatus: 'closed'},
      {kind: 'reply', body: 'ok', key: newKey(), expectedStatus: 'solved', setStatus: 'waiting'},
      {kind: 'note', body: 'ok', key: newKey(), setStatus: 'solved'},
      {kind: 'shout', body: 'ok', key: newKey()},
    ]) {
      expect((await cast.agentA.post(`${T}/${n}/messages`, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('status: conditional on `from`; same → no-op; unknown → 422; reopen and solve audited', async () => {
    const n = await openTicket(cast.alice);
    expect((await setStatus(cast.agentA, n, 'waiting', 'waiting')).status).toBe(200);
    expect((await setStatus(cast.agentA, n, 'pending', 'pending')).status).toBe(409);
    expect((await setStatus(cast.agentA, n, 'waiting', 'closed')).status).toBe(422);
    expect((await setStatus(cast.agentA, n, 'waiting', 'ai')).status).toBe(422);
    expect((await setStatus(cast.agentA, n, 'pending', 'solved')).status).toBe(409);
    expect(await statusOf(n)).toBe('waiting');
    expect((await setStatus(cast.agentA, n, 'waiting', 'open')).status).toBe(200);
    expect((await setStatus(cast.agentA, n, 'open', 'solved')).status).toBe(200);
    expect((await setStatus(cast.agentA, n, 'solved', 'open')).status).toBe(200);
    const actions = (await db.auditEvent.findMany({where: {action: {startsWith: 'helpdesk_'}}, orderBy: {id: 'asc'}, select: {action: true}})).map(a => a.action);
    // Every status change is audited: a plain one as `status`, solving and reopening by name.
    expect(actions).toEqual(['helpdesk_ticket_status', 'helpdesk_ticket_solved', 'helpdesk_ticket_reopened']);
    expect(await storedCounters()).toEqual(await groundTruthCounters());
    expect(await storedCounters()).toEqual({unsolved: 1, waitingOnUs: 1, solvedThisWeek: 0});
  });

  it('priority: conditional on `from`; only the four values', async () => {
    const n = await openTicket(cast.alice);
    expect((await cast.agentA.post(`${T}/${n}/priority`, {from: 'normal', to: 'urgent'})).json).toEqual({priority: 'urgent'});
    expect((await cast.agentB.post(`${T}/${n}/priority`, {from: 'normal', to: 'low'})).status).toBe(409);
    expect((await cast.agentA.post(`${T}/${n}/priority`, {from: 'urgent', to: 'critical'})).status).toBe(422);
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}, select: {priority: true}})).priority).toBe('urgent');
  });

  it('assign: only to active inbox holders; conditional on `from`; audited with ids only', async () => {
    const n = await openTicket(cast.alice);
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.alice})).status).toBe(422);
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.kbOnly})).status).toBe(422);
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: 999999})).status).toBe(422);
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: 'me'})).status).toBe(422);
    await db.user.update({where: {id: cast.ids.agentB}, data: {status: 'suspended'}});
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.agentB})).status).toBe(422);
    await db.user.update({where: {id: cast.ids.agentB}, data: {status: 'active'}});
    expect((await db.ticket.findUniqueOrThrow({where: {number: n}, select: {assigneeId: true}})).assigneeId).toBeNull();
    expect(await db.auditEvent.count({where: {action: 'helpdesk_ticket_assigned'}})).toBe(0);

    const ok = await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.agentB});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toEqual({assignee: {id: cast.ids.agentB, name: 'agent-b'}});
    const stale = await cast.agentA.post(`${T}/${n}/assignee`, {from: null, to: cast.ids.agentA});
    expect(stale.status).toBe(409);
    expect((stale.json as {assignee: unknown}).assignee).toEqual({id: cast.ids.agentB, name: 'agent-b'});
    expect((await cast.agentA.post(`${T}/${n}/assignee`, {from: cast.ids.agentB, to: null})).status).toBe(200);
    const events = await db.auditEvent.findMany({where: {action: 'helpdesk_ticket_assigned'}, orderBy: {id: 'asc'}, select: {meta: true}});
    expect(events.map(e => e.meta)).toEqual([
      {from: null, to: cast.ids.agentB},
      {from: cast.ids.agentB, to: null},
    ]);
    // The agents list: inbox holders only (an admin holds it too), names only.
    const agents = (await cast.agentA.get(`${T}/agents`)).json.agents as {id: number; name: string}[];
    expect(agents.map(a => a.name).sort()).toEqual(['agent-a', 'agent-b', 'boss']);
    expect(Object.keys(agents[0]!).sort()).toEqual(['id', 'name']);
  });

  it('queues: waiting oldest first, pending/solved newest first, mine = assigned and unsolved', async () => {
    const t0 = Date.now() - 3600_000;
    const at = (min: number) => new Date(t0 + min * 60_000);
    const [w1] = await seedTickets(1, {userId: cast.ids.alice, status: 'waiting', lastMessageAt: at(1), priority: 'urgent'});
    const [o1] = await seedTickets(1, {userId: cast.ids.alice, status: 'open', lastMessageAt: at(2)});
    const [w2] = await seedTickets(1, {userId: cast.ids.bob, status: 'waiting', lastMessageAt: at(3), assigneeId: cast.ids.agentA});
    const [p1] = await seedTickets(1, {userId: cast.ids.alice, status: 'pending', lastMessageAt: at(4), assigneeId: cast.ids.agentA});
    const [p2] = await seedTickets(1, {userId: cast.ids.bob, status: 'pending', lastMessageAt: at(5), priority: 'urgent'});
    const [s1] = await seedTickets(1, {userId: cast.ids.alice, status: 'solved', lastMessageAt: at(6), assigneeId: cast.ids.agentA});
    const ids = (page: {items: Row[]}) => page.items.map(r => r.number);
    expect(ids(await allPages('waiting'))).toEqual([w1, o1, w2]);
    expect(ids(await allPages('pending'))).toEqual([p2, p1]);
    expect(ids(await allPages('solved'))).toEqual([s1]);
    expect(ids(await allPages('mine'))).toEqual([p1, w2]);
    expect(ids(await allPages('mine', '', cast.agentB))).toEqual([]);
    expect(ids(await allPages('waiting', '&priority=urgent'))).toEqual([w1]);
    expect(ids(await allPages('mine', '&priority=normal'))).toEqual([p1, w2]);
    // Pending and Solved are not filtered by priority (by design): the whole queue.
    expect(ids(await allPages('pending', '&priority=urgent'))).toEqual([p2, p1]);
    // An unknown queue is the default one; never a 500.
    expect((await cast.agentA.get(`${T}?queue=everything`)).status).toBe(200);
  });

  it('keyset paging with ties: 45 tickets with the same time → 20/20/5, no duplicates, no gaps', async () => {
    const same = new Date(Date.now() - 600_000);
    const waiting = await seedTickets(45, {userId: cast.ids.alice, status: 'waiting', lastMessageAt: same});
    const pending = await seedTickets(45, {userId: cast.ids.bob, status: 'pending', lastMessageAt: same});
    const mine = await seedTickets(25, {userId: cast.ids.bob, status: 'open', assigneeId: cast.ids.agentA});

    const w = await allPages('waiting');
    // 45 waiting + the 25 open ones assigned to agent A: 70 in "waiting on us".
    expect(w.sizes).toEqual([20, 20, 20, 10]);
    const wn = w.items.map(r => r.number).filter(n => waiting.includes(n));
    expect(wn).toHaveLength(45);
    expect(new Set(w.items.map(r => r.number)).size).toBe(w.items.length);
    // The truth from SQL, in the queue's order (oldest first, then id).
    const truth = await db.$queryRaw<{number: number}[]>`
      SELECT t."number" FROM "conversations" c JOIN "tickets" t ON t."conversation_id" = c."id"
      WHERE c."status" IN ('waiting', 'open') ORDER BY c."last_message_at" ASC, c."id" ASC`;
    expect(w.items.map(r => r.number)).toEqual(truth.map(r => r.number));

    const p = await allPages('pending');
    expect(p.sizes).toEqual([20, 20, 5]);
    expect(p.items.map(r => r.number).sort((a, b) => a - b)).toEqual(pending);
    expect(p.items.map(r => r.number)).toEqual([...pending].reverse());

    const m = await allPages('mine');
    expect(m.sizes).toEqual([20, 5]);
    expect(m.items.map(r => r.number)).toEqual([...mine].reverse());

    // A cursor from one queue used on another: only the other queue's rows.
    const first = (await cast.agentA.get(`${T}?queue=waiting`)).json as unknown as Page;
    const cross = (await cast.agentA.get(`${T}?queue=pending&cursor=${encodeURIComponent(first.next!)}`)).json as unknown as Page;
    expect(cross.items.every(r => r.status === 'pending')).toBe(true);
    // Garbage cursors: never a 500.
    for (const bad of ['x', '-1', '9999999999999|1', '1|-5', '1'.repeat(100), "1|1' OR 1=1", '0|0']) {
      for (const queue of ['waiting', 'pending', 'mine']) {
        const res = await cast.agentA.get(`${T}?queue=${queue}&cursor=${encodeURIComponent(bad)}`);
        expect(res.status, `${queue} ${bad}`).toBeLessThan(500);
      }
    }
  });

  it('the indexes every queue reads are there', async () => {
    const rows = await db.$queryRaw<{indexname: string; indexdef: string}[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('conversations', 'tickets', 'messages')`;
    const names = rows.map(r => r.indexname);
    for (const name of [
      'conversations_waiting_idx',
      'conversations_unread_idx',
      'conversations_status_last_message_at_id_idx',
      'conversations_user_id_id_idx',
      'conversations_user_id_request_key_key',
      'tickets_assignee_id_solved_at_id_idx',
      'tickets_summary_pending_idx',
      'messages_conversation_id_id_idx',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('presence: others within 90 s, never yourself; one row per agent however often it beats', async () => {
    const n = await openTicket(cast.alice);
    const a = await cast.agentA.post(`${T}/${n}/presence`, {});
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({status: 'waiting', others: []});
    const b = await cast.agentB.post(`${T}/${n}/presence`, {});
    expect((b.json.others as {id: number; name: string}[]).map(o => [o.id, o.name])).toEqual([[cast.ids.agentA, 'agent-a']]);
    await inParallel(20, () => cast.agentA.post(`${T}/${n}/presence`, {}));
    expect(await db.ticketView.count()).toBe(2);
    await db.ticketView.updateMany({where: {userId: cast.ids.agentA}, data: {viewedAt: new Date(Date.now() - 91_000)}});
    expect((await cast.agentB.post(`${T}/${n}/presence`, {})).json.others).toEqual([]);
  });

  it('tiles come from the kept counters and equal the ground truth', async () => {
    const a = await openTicket(cast.alice);
    const b = await openTicket(cast.bob);
    await openTicket(cast.alice, 'Third');
    await setStatus(cast.agentA, a, 'waiting', 'solved');
    await setStatus(cast.agentA, b, 'waiting', 'pending');
    const tiles = (await cast.agentA.get(`${T}/tiles`)).json;
    expect(tiles).toMatchObject({unsolved: 2, waitingOnUs: 1, solvedThisWeek: 1, confirmedThisWeek: 0, assumedThisWeek: 1});
    expect(tiles).toMatchObject(await groundTruthCounters());

    // A customer's own Solve counts as confirmed; reopening takes the agent's solve back out.
    const c = await openTicket(cast.bob, 'Fourth');
    expect((await cast.bob.post(`/site-api/helpdesk/my/tickets/${c}/solve`, {})).status).toBe(200);
    expect((await setStatus(cast.agentA, a, 'solved', 'open')).status).toBe(200);
    const after = (await cast.agentA.get(`${T}/tiles`)).json;
    expect(after).toMatchObject({unsolved: 3, waitingOnUs: 2, solvedThisWeek: 1, confirmedThisWeek: 1, assumedThisWeek: 0});
    expect(after).toMatchObject(await groundTruthCounters());
  });

  it('tiles: waiting longest is waiting + open only, oldest first, at most 5, names and never an email', async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    // Oldest of all, but pending / solved: never listed.
    await seedTickets(1, {userId: cast.ids.alice, status: 'pending', lastMessageAt: minutesAgo(500), subject: 'Pending one'});
    await seedTickets(1, {userId: cast.ids.alice, status: 'solved', lastMessageAt: minutesAgo(400), subject: 'Solved one'});
    const [gone] = await seedTickets(1, {userId: cast.ids.bob, status: 'open', lastMessageAt: minutesAgo(300), subject: 'Open, oldest'});
    const [w1] = await seedTickets(1, {userId: cast.ids.alice, status: 'waiting', lastMessageAt: minutesAgo(200), subject: 'Waiting 200', priority: 'urgent'});
    const tied = await seedTickets(3, {userId: cast.ids.alice, status: 'waiting', lastMessageAt: minutesAgo(100), subject: 'Tied'});
    await seedTickets(2, {userId: cast.ids.alice, status: 'waiting', lastMessageAt: minutesAgo(10), subject: 'Newest'});
    // The customer of the oldest one deleted their account: listed under the fixed label.
    await db.user.delete({where: {id: cast.ids.bob}});

    const res = await cast.agentA.get(`${T}/tiles`);
    expect(res.status).toBe(200);
    const list = res.json.waitingLongest as {number: number; subject: string; customer: string; status: string; priority: string; since: string}[];
    expect(list.map(r => r.number)).toEqual([gone, w1, ...tied]);
    expect(list[0]).toEqual({number: gone, subject: 'Open, oldest', customer: 'Deleted customer', status: 'open', priority: 'normal', since: expect.any(String)});
    expect(list[1]).toMatchObject({customer: 'alice', status: 'waiting', priority: 'urgent'});
    expect(Date.parse(list[1]!.since)).toBeLessThan(Date.parse(list[2]!.since));
    expectNoLeak(res.json, ['@', 'example.test', 'Pending one', 'Solved one', 'Newest'], 'tiles');

    // Nothing waiting → an empty list.
    await db.conversation.updateMany({where: {status: {in: ['waiting', 'open']}}, data: {status: 'pending'}});
    expect((await cast.agentA.get(`${T}/tiles`)).json.waitingLongest).toEqual([]);
  });

  it('tiles: the waiting list reads the partial index `conversations_waiting_idx`', async () => {
    await seedTickets(30, {userId: cast.ids.alice, status: 'pending'});
    await seedTickets(5, {userId: cast.ids.alice, status: 'waiting'});
    // The route's OWN query (inbox.ts exports it): an index scan of the partial index (seq scans off, so the
    // tiny test table can't hide a plan that would scan every conversation on a real site).
    const plan = await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const query = waitingLongestSql();
      return tx.$queryRawUnsafe<{'QUERY PLAN': string}[]>(`EXPLAIN ${query.text}`, ...query.values);
    });
    expect(plan.map(r => r['QUERY PLAN']).join('\n')).toContain('conversations_waiting_idx');
  });

  it('a deleted customer: the ticket stays for the team, anonymised; never 500', async () => {
    const n = await openTicket(cast.alice);
    await db.user.delete({where: {id: cast.ids.alice}});
    const list = (await cast.agentA.get(`${T}?queue=waiting`)).json as unknown as Page;
    expect(list.items.find(r => r.number === n)?.customer).toEqual({id: null, name: 'Deleted customer'});
    const detail = await cast.admin.get(`${T}/${n}`);
    expect(detail.status).toBe(200);
    expect((detail.json.ticket as Staff).customer).toEqual({id: null, name: 'Deleted customer'});
    expect((detail.json.ticket as Staff).canSeeUser).toBe(false);
    expect((detail.json.ticket as Staff).thread.messages.every(m => m.sender !== 'customer' || m.author === 'Deleted customer')).toBe(true);
    expect((await agentSay(cast.agentA, n, 'Anyone there?')).status).toBe(201);
  });

  it('saved replies: any inbox holder reads and writes; validated; at most 100', async () => {
    const created = await cast.agentA.post('/site-api/helpdesk/canned', {title: 'Refund steps', body: 'Hi {{customer.firstName}}, here is how…', position: 2});
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = (created.json.reply as {id: number}).id;
    expect((await cast.agentB.patch(`/site-api/helpdesk/canned/${id}`, {title: 'Refunds'})).status).toBe(200);
    const list = (await cast.agentB.get('/site-api/helpdesk/canned')).json.replies as {id: number; title: string}[];
    expect(list.map(r => [r.id, r.title])).toEqual([[id, 'Refunds']]);
    for (const body of [{title: '', body: 'x'}, {title: 'x'.repeat(81), body: 'x'}, {title: 'ok', body: 'x'.repeat(4001)}, {title: 'ok', body: 'x', position: -1}, {title: 'ok', body: 'bad \u0001'}]) {
      expect((await cast.agentA.post('/site-api/helpdesk/canned', body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect((await cast.agentA.patch('/site-api/helpdesk/canned/99999', {title: 'Nope'})).status).toBe(404);
    expect((await cast.agentA.delete(`/site-api/helpdesk/canned/${id}`)).status).toBe(200);
    expect((await cast.agentA.delete(`/site-api/helpdesk/canned/${id}`)).status).toBe(404);

    await db.helpdeskCannedReply.createMany({data: Array.from({length: 99}, (_, i) => ({title: `R${i}`, body: 'Body', createdBy: 0, updatedBy: 0}))});
    const last = await inParallel(5, i => cast.agentA.post('/site-api/helpdesk/canned', {title: `Last ${i}`, body: 'Body'}));
    expect(last.filter(r => r.status === 201)).toHaveLength(1);
    expect(last.filter(r => r.status === 409)).toHaveLength(4);
    expect(await db.helpdeskCannedReply.count()).toBe(100);
  });

  it('message text is stored and returned verbatim (plain text)', async () => {
    const n = await openTicket(cast.alice);
    const html = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    expect((await agentSay(cast.agentA, n, html)).status).toBe(201);
    expect((await customerSay(cast.alice, n, html)).status).toBe(201);
    const thread = ((await cast.agentA.get(`${T}/${n}`)).json.ticket as Staff).thread.messages;
    expect(thread.filter(m => m.body === html)).toHaveLength(2);
  });
});
