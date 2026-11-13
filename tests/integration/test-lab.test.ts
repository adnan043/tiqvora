import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {aiModelOf, costMicros, costMicrosFor} from '../../src/lib/ai-models';
import type {KbManageArticle, KbManageCategory} from '../../src/lib/kb-types';
import type {TestCaseRow, TestCasesPage, TestRunView} from '../../src/lib/test-lab';
import {setCacheModeForTests} from '../../src/platform/cache';
import {ensurePermissions} from '../../src/platform/permission-sync';
import {inRequestScope} from '../../src/platform/request-scope';
import {type ProviderMessage, type ProviderResult, setAiProviderForTests} from '../../src/server/ai/provider';
import {app} from '../../src/server/app';
import {runTestLabBatch} from '../../src/server/knowledge/test-lab';
import {CATALOGUE, PERMISSIONS} from '../../src/server/permissions';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, DATABASE_URL, db, ORIGIN, resetDatabase, resetHelpdeskSettings, setRateWindow, signedIn, userId} from './support/harness';

/** Jobs the code sends are captured (never run inline); `refuse` makes the next sends fail as the platform would. */
const sent = vi.hoisted(() => ({jobs: [] as {list: string; data: {runId: number; after: number}; options: Record<string, unknown>}[], refuse: false as false | string}));

/** The assistant's prompt is plain text (no content blocks): narrow it. */
const textOf = (content: ProviderMessage['content']): string => (typeof content === 'string' ? content : JSON.stringify(content));

vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data: {runId: number; after: number}, options: Record<string, unknown> = {}) => {
      if (sent.refuse) throw new real.JobRejected('Refused.', sent.refuse, sent.refuse === 'E_JOBS_RATE_LIMITED' ? 429 : 422);
      sent.jobs.push({list, data, options});
      return {id: `job_t${sent.jobs.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});

/**
 * Test Lab (p4 design §5.5, §7.2, §11): the routes behind site:helpdesk:settings, the case rules
 * (unique key, 500 limit, published article, hand-off cases), "Run all" twice at once, the batch
 * job end to end (pass rules, cursor, counters, cost), a duplicate delivery, cancel, the monthly
 * cap, AI off, the per-minute window, and that it writes no question_logs. Real Postgres, fake provider.
 */
const KEY = 'fake-anthropic-key-for-tests-0123456789';
const MODEL = 'claude-opus-5-5';
const ROLE = 'tl-admin';
const WORDS = ['apple', 'banana', 'cherry', 'damson', 'elderberry', 'figs', 'grape', 'honeydew', 'kiwis', 'lemon', 'mango', 'nectarine'];
const REFUND_BODY = `Everything about refunds.\n\n## How to ask\n\nWrite to us within 30 days for a refund of your order.\n\n## Refund words\n\nrefund ${WORDS.join(' ')}`;
const SHIP_BODY = 'Where we ship.\n\n## Canada\n\nWe ship to Canada in 5 to 8 days.';

vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

describe.skipIf(!DATABASE_URL)('Test Lab (integration, real Postgres, fake provider)', () => {
  let admin: Browser;
  let member: Browser;
  let guest: Browser;
  let refundId: number;
  let shipId: number;
  let draftId: number;
  let calls: string[];
  /** The fake model's reply for a prompt (by its last user message). */
  let reply: (prompt: string) => Record<string, unknown>;

  const ok = (text: string): ProviderResult => ({
    ok: true,
    text,
    inputTokens: 100,
    outputTokens: 50,
    attempts: [{model: MODEL, inputTokens: 100, outputTokens: 50}],
    stopReason: 'end_turn',
    refused: false,
  });
  const CALL_COST = costMicrosFor(MODEL, 100, 50);
  const HOLD = costMicros(aiModelOf(MODEL), 8000, 3000);

  const batch = (runId: number, after: number, job: {attempt?: number; maxAttempts?: number; local?: boolean} = {}, siteUrl: string | null = ORIGIN) =>
    inRequestScope(() => runTestLabBatch(db, {runId, after}, {attempt: 1, maxAttempts: 3, local: false, ...job}, siteUrl));
  /** Runs every captured batch job in order until the chain ends. */
  async function drain() {
    let i = 0;
    while (i < sent.jobs.length) {
      const job = sent.jobs[i++]!;
      await batch(job.data.runId, job.data.after);
    }
  }
  const addCase = (body: Record<string, unknown>) => admin.post('/site-api/helpdesk/test-lab/cases', body);
  const runOf = (id: number) => db.testRun.findUniqueOrThrow({where: {id}});
  const caseBy = (question: string) => db.testCase.findFirstOrThrow({where: {question}});
  const spent = async () => Number((await db.aiUsage.findFirst({select: {spentMicros: true}}))?.spentMicros ?? 0);
  const startRun = async () => {
    const res = await admin.post('/site-api/helpdesk/test-lab/runs');
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    return (res.json.run as TestRunView).id;
  };

  beforeAll(configureEnv);
  afterAll(async () => {
    setCacheModeForTests(null);
    setAiProviderForTests(null);
    delete env.ANTHROPIC_API_KEY;
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    setCacheModeForTests('memory');
    await resetHelpdeskSettings(MODEL, 2000);
    env.ANTHROPIC_API_KEY = KEY;
    sent.jobs.length = 0;
    sent.refuse = false;
    calls = [];
    reply = () => ({answer: 'Write to us within 30 days [1].', citations: [1], confidence: 'high', needsHuman: false, followUps: []});
    setAiProviderForTests(async (_key, req) => {
      const last = textOf(req.messages[req.messages.length - 1]?.content ?? '');
      calls.push(last);
      return ok(JSON.stringify(reply(last)));
    });

    await ensurePermissions(db, CATALOGUE);
    const role = await db.role.create({data: {slug: ROLE, name: 'Test Lab admin', description: null}, select: {id: true}});
    const perms = await db.permission.findMany({where: {codename: {in: [PERMISSIONS.KB_EDIT, PERMISSIONS.HELPDESK_SETTINGS]}}, select: {id: true}});
    await db.rolePermission.createMany({data: perms.map(p => ({roleId: role.id, permissionId: p.id}))});
    admin = await signedIn(app, 'tl-admin@example.test', undefined, '203.0.113.81');
    member = await signedIn(app, 'tl-member@example.test', undefined, '203.0.113.82');
    for (const [email, slugs] of [
      ['tl-admin@example.test', ['member', ROLE]],
      ['tl-member@example.test', ['member']],
    ] as const) {
      const id = await userId(email);
      const roles = await db.role.findMany({where: {slug: {in: [...slugs]}}, select: {id: true}});
      await db.userRole.deleteMany({where: {userId: id}});
      await db.userRole.createMany({data: roles.map(r => ({userId: id, roleId: r.id}))});
    }
    guest = new Browser(app, '203.0.113.83');

    const cat = await admin.post('/site-api/kb/manage/categories', {name: 'Orders'});
    expect(cat.status, JSON.stringify(cat.json)).toBe(201);
    const categoryId = (cat.json.category as KbManageCategory).id;
    const make = async (title: string, body: string, status?: string) => {
      const res = await admin.post('/site-api/kb/manage/articles', {title, categoryId, body, ...(status ? {status} : {})});
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      return (res.json.article as KbManageArticle).id;
    };
    refundId = await make('Refunds and returns', REFUND_BODY, 'published');
    shipId = await make('Shipping to Canada', SHIP_BODY, 'published');
    draftId = await make('Secret plan', 'Not public yet.', undefined);
    await db.helpdeskHumanTopic.create({data: {keyword: 'allergy'}});
  });

  it('answers 401 to a guest and 403 without site:helpdesk:settings on every route; 404 for unknown ids', async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/site-api/helpdesk/test-lab/cases'],
      ['POST', '/site-api/helpdesk/test-lab/cases', {question: 'Do you ship to Canada?'}],
      ['POST', '/site-api/helpdesk/test-lab/cases/import', {text: 'Do you ship to Canada?'}],
      ['PATCH', '/site-api/helpdesk/test-lab/cases/1', {question: 'Do you ship to Canada?'}],
      ['DELETE', '/site-api/helpdesk/test-lab/cases/1'],
      ['GET', '/site-api/helpdesk/test-lab/articles?q='],
      ['POST', '/site-api/helpdesk/test-lab/runs', {}],
      ['GET', '/site-api/helpdesk/test-lab/runs/current'],
      ['POST', '/site-api/helpdesk/test-lab/runs/1/cancel', {}],
    ];
    for (const [method, path, body] of routes) {
      expect((await guest.request(method, path, body)).status, `${method} ${path}`).toBe(401);
      expect((await member.request(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await admin.patch('/site-api/helpdesk/test-lab/cases/999', {question: 'Do you ship to Canada?'})).status).toBe(404);
    expect((await admin.delete('/site-api/helpdesk/test-lab/cases/999')).status).toBe(404);
    expect((await admin.delete('/site-api/helpdesk/test-lab/cases/abc')).status).toBe(404);
    expect((await admin.post('/site-api/helpdesk/test-lab/runs/999/cancel')).status).toBe(404);
    expect(await db.testCase.count()).toBe(0);
  });

  it('adds, edits and deletes cases with the rules: unique key, published article, hand-off cases, validation', async () => {
    const created = await addCase({question: '  Do you   ship to Canada? ', expectedArticleId: shipId});
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const row = created.json.case as TestCaseRow;
    expect(row).toMatchObject({question: 'Do you ship to Canada?', expect: 'answer', expectedArticle: {id: shipId, title: 'Shipping to Canada', status: 'published'}, lastOutcome: null, lastSources: []});

    // The same question, typed differently → duplicate.
    const dup = await addCase({question: 'do you ship to canada'});
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({error: 'duplicate', fields: {question: 'That question is already in the list.'}});
    // A draft or missing article.
    for (const id of [draftId, 99999]) {
      const bad = await addCase({question: 'What is the secret plan?', expectedArticleId: id});
      expect(bad.status).toBe(422);
      expect((bad.json.fields as Record<string, string>).expectedArticleId).toBe('Pick a published article.');
    }
    // A hand-off case has no expected article.
    const handoffArticle = await addCase({question: 'Can I get a refund?', expect: 'handoff', expectedArticleId: refundId});
    expect(handoffArticle.status).toBe(422);
    expect((handoffArticle.json.fields as Record<string, string>).expectedArticleId).toBe('A hand-off case has no expected article.');
    for (const body of [{question: 'ab'}, {question: 'x'.repeat(501)}, {question: 42}, {question: 'Fine question', expect: 'maybe'}, {question: 'Fine question', expectedArticleId: '3'}]) {
      expect((await addCase(body)).status, JSON.stringify(body)).toBe(422);
    }

    const handoff = await addCase({question: 'Can I get a refund?', expect: 'handoff'});
    expect(handoff.status).toBe(201);
    const handoffId = (handoff.json.case as TestCaseRow).id;
    // An article on a stored hand-off case → 422, never the CHECK's 500.
    const patchBad = await admin.patch(`/site-api/helpdesk/test-lab/cases/${handoffId}`, {expectedArticleId: refundId});
    expect(patchBad.status).toBe(422);
    expect((patchBad.json.fields as Record<string, string>).expectedArticleId).toBe('A hand-off case has no expected article.');
    // Switching to hand-off drops the article; the old result is cleared.
    await db.testCase.update({where: {id: row.id}, data: {lastOutcome: 'pass', lastPassed: true, lastAnswer: 'old', lastRunId: 7}});
    const toHandoff = await admin.patch(`/site-api/helpdesk/test-lab/cases/${row.id}`, {expect: 'handoff'});
    expect(toHandoff.status, JSON.stringify(toHandoff.json)).toBe(200);
    expect(toHandoff.json.case).toMatchObject({expect: 'handoff', expectedArticle: null, lastOutcome: null, lastPassed: null, lastAnswer: null, lastRunId: null});
    // Renaming onto another case's question → duplicate.
    expect((await admin.patch(`/site-api/helpdesk/test-lab/cases/${row.id}`, {question: 'can I get a refund!'})).status).toBe(409);
    expect((await admin.patch(`/site-api/helpdesk/test-lab/cases/${row.id}`, {})).status).toBe(422);
    const back = await admin.patch(`/site-api/helpdesk/test-lab/cases/${row.id}`, {expect: 'answer', expectedArticleId: shipId, question: 'Do you ship to Canada fast?'});
    expect(back.status).toBe(200);
    expect(back.json.case).toMatchObject({question: 'Do you ship to Canada fast?', expect: 'answer', expectedArticle: {id: shipId}});

    expect((await admin.delete(`/site-api/helpdesk/test-lab/cases/${handoffId}`)).status).toBe(200);
    expect((await admin.delete(`/site-api/helpdesk/test-lab/cases/${handoffId}`)).status).toBe(404);
    expect(await db.auditEvent.count({where: {action: 'test_lab_case_deleted'}})).toBe(1);

    // The picker lists published articles only.
    const articles = await admin.get('/site-api/helpdesk/test-lab/articles?q=');
    expect((articles.json.items as {id: number}[]).map(a => a.id).sort()).toEqual([refundId, shipId].sort());
    const search = await admin.get('/site-api/helpdesk/test-lab/articles?q=CANADA');
    expect(search.json.items).toEqual([{id: shipId, title: 'Shipping to Canada'}]);
    // LIKE wildcards are taken literally.
    for (const q of ['%25', '_', 'Shipping_to', '%5C']) {
      const res = await admin.get(`/site-api/helpdesk/test-lab/articles?q=${q}`);
      expect(res.status, q).toBe(200);
      expect(res.json.items, q).toEqual([]);
    }
    // Control characters in a search → 422, never a 500.
    for (const q of ['%00', 'ship%00', '%C2%85x', '%E2%80%AEx']) {
      const res = await admin.get(`/site-api/helpdesk/test-lab/articles?q=${q}`);
      expect(res.status, q).toBe(422);
      expect(res.json.fields, q).toEqual({q: "The search has characters that can't be used."});
    }
  });

  it('refuses C1, bidi and other control characters in a question; strips zero-width ones', async () => {
    for (const ch of ['\u0000', '\u0085', '\u009b', '\u202e', '\u2067']) {
      const res = await addCase({question: `Do you ${ch}ship to Canada?`});
      expect(res.status, JSON.stringify(ch)).toBe(422);
      expect((res.json.fields as Record<string, string>).question).toBe("The question has characters that can't be saved. Type it again.");
    }
    const created = await addCase({question: 'Do\u200b you ship\ufeff to Canada?'});
    expect(created.status).toBe(201);
    expect((created.json.case as TestCaseRow).question).toBe('Do you ship to Canada?');
    // The same question with an invisible character is the same question.
    expect((await addCase({question: 'Do you ship to\u2060 Canada'})).status).toBe(409);
    const id = (created.json.case as TestCaseRow).id;
    expect((await admin.patch(`/site-api/helpdesk/test-lab/cases/${id}`, {question: 'Ship \u202a to Canada?'})).status).toBe(422);
    const imported = await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: 'Fine one\nBad \u2066 one\nAlso fine'});
    expect(imported.status).toBe(422);
    expect(imported.json.fields).toEqual({text: "Line 2 has characters that can't be saved."});
    expect(imported.json.lines).toEqual([{line: 2, message: "Line 2 has characters that can't be saved."}]);
    expect(await db.testCase.count()).toBe(1);
  });

  it('imports lines: deduped, counts duplicates, stops at 500, refuses bad lines', async () => {
    await addCase({question: 'Do you ship to Canada?'});
    const res = await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: 'Do you ship to Canada\n\n  How do refunds work?\nhow do refunds work\r\nIs there decaf?\n'});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({added: 2, duplicates: 1, overLimit: 0});

    const tooLong = await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: `Fine line\n\n${'x'.repeat(501)}`});
    expect(tooLong.status).toBe(422);
    expect((tooLong.json.fields as Record<string, string>).text).toBe('Line 3 is too long: up to 500 characters.');
    expect((await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: '\n \n'})).status).toBe(422);
    expect((await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: Array.from({length: 101}, (_, i) => `Question ${i}`).join('\n')})).status).toBe(422);

    // Fill to 497: 3 fit, 2 don't.
    const me = await userId('tl-admin@example.test');
    await db.testCase.createMany({data: Array.from({length: 494}, (_, i) => ({question: `Filler ${i}`, questionKey: `filler ${i}`, createdBy: me}))});
    expect(await db.testCase.count()).toBe(497);
    const full = await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: ['One more', 'Two more', 'Three more', 'Four more', 'Five more'].join('\n')});
    expect(full.json).toEqual({added: 3, duplicates: 0, overLimit: 2});
    expect(await db.testCase.count()).toBe(500);
    const single = await addCase({question: 'Six more'});
    expect(single.status).toBe(409);
    expect(single.json.error).toBe('limit');

    const page = (await admin.get('/site-api/helpdesk/test-lab/cases')).json as unknown as TestCasesPage;
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(500);
    expect(page.next).toBe(page.items[49]!.id);
    expect(page.score.band).toBe('none');
    const second = (await admin.get(`/site-api/helpdesk/test-lab/cases?after=${page.next}`)).json as unknown as TestCasesPage;
    expect(second.items[0]!.id).toBeGreaterThan(page.next!);
    // A cursor past an INT, or not a number, is refused (never silently the first page).
    for (const after of ['2147483648', '99999999999', 'abc', '-1', '01']) {
      expect((await admin.get(`/site-api/helpdesk/test-lab/cases?after=${after}`)).status, after).toBe(422);
    }
    expect(((await admin.get('/site-api/helpdesk/test-lab/cases?after=2147483647')).json as unknown as TestCasesPage).items).toEqual([]);
  });

  it('the same paste imported twice at once: added once, the rest duplicates, never over the limit', async () => {
    const text = Array.from({length: 20}, (_, i) => `Parallel question ${i}`).join('\n');
    const results = await Promise.all([1, 2, 3].map(() => admin.post('/site-api/helpdesk/test-lab/cases/import', {text})));
    for (const res of results) {
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.overLimit).toBe(0);
      expect((res.json.added as number) + (res.json.duplicates as number)).toBe(20);
    }
    expect(results.reduce((sum, res) => sum + (res.json.added as number), 0)).toBe(20);
    expect(await db.testCase.count()).toBe(20);
  });

  it('"Run all" twice at once: one run, one job, one 409 run_active; the cases are locked while it runs', async () => {
    expect((await admin.post('/site-api/helpdesk/test-lab/runs')).json.error).toBe('no_cases');
    await addCase({question: 'Do you ship to Canada?'});
    const [a, b] = await Promise.all([admin.post('/site-api/helpdesk/test-lab/runs'), admin.post('/site-api/helpdesk/test-lab/runs')]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.json.error).toBe('run_active');
    expect((conflict.json.run as TestRunView).state).toBe('running');
    expect(await db.testRun.count({where: {state: 'running'}})).toBe(1);
    expect(sent.jobs).toHaveLength(1);
    expect(sent.jobs[0]!.options.key).toMatch(/^testlab-\d+-0$/);

    const id = (await caseBy('Do you ship to Canada?')).id;
    expect((await addCase({question: 'Another one?'})).json.error).toBe('run_active');
    expect((await admin.patch(`/site-api/helpdesk/test-lab/cases/${id}`, {question: 'Changed?'})).json.error).toBe('run_active');
    expect((await admin.delete(`/site-api/helpdesk/test-lab/cases/${id}`)).json.error).toBe('run_active');
    expect((await admin.post('/site-api/helpdesk/test-lab/cases/import', {text: 'New one'})).json.error).toBe('run_active');
    expect(await db.auditEvent.count({where: {action: 'test_lab_run_started'}})).toBe(1);
  });

  it('runs every case in batches, scores them by the pass rules, records the cost, writes no question_logs', async () => {
    reply = prompt =>
      prompt.includes('<question>refund banana</question>')
        ? {answer: 'Not sure.', citations: [1], confidence: 'low', needsHuman: false, followUps: []}
        : {answer: 'Write to us within 30 days [1].', citations: [1], confidence: 'high', needsHuman: false, followUps: []};
    const cases: Record<string, unknown>[] = [
      {question: 'refund apple', expectedArticleId: refundId}, // pass
      {question: 'refund banana'}, // low confidence → handoff
      {question: 'refund cherry', expectedArticleId: shipId}, // wrong_source
      {question: 'Can I talk to a person about a refund?'}, // person
      {question: 'Can I speak to a real person please?', expect: 'handoff'}, // pass (a rule)
      {question: 'refund damson', expect: 'handoff'}, // answered_instead
      {question: 'xylophone quasar nebulosity'}, // no_source
      {question: 'refund elderberry'}, // pass (any article)
      {question: 'refund figs'},
      {question: 'refund grape'},
      {question: 'refund honeydew'}, // the 11th: a second batch
      {question: 'refund kiwis'},
    ];
    for (const body of cases) expect((await addCase(body)).status, JSON.stringify(body)).toBe(201);
    const statsBefore = await db.questionStatsDaily.count();

    const runId = await startRun();
    await drain();
    expect(sent.jobs.map(j => j.data.after)).toEqual([0, (await caseBy('refund grape')).id]);

    const outcome = async (q: string) => {
      const row = await caseBy(q);
      return [row.lastOutcome, row.lastPassed, row.lastRunId];
    };
    expect(await outcome('refund apple')).toEqual(['pass', true, runId]);
    expect(await outcome('refund banana')).toEqual(['handoff', false, runId]);
    expect(await outcome('refund cherry')).toEqual(['wrong_source', false, runId]);
    expect(await outcome('Can I talk to a person about a refund?')).toEqual(['person', false, runId]);
    expect(await outcome('Can I speak to a real person please?')).toEqual(['pass', true, runId]);
    expect(await outcome('refund damson')).toEqual(['answered_instead', false, runId]);
    expect(await outcome('xylophone quasar nebulosity')).toEqual(['no_source', false, runId]);
    expect(await outcome('refund kiwis')).toEqual(['pass', true, runId]);
    const apple = await caseBy('refund apple');
    expect(apple.lastSources).toEqual([{id: refundId, title: 'Refunds and returns', url: '/help/articles/refunds-and-returns/'}]);
    expect(apple.lastConfidence).toBe('high');
    expect(apple.lastAnswer).toBe('Write to us within 30 days.');

    const run = await runOf(runId);
    expect(run).toMatchObject({state: 'done', total: 12, done: 12, passed: 7, stopReason: null});
    expect(run.finishedAt).not.toBeNull();
    // 9 calls: not the two rule hand-offs, not the no_source.
    expect(calls).toHaveLength(9);
    expect(Number(run.costMicros)).toBe(9 * CALL_COST);
    expect(await spent()).toBe(9 * CALL_COST);
    expect(await db.questionLog.count()).toBe(0);
    expect(await db.questionStatsDaily.count()).toBe(statsBefore);

    const page = (await admin.get('/site-api/helpdesk/test-lab/cases')).json as unknown as TestCasesPage;
    expect(page.run).toMatchObject({id: runId, state: 'done', done: 12, passed: 7});
    expect(page.score).toMatchObject({ran: 12, passed: 7, total: 12});
    expect((await admin.get('/site-api/helpdesk/test-lab/runs/current')).json.run).toMatchObject({id: runId, state: 'done'});
    // A finished run can't be cancelled.
    expect((await admin.post(`/site-api/helpdesk/test-lab/runs/${runId}/cancel`)).status).toBe(409);
  });

  it('a duplicate batch delivery at the same moment advances the run once and sends nothing more', async () => {
    for (const w of WORDS.slice(0, 11)) await addCase({question: `refund ${w}`});
    const runId = await startRun();
    sent.jobs.length = 0;
    await Promise.all([batch(runId, 0), batch(runId, 0)]);
    const run = await runOf(runId);
    expect(run).toMatchObject({state: 'running', done: 10, passed: 10});
    expect(sent.jobs).toHaveLength(1);
    // Written once: both deliveries spent (at-least-once), only one is counted on the run.
    expect(Number(run.costMicros)).toBe(10 * CALL_COST);
    expect(await db.testCase.count({where: {lastRunId: runId}})).toBe(10);
    // A late third delivery of the same batch is a no-op.
    calls.length = 0;
    await batch(runId, 0);
    expect(calls).toHaveLength(0);
    await drain();
    expect(await runOf(runId)).toMatchObject({state: 'done', done: 11, passed: 11});
  });

  it('cancel mid-run: the next batch stops, cases already asked keep their results', async () => {
    for (const w of WORDS.slice(0, 11)) await addCase({question: `refund ${w}`});
    const runId = await startRun();
    await batch(runId, 0);
    const cancel = await admin.post(`/site-api/helpdesk/test-lab/runs/${runId}/cancel`);
    expect(cancel.status).toBe(200);
    expect((cancel.json.run as TestRunView).state).toBe('cancelled');
    calls.length = 0;
    await drain();
    expect(calls).toHaveLength(0);
    expect(await runOf(runId)).toMatchObject({state: 'cancelled', done: 10});
    expect(await db.testCase.count({where: {lastRunId: runId}})).toBe(10);
    expect((await admin.post(`/site-api/helpdesk/test-lab/runs/${runId}/cancel`)).json.error).toBe('changed');
    // Editing is open again.
    expect((await addCase({question: 'After the run?'})).status).toBe(201);
  });

  it('the monthly cap: only what fits is asked, the rest is skipped (not scored), the run stops on cap', async () => {
    for (const w of WORDS.slice(0, 10)) await addCase({question: `refund ${w}`});
    // Room for 3 holds at once (spent < cap before each reserve). 4 are asked at a time and each
    // hold is settled to its real (smaller) cost as it answers, so a few more fit, never all 10.
    const capCents = Math.ceil((2.5 * HOLD) / 10_000);
    await db.helpdeskSettings.update({where: {id: 1}, data: {monthlyCapCents: capCents}});
    const runId = await startRun();
    await drain();
    const asked = calls.length;
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(asked).toBeLessThan(10);
    const run = await runOf(runId);
    expect(run).toMatchObject({state: 'stopped', stopReason: 'cap', done: asked, passed: asked});
    expect(await db.testCase.count({where: {lastOutcome: 'cap', lastPassed: null}})).toBe(10 - asked);
    expect(await spent()).toBe(asked * CALL_COST);
    expect(await spent()).toBeLessThanOrEqual(capCents * 10_000);
    expect(sent.jobs).toHaveLength(1);
  });

  it('AI off: 409 at Run all without a key; a run whose key went away stops as ai_off', async () => {
    await addCase({question: 'refund apple'});
    delete env.ANTHROPIC_API_KEY;
    expect((await admin.post('/site-api/helpdesk/test-lab/runs')).json.error).toBe('ai_off');
    env.ANTHROPIC_API_KEY = KEY;
    await db.helpdeskSettings.update({where: {id: 1}, data: {monthlyCapCents: 0}});
    expect((await admin.post('/site-api/helpdesk/test-lab/runs')).json.error).toBe('ai_off');
    await db.helpdeskSettings.update({where: {id: 1}, data: {monthlyCapCents: 2000}});

    const runId = await startRun();
    delete env.ANTHROPIC_API_KEY;
    await drain();
    expect(await runOf(runId)).toMatchObject({state: 'stopped', stopReason: 'ai_off'});
    expect(calls).toHaveLength(0);
  });

  it('a full per-minute window sends the same batch a minute later; a refused send fails the run', async () => {
    await addCase({question: 'refund apple'});
    const runId = await startRun();
    await setRateWindow('ai-testlab-batch', 3, 'minute');
    await batch(runId, 0);
    expect(calls).toHaveLength(0);
    expect(sent.jobs).toHaveLength(2);
    expect(sent.jobs[1]!.data).toEqual({runId, after: 0});
    expect(sent.jobs[1]!.options).toMatchObject({delay: 60});
    expect(String(sent.jobs[1]!.options.key)).toMatch(new RegExp(`^testlab-${runId}-0-w\\d+$`));
    expect((await runOf(runId)).state).toBe('running');

    // Locally a resend would run at once: the run ends instead of looping.
    await batch(runId, 0, {local: true});
    expect(await runOf(runId)).toMatchObject({state: 'failed', stopReason: 'stalled'});

    // Run all whose job the platform refuses → 503, failed/not_started.
    sent.refuse = 'E_JOBS_RATE_LIMITED';
    const res = await admin.post('/site-api/helpdesk/test-lab/runs');
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('not_started');
    expect(await db.testRun.findFirst({orderBy: {id: 'desc'}})).toMatchObject({state: 'failed', stopReason: 'not_started'});
  });

  it('a failed AI call is an error (not scored), for answer and hand-off cases; 4 cases are asked at a time', async () => {
    let inFlight = 0;
    let most = 0;
    setAiProviderForTests(async (_key, req) => {
      const last = textOf(req.messages[req.messages.length - 1]?.content ?? '');
      calls.push(last);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight--;
      if (last.includes('<question>refund apple</question>') || last.includes('<question>refund banana</question>')) {
        return {ok: false, reason: 'http'};
      }
      return ok(JSON.stringify(reply(last)));
    });
    await addCase({question: 'refund apple'});
    await addCase({question: 'refund banana', expect: 'handoff'});
    for (const w of WORDS.slice(2, 10)) await addCase({question: `refund ${w}`});
    const runId = await startRun();
    await drain();
    for (const q of ['refund apple', 'refund banana']) {
      expect(await caseBy(q), q).toMatchObject({lastOutcome: 'error', lastPassed: null, lastAnswer: null, lastRunId: runId});
    }
    expect(await runOf(runId)).toMatchObject({state: 'done', total: 10, done: 8, passed: 8});
    expect(calls).toHaveLength(10);
    expect(most).toBe(4);
  });

  it('a late batch of an older run, or of a case edited since, does not overwrite the newer result', async () => {
    for (const w of WORDS.slice(0, 3)) await addCase({question: `refund ${w}`});
    const runId = await startRun();
    const [apple, banana, cherry] = await Promise.all(['refund apple', 'refund banana', 'refund cherry'].map(caseBy));
    // apple already has a NEWER run's result; banana is renamed while its question is being asked.
    await db.testCase.update({where: {id: apple!.id}, data: {lastOutcome: 'handoff', lastPassed: false, lastRunId: runId + 1}});
    const editing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== '$queryRaw') return Reflect.get(target, prop, receiver);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('').includes('UPDATE "test_runs"')) {
            await target.testCase.update({where: {id: banana!.id}, data: {question: 'refund banana split'}});
          }
          return target.$queryRaw(strings, ...values);
        };
      },
    });
    await inRequestScope(() => runTestLabBatch(editing, {runId, after: 0}, {attempt: 1, maxAttempts: 3}, ORIGIN));
    expect(await db.testCase.findUniqueOrThrow({where: {id: apple!.id}})).toMatchObject({lastOutcome: 'handoff', lastRunId: runId + 1});
    expect(await db.testCase.findUniqueOrThrow({where: {id: banana!.id}})).toMatchObject({lastOutcome: null, lastRunId: null});
    expect(await db.testCase.findUniqueOrThrow({where: {id: cherry!.id}})).toMatchObject({lastOutcome: 'pass', lastRunId: runId});
    expect(await runOf(runId)).toMatchObject({state: 'done', done: 1, passed: 1});
  });

  it('a next batch the platform refuses for a moment: the job is tried again and its retry sends it; on the last try the run fails', async () => {
    for (const w of WORDS.slice(0, 11)) await addCase({question: `refund ${w}`});
    const runId = await startRun();
    sent.jobs.length = 0;
    sent.refuse = 'E_JOBS_RATE_LIMITED';
    await expect(batch(runId, 0)).rejects.toThrow('The next Test Lab batch could not be sent yet.');
    const tenth = (await caseBy('refund lemon')).id;
    expect(await runOf(runId)).toMatchObject({state: 'running', done: 10, cursor: tenth});
    // The retry (same job, after 0): no new calls, the batch at the run's cursor is sent.
    sent.refuse = 'E_JOBS_UNREACHABLE';
    calls.length = 0;
    await expect(batch(runId, 0, {attempt: 2})).rejects.toThrow('could not be sent yet');
    expect(await runOf(runId)).toMatchObject({state: 'running'});
    sent.refuse = false;
    await batch(runId, 0, {attempt: 3});
    expect(calls).toHaveLength(0);
    expect(sent.jobs.map(j => j.data)).toEqual([{runId, after: tenth}]);
    expect(sent.jobs[0]!.options.key).toBe(`testlab-${runId}-${tenth}`);
    await drain();
    expect(await runOf(runId)).toMatchObject({state: 'done', done: 11});

    // Still refused on the last try → failed/stalled at the run's cursor.
    const second = await startRun();
    sent.refuse = 'E_JOBS_RATE_LIMITED';
    await expect(batch(second, 0, {attempt: 3})).rejects.toThrow('could not be sent yet');
    expect(await runOf(second)).toMatchObject({state: 'failed', stopReason: 'stalled', done: 10});

    // Refused for good (not a passing refusal) → the run ends at once, nothing thrown. (A new
    // minute for Test Lab's window: three batches went this minute.)
    await db.$executeRaw`DELETE FROM "rate_windows"`;
    sent.refuse = false;
    const third = await startRun();
    sent.refuse = 'E_JOBS_BAD_LIST';
    await batch(third, 0);
    expect(await runOf(third)).toMatchObject({state: 'failed', stopReason: 'stalled', done: 10});
  });

  it("no site address: the batch ends the run (failed/stalled) before asking anything", async () => {
    await addCase({question: 'refund apple'});
    const runId = await startRun();
    await batch(runId, 0, {}, null);
    expect(await runOf(runId)).toMatchObject({state: 'failed', stopReason: 'stalled'});
    expect(calls).toHaveLength(0);
  });

  it('a bad job input fails at once; a database error on the last try ends the run as failed/error', async () => {
    await expect(inRequestScope(() => runTestLabBatch(db, {runId: 0, after: 0}, {attempt: 1, maxAttempts: 3}, ORIGIN))).rejects.toThrow('Bad Test Lab run.');
    await expect(inRequestScope(() => runTestLabBatch(db, {runId: 2147483648, after: 0}, {attempt: 1, maxAttempts: 3}, ORIGIN))).rejects.toThrow('Bad Test Lab run.');
    await expect(inRequestScope(() => runTestLabBatch(db, {runId: 1, after: 2147483648}, {attempt: 1, maxAttempts: 3}, ORIGIN))).rejects.toThrow('Bad Test Lab run.');
    await expect(inRequestScope(() => runTestLabBatch(db, {runId: 1, after: -1}, {attempt: 1, maxAttempts: 3}, ORIGIN))).rejects.toThrow();
    await addCase({question: 'refund apple'});
    const runId = await startRun();
    // A run whose cursor moved on: an old delivery is a no-op.
    await db.testRun.update({where: {id: runId}, data: {cursor: 5}});
    await batch(runId, 0);
    expect(calls).toHaveLength(0);
    await db.testRun.update({where: {id: runId}, data: {cursor: 0}});
    // The batch write fails (the database refuses it): tried again; on the last attempt → failed/error.
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== '$queryRaw') return Reflect.get(target, prop, receiver);
        return (strings: TemplateStringsArray, ...values: unknown[]) =>
          strings.join('').includes('UPDATE "test_runs"')
            ? Promise.reject(new Error('connection lost'))
            : target.$queryRaw(strings, ...values);
      },
    });
    const failingBatch = (attempt: number) =>
      inRequestScope(() => runTestLabBatch(failing, {runId, after: 0}, {attempt, maxAttempts: 3}, ORIGIN));
    await expect(failingBatch(1)).rejects.toThrow('A Test Lab batch could not be saved.');
    expect((await runOf(runId)).state).toBe('running');
    await expect(failingBatch(3)).rejects.toThrow('A Test Lab batch could not be saved.');
    expect(await runOf(runId)).toMatchObject({state: 'failed', stopReason: 'error'});
  });
});
