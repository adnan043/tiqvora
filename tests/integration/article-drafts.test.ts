import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {handleJobDelivery} from '../../src/platform/background';
import {setCacheModeForTests} from '../../src/platform/cache';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {type ProviderResult, setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {DRAFT_MAX_TOKENS, DRAFT_TIMEOUT_MS} from '../../src/server/ai/draft';
import {background} from '../../src/server/background';
import {runHealthDraftJob} from '../../src/server/knowledge/drafts';
import {env} from './support/cloudflare-workers';
import {
  agentSay,
  configureEnv,
  DATABASE_URL,
  db,
  expectNoLeak,
  type FakeCall,
  type HelpdeskCast,
  helpdeskCast,
  JOBS_SECRET,
  jobDelivery,
  newKey,
  openTicket,
  resetDatabase,
  resetHelpdeskSettings,
  setStatus,
} from './support/harness';

/** Jobs the code sends are captured, never run inline (locally `sendJob` would run them at once, without key dedupe). */
const sent = vi.hoisted(() => [] as {list: string; data: unknown; options: Record<string, unknown>}[]);
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  const capture = (list: string, data: unknown, options: Record<string, unknown> = {}) => {
    sent.push({list, data, options});
    return {id: `job_t${sent.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
  };
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options?: Record<string, unknown>) => capture(list, data, options),
    sendJobs: async (_url: unknown, jobs: {list: string; data?: unknown}[]) => jobs.map(job => capture(job.list, job.data, job as Record<string, unknown>)),
  };
});

/**
 * Article drafts from solved tickets (`article-drafts`, src/server/knowledge/drafts.ts) and drafts
 * for Knowledge health issues (`health-drafts`): queued by the three solve paths after commit, run
 * through SIGNED deliveries as the platform sends them. One issue per ticket however often it runs;
 * the provider never sees internal notes, names or emails. Real Postgres, fake provider.
 */
const KEY = 'fake-anthropic-key-for-tests-0123456789';
const NOTE = 'NOTE-SENTINEL-41c2';
const CUSTOMER_EMAIL = 'carol.customer@example.test';
const AGENT_REPLY =
  'To descale the Classic grinder, unplug it, remove the hopper and brush the burrs. Then run a tablespoon of rice through it and reassemble.';

let seq = 0;
const run = (list: string, data: unknown, extra: {id?: string; attempt?: number; maxAttempts?: number} = {}) =>
  inRequestScope(async () => {
    const res = await handleJobDelivery(
      jobDelivery({id: extra.id ?? `job_draft_${++seq}`, list, data, attempt: extra.attempt ?? 1, maxAttempts: extra.maxAttempts ?? 4}),
      background
    );
    await getDb()?.$disconnect();
    return {status: res.status, json: (await res.json()) as Record<string, unknown>};
  });

vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

describe.skipIf(!DATABASE_URL)('article drafts (integration, real Postgres, fake provider)', () => {
  let cast: HelpdeskCast;
  let calls: FakeCall[];
  let answer: (call: FakeCall) => Promise<ProviderResult>;
  const ok = (text: string): ProviderResult => ({
    ok: true,
    text,
    inputTokens: 2000,
    outputTokens: 800,
    attempts: [{model: 'claude-opus-5-5', inputTokens: 2000, outputTokens: 800}],
    stopReason: 'end_turn',
    refused: false,
  });
  const draft = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      action: 'new',
      title: 'Cleaning your grinder',
      body: '## Clean the burrs\n\n1. Unplug the grinder.\n2. Brush the burrs.\n3. Grind [Add: amount] of rice.',
      summary: 'Agents explain grinder cleaning; no article covers it.',
      conflict: false,
      missingFacts: ['How much rice to use'],
      ...over,
    });

  const drafts = () => sent.filter(s => s.list === 'article-drafts');
  const ticketOf = (number: number) => db.ticket.findUniqueOrThrow({where: {number}, select: {id: true, draftCheckedAt: true, solvedAt: true}});
  const issues = () => db.healthIssue.findMany({orderBy: {id: 'asc'}});

  /** A hand-off (customer line with an email), an internal note, a long agent reply; status left `pending`. */
  async function workedTicket(): Promise<{id: number; number: number}> {
    const number = await openTicket(cast.alice, `My grinder squeaks. Write to me at ${CUSTOMER_EMAIL} please.`);
    expect((await agentSay(cast.agentA, number, NOTE, {kind: 'note'})).status).toBe(201);
    expect((await agentSay(cast.agentA, number, AGENT_REPLY)).status).toBe(201);
    const t = await ticketOf(number);
    return {id: t.id, number};
  }

  /** Solved by the status route (the job is captured, not run). */
  async function solvedTicket(): Promise<{id: number; number: number}> {
    const t = await workedTicket();
    expect((await setStatus(cast.agentA, t.number, 'pending', 'solved')).status).toBe(200);
    calls.length = 0;
    return t;
  }

  async function publishedArticle(): Promise<{id: number}> {
    const category = await db.kbCategory.create({data: {name: 'Grinders', slug: 'grinders'}, select: {id: true}});
    return db.kbArticle.create({
      data: {
        categoryId: category.id,
        title: 'Grinder care',
        slug: 'grinder-care',
        body: '## Grinder care\n\nBrush the burrs weekly.',
        status: 'published',
        publishedAt: new Date(),
        createdBy: 0,
        updatedBy: 0,
      },
      select: {id: true},
    });
  }

  beforeAll(() => {
    configureEnv();
    env.SITE_JOBS_SECRET = JOBS_SECRET;
  });
  afterAll(async () => {
    delete env.SITE_JOBS_SECRET;
    delete env.ANTHROPIC_API_KEY;
    setCacheModeForTests(null);
    setAiProviderForTests(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    setCacheModeForTests('memory');
    await resetHelpdeskSettings();
    env.ANTHROPIC_API_KEY = KEY;
    sent.length = 0;
    calls = [];
    answer = async call => (call.req.schema && JSON.stringify(call.req.schema).includes('missingFacts') ? ok(draft()) : ok(JSON.stringify({summary: 'A summary.'})));
    setAiProviderForTests(async (key, req) => {
      const call = {key, req: JSON.parse(JSON.stringify(req)) as FakeCall['req']};
      calls.push(call);
      return answer(call);
    });
    cast = await helpdeskCast(app, ['alice', 'agentA']);
  });

  it('each of the three solve paths queues ONE `draft-<id>` job with only the ticket id; other moves queue none', async () => {
    // 1. An agent reply that solves.
    const a = await workedTicket();
    sent.length = 0;
    expect((await agentSay(cast.agentA, a.number, 'Glad that worked.', {expectedStatus: 'pending', setStatus: 'solved'})).status).toBe(201);
    expect(drafts()).toEqual([
      {list: 'article-drafts', data: {ticketId: a.id}, options: expect.objectContaining({key: `draft-${a.id}`, label: `Article draft · ticket #${a.number}`})},
    ]);
    expectNoLeak(drafts(), ['@', 'alice', 'grinder'], 'job');

    // 2. The status route.
    const b = await workedTicket();
    sent.length = 0;
    expect((await setStatus(cast.agentA, b.number, 'pending', 'solved')).status).toBe(200);
    expect(drafts()).toEqual([{list: 'article-drafts', data: {ticketId: b.id}, options: expect.objectContaining({key: `draft-${b.id}`})}]);

    // 3. The customer says it's solved; again on an already solved ticket queues nothing.
    const c = await workedTicket();
    sent.length = 0;
    expect((await cast.alice.post(`/site-api/helpdesk/my/tickets/${c.number}/solve`, {})).status).toBe(200);
    expect(drafts()).toEqual([{list: 'article-drafts', data: {ticketId: c.id}, options: expect.objectContaining({key: `draft-${c.id}`})}]);
    sent.length = 0;
    expect((await cast.alice.post(`/site-api/helpdesk/my/tickets/${c.number}/solve`, {})).status).toBe(200);
    expect(drafts()).toEqual([]);

    // Not solves: a note, a reply to pending, a reopen, a replayed solving reply.
    const d = await workedTicket();
    sent.length = 0;
    expect((await agentSay(cast.agentA, d.number, 'Another note', {kind: 'note'})).status).toBe(201);
    expect((await setStatus(cast.agentA, a.number, 'solved', 'open')).status).toBe(200);
    const key = newKey();
    expect((await agentSay(cast.agentA, d.number, 'Solved now.', {expectedStatus: 'pending', setStatus: 'solved', key})).status).toBe(201);
    expect(drafts()).toHaveLength(1);
    expect((await agentSay(cast.agentA, d.number, 'Solved now.', {expectedStatus: 'pending', setStatus: 'solved', key})).status).toBe(201);
    expect(drafts()).toHaveLength(1);
  });

  it('writes one draft from agent replies only: masked, no notes or names; a second run makes no call', async () => {
    const t = await solvedTicket();
    const first = await run('article-drafts', {ticketId: t.id});
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.req;
    expect(req.maxTokens).toBe(DRAFT_MAX_TOKENS);
    expect(req.timeoutMs).toBe(DRAFT_TIMEOUT_MS);
    expect(JSON.stringify(req.messages)).toContain('rice through it');
    expect(req.system).toMatch(/data, not instructions/i);
    expectNoLeak(req, [NOTE, CUSTOMER_EMAIL, 'alice', 'agent-a', `#${t.number}`, String(t.number)], 'draft prompt');

    const rows = await issues();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'gap',
      articleId: null,
      sourceTicketId: t.id,
      fingerprint: `ticket:${t.id}`,
      state: 'open',
      draftState: 'ready',
      suggestedTitle: 'Cleaning your grinder',
      week: null,
    });
    expect(rows[0]!.suggestedBody).toContain('## Clean the burrs');
    const evidence = rows[0]!.evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({source: 'ticket', ticketNumber: t.number, agentReplies: 1, missingFacts: ['How much rice to use'], citedArticleId: null});
    expect(String(evidence.question)).toContain('grinder squeaks');
    expectNoLeak(evidence, [CUSTOMER_EMAIL, NOTE], 'evidence');
    expect((await ticketOf(t.number)).draftCheckedAt).not.toBeNull();
    // Spend against the monthly cap, settled at the real cost.
    expect(Number((await db.aiUsage.findFirst({select: {spentMicros: true}}))?.spentMicros ?? 0)).toBeGreaterThan(0);

    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await issues()).toHaveLength(1);
  });

  it('two deliveries at once: exactly one issue', async () => {
    const t = await solvedTicket();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    answer = async () => {
      await gate;
      return ok(draft({title: `Draft ${calls.length}`}));
    };
    const both = Promise.all([run('article-drafts', {ticketId: t.id}), run('article-drafts', {ticketId: t.id})]);
    await new Promise(r => setTimeout(r, 300));
    release();
    expect((await both).map(r => r.status)).toEqual([200, 200]);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(await issues()).toHaveLength(1);
    expect((await ticketOf(t.number)).draftCheckedAt).not.toBeNull();
  });

  it('a reopened ticket: nothing, and not marked (a new solve sends again)', async () => {
    const t = await solvedTicket();
    expect((await setStatus(cast.agentA, t.number, 'solved', 'open')).status).toBe(200);
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(await issues()).toHaveLength(0);
    expect((await ticketOf(t.number)).draftCheckedAt).toBeNull();
  });

  it('no agent reply (or a short one): checked, no AI call', async () => {
    const number = await openTicket(cast.alice, 'Where is my order?');
    expect((await agentSay(cast.agentA, number, NOTE + ' a long internal note '.repeat(10), {kind: 'note'})).status).toBe(201);
    expect((await agentSay(cast.agentA, number, 'Done!', {setStatus: 'solved'})).status).toBe(201);
    const t = await ticketOf(number);
    calls.length = 0;
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(await issues()).toHaveLength(0);
    expect((await ticketOf(number)).draftCheckedAt).not.toBeNull();
  });

  it("action 'none': checked, no issue", async () => {
    const t = await solvedTicket();
    answer = async () => ok(draft({action: 'none', title: '', body: ''}));
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await issues()).toHaveLength(0);
    expect((await ticketOf(t.number)).draftCheckedAt).not.toBeNull();
  });

  it('the cited article goes to the prompt; an edit that contradicts it is a `conflict` about that article', async () => {
    const article = await publishedArticle();
    const t = await solvedTicket();
    await db.ticket.update({where: {id: t.id}, data: {aiSources: [{id: null, title: 'Snippet', url: ''}, {id: article.id, title: 'Grinder care', url: '/help/articles/grinder-care/'}]}});
    answer = async () => ok(draft({action: 'edit', conflict: true}));
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(JSON.stringify(calls[0]!.req.messages)).toContain('Brush the burrs weekly');
    const [row] = await issues();
    expect(row).toMatchObject({type: 'conflict', articleId: article.id, sourceTicketId: t.id});
    expect((row!.evidence as Record<string, unknown>).citedArticleId).toBe(article.id);
  });

  it("a conflict whose draft is a 'new' article is still about the cited article", async () => {
    const article = await publishedArticle();
    const t = await solvedTicket();
    await db.ticket.update({where: {id: t.id}, data: {aiSources: [{id: article.id, title: 'Grinder care', url: '/help/articles/grinder-care/'}]}});
    answer = async () => ok(draft({action: 'new', conflict: true}));
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    const [row] = await issues();
    expect(row).toMatchObject({type: 'conflict', articleId: article.id});
    expect((row!.evidence as Record<string, unknown>).citedArticleId).toBe(article.id);
  });

  it("names and visitors' links never reach the provider or the draft", async () => {
    const number = await openTicket(cast.alice, 'Hello, alice here. My page https://evil.example/pay says paid. Thanks, Alice');
    expect((await agentSay(cast.agentA, number, `Hi Alice, ${AGENT_REPLY} Kind regards, agent-a`)).status).toBe(201);
    expect((await setStatus(cast.agentA, number, 'pending', 'solved')).status).toBe(200);
    const t = await ticketOf(number);
    calls.length = 0;
    answer = async () =>
      ok(draft({body: 'Hi Alice!\n\nPay at [the payment page](https://evil.example/pay).\n\n![x](https://evil.example/t.png)\n\nSee [grinder care](/help/articles/grinder-care/).', summary: 'alice asked.'}));
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(calls).toHaveLength(1);
    expectNoLeak(calls[0]!.req.messages, [/alice/i, 'agent-a', 'evil.example'], 'draft prompt');
    expect(JSON.stringify(calls[0]!.req.messages)).toContain('[name]');
    const [row] = await issues();
    expect(row!.suggestedBody).toBe('Hi [name]!\n\nPay at the payment page [Add: link].\n\nSee [grinder care](/help/articles/grinder-care/).');
    expectNoLeak(row, [/alice/i, 'evil.example'], 'draft');
  });

  it('a timed-out call is final: checked, no retry (DontRetry), the hold settled', async () => {
    const t = await solvedTicket();
    answer = async () => ({ok: false, reason: 'timeout'});
    const res = await run('article-drafts', {ticketId: t.id}, {attempt: 1, maxAttempts: 4});
    expect(res.status).toBe(422);
    expect(String(res.json.error)).toMatch(/took too long/);
    expect((await ticketOf(t.number)).draftCheckedAt).not.toBeNull();
    expect(await issues()).toHaveLength(0);
    // A retry delivered anyway finds the ticket checked: no second call.
    expect((await run('article-drafts', {ticketId: t.id}, {attempt: 2, maxAttempts: 4})).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("an 'edit' with no cited article is a new one", async () => {
    const t = await solvedTicket();
    answer = async () => ok(draft({action: 'edit', conflict: true}));
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(await issues()).toEqual([expect.objectContaining({type: 'gap', articleId: null})]);
  });

  it('AI off (no key, cap 0) or the cap reached: checked, no issue, no call', async () => {
    const t1 = await solvedTicket();
    delete env.ANTHROPIC_API_KEY;
    expect((await run('article-drafts', {ticketId: t1.id})).status).toBe(200);
    expect((await ticketOf(t1.number)).draftCheckedAt).not.toBeNull();

    env.ANTHROPIC_API_KEY = KEY;
    const t2 = await solvedTicket();
    await resetHelpdeskSettings('claude-opus-5-5', 0);
    expect((await run('article-drafts', {ticketId: t2.id})).status).toBe(200);
    expect((await ticketOf(t2.number)).draftCheckedAt).not.toBeNull();

    await resetHelpdeskSettings('claude-opus-5-5', 1);
    const t3 = await solvedTicket();
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await db.aiUsage.upsert({where: {month}, create: {month, spentMicros: 10_000n, requests: 1}, update: {spentMicros: 10_000n}});
    expect((await run('article-drafts', {ticketId: t3.id})).status).toBe(200);
    expect((await ticketOf(t3.number)).draftCheckedAt).not.toBeNull();

    expect(calls).toHaveLength(0);
    expect(await issues()).toHaveLength(0);
  });

  it('a busy minute retries (500) without marking', async () => {
    const t = await solvedTicket();
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count") VALUES ('ai-draft', date_trunc('minute', now()), 10)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = 10`;
    const res = await run('article-drafts', {ticketId: t.id});
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
    expect((await ticketOf(t.number)).draftCheckedAt).toBeNull();
  });

  it('a provider failure retries (500); the last attempt marks it checked; the hold is released', async () => {
    const t = await solvedTicket();
    answer = async () => ({ok: false, reason: 'http'});
    const retry = await run('article-drafts', {ticketId: t.id}, {attempt: 1, maxAttempts: 4});
    expect(retry.status).toBe(500);
    expectNoLeak(retry.json, [KEY, '@', 'grinder', 'Error:'], 'job error');
    expect((await ticketOf(t.number)).draftCheckedAt).toBeNull();
    answer = async () => ok('not json');
    const last = await run('article-drafts', {ticketId: t.id}, {attempt: 4, maxAttempts: 4});
    expect(last.status).toBe(200);
    expect((await ticketOf(t.number)).draftCheckedAt).not.toBeNull();
    expect(await issues()).toHaveLength(0);
    expect(calls).toHaveLength(2);
    // An HTTP error is free; an unreadable reply costs its tokens (24,000 µ$, as the hand-off's
    // summary does): the holds (120,000 µ$ each) are released.
    const spent = Number((await db.aiUsage.findFirst({select: {spentMicros: true}}))?.spentMicros ?? 0);
    expect(spent).toBe(48_000);
  });

  it('deleting the ticket deletes its draft; an unknown id is done; bad data is DontRetry (422)', async () => {
    const t = await solvedTicket();
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect(await issues()).toHaveLength(1);
    await db.conversation.deleteMany({});
    expect(await issues()).toHaveLength(0);
    expect((await run('article-drafts', {ticketId: t.id})).status).toBe(200);
    expect((await run('article-drafts', {ticketId: 987654})).status).toBe(200);
    for (const data of [null, {}, {ticketId: 'x'}, {ticketId: -1}, {ticketId: 1.5}]) {
      expect((await run('article-drafts', data)).status, JSON.stringify(data)).toBe(422);
    }
  });

  describe('health-drafts', () => {
    async function pendingIssue(over: Record<string, unknown> = {}): Promise<number> {
      const row = await db.healthIssue.create({
        data: {
          type: 'gap',
          fingerprint: `test:${newKey()}`,
          evidence: {source: 'weekly', questions: 2, samples: ['Do you offer barista classes?', `Email me at ${CUSTOMER_EMAIL} about classes`]},
          draftState: 'pending',
          draftAttempts: 1,
          ...over,
        },
        select: {id: true},
      });
      return row.id;
    }
    const issueOf = (id: number) => db.healthIssue.findUniqueOrThrow({where: {id}});

    it('pending → ready with the draft; the samples are masked in the prompt; a repeat makes no call', async () => {
      const id = await pendingIssue();
      expect((await run('health-drafts', {issueId: id})).status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0]!.req.messages)).toContain('barista classes');
      expectNoLeak(calls[0]!.req, [CUSTOMER_EMAIL], 'issue prompt');
      expect(await issueOf(id)).toMatchObject({draftState: 'ready', draftError: null, suggestedTitle: 'Cleaning your grinder'});
      expect((await run('health-drafts', {issueId: id})).status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("'none' → failed with the reason; off → failed/off; not pending or not open → nothing", async () => {
      const none = await pendingIssue();
      answer = async () => ok(draft({action: 'none', title: '', body: ''}));
      expect((await run('health-drafts', {issueId: none})).status).toBe(200);
      const row = await issueOf(none);
      expect(row).toMatchObject({draftState: 'failed', draftError: 'failed'});
      expect((row.evidence as Record<string, unknown>).noDraftReason).toBeTruthy();

      delete env.ANTHROPIC_API_KEY;
      const off = await pendingIssue();
      expect((await run('health-drafts', {issueId: off})).status).toBe(200);
      expect(await issueOf(off)).toMatchObject({draftState: 'failed', draftError: 'off'});

      env.ANTHROPIC_API_KEY = KEY;
      const ready = await pendingIssue({draftState: 'ready'});
      const dismissed = await pendingIssue({state: 'dismissed', resolvedAt: new Date(), draftState: 'pending'});
      calls.length = 0;
      expect((await run('health-drafts', {issueId: ready})).status).toBe(200);
      expect((await run('health-drafts', {issueId: dismissed})).status).toBe(200);
      expect((await run('health-drafts', {issueId: 987654})).status).toBe(200);
      expect(calls).toHaveLength(0);
    });

    it('a timed-out call fails the draft at once (DontRetry)', async () => {
      const id = await pendingIssue();
      answer = async () => ({ok: false, reason: 'timeout'});
      expect((await run('health-drafts', {issueId: id}, {attempt: 1, maxAttempts: 3})).status).toBe(422);
      expect(await issueOf(id)).toMatchObject({draftState: 'failed', draftError: 'failed'});
    });

    it('a busy minute retries, but the last attempt fails the draft instead of leaving it pending', async () => {
      const id = await pendingIssue();
      await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count") VALUES ('ai-draft', date_trunc('minute', now()), 10)
        ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = 10`;
      expect((await run('health-drafts', {issueId: id}, {attempt: 1, maxAttempts: 3})).status).toBe(500);
      expect((await issueOf(id)).draftState).toBe('pending');
      expect((await run('health-drafts', {issueId: id}, {attempt: 3, maxAttempts: 3})).status).toBe(500);
      expect(await issueOf(id)).toMatchObject({draftState: 'failed', draftError: 'failed'});
      expect(calls).toHaveLength(0);
    });

    it('in the Preview (one local run) an unreadable draft fails it at once', async () => {
      const id = await pendingIssue();
      answer = async () => ok('not json');
      await inRequestScope(async () => {
        await runHealthDraftJob(db as never, id, {attempt: 1, maxAttempts: 3, local: true});
      });
      expect(await issueOf(id)).toMatchObject({draftState: 'failed', draftError: 'failed'});
    });

    it('an unreadable draft retries, then fails on the last attempt', async () => {
      const id = await pendingIssue();
      answer = async () => ok('{"action":"new"}');
      expect((await run('health-drafts', {issueId: id}, {attempt: 1, maxAttempts: 3})).status).toBe(500);
      expect((await issueOf(id)).draftState).toBe('pending');
      expect((await run('health-drafts', {issueId: id}, {attempt: 3, maxAttempts: 3})).status).toBe(200);
      expect(await issueOf(id)).toMatchObject({draftState: 'failed', draftError: 'failed'});
    });
  });
});
