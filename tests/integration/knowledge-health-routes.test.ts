import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import type {HealthIssueDetail, HealthIssuesPage} from '../../src/lib/knowledge-health-types';
import {ensurePermissions} from '../../src/platform/permission-sync';
import {app} from '../../src/server/app';
import {CATALOGUE, PERMISSIONS} from '../../src/server/permissions';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, createRole, DATABASE_URL, db, resetDatabase, resetHelpdeskSettings, setRoles, signedIn, userId} from './support/harness';

/** Jobs the routes send are captured, never run inline; `refuse` makes the platform say no. */
const jobs = vi.hoisted(() => ({sent: [] as {list: string; data: unknown; options: Record<string, unknown>}[], refuse: false}));
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options: Record<string, unknown> = {}) => {
      if (jobs.refuse) throw new real.JobRejected('Too many jobs this minute.', 'E_JOBS_RATE_LIMITED', 429);
      jobs.sent.push({list, data, options});
      return {id: `job_t${jobs.sent.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});

/**
 * Knowledge health routes (/site-api/helpdesk/health) and the time zone setting: who may do what,
 * Accept never publishing (a published article gets a separate draft), two reviewers at once
 * (one wins, the other 409), and "Write a draft" claiming at most three tries.
 */
describe.skipIf(!DATABASE_URL)('knowledge health routes (integration, real Postgres)', () => {
  let reviewer: Browser; // reports + kb edit
  let reviewer2: Browser; // reports + kb edit
  let reportsOnly: Browser; // reports, no kb edit
  let agent: Browser; // kb edit + settings, no reports
  let member: Browser;
  let guest: Browser;
  let me: number;
  let categoryId: number;

  const H = '/site-api/helpdesk/health';

  const issue = (data: {type?: string; articleId?: number | null; fingerprint?: string; suggestedTitle?: string; suggestedBody?: string; evidence?: object}) =>
    db.healthIssue
      .create({
        data: {
          type: data.type ?? 'gap',
          articleId: data.articleId ?? null,
          fingerprint: data.fingerprint ?? `fp-${crypto.randomUUID()}`,
          suggestedTitle: data.suggestedTitle ?? 'Visiting the roastery',
          suggestedBody: data.suggestedBody ?? 'SECRET-BODY-SENTINEL how to visit us. [Add: dates]',
          draftState: 'ready',
          evidence: data.evidence ?? {source: 'weekly', questions: 2, noSource: 2, samples: ['Can I visit?', 'Do you run classes?']},
        },
        select: {id: true},
      })
      .then(row => row.id);

  /** A published article made through the KB's own route (chunks + category count). */
  const publishedArticle = async (title: string, body: string) => {
    const res = await reviewer.post('/site-api/kb/manage/articles', {title, body, categoryId, status: 'published'});
    expect(res.status).toBe(201);
    return (res.json.article as {id: number}).id;
  };

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    await ensurePermissions(db, CATALOGUE);
    await createRole('kh-reviewer', [PERMISSIONS.HELPDESK_REPORTS, PERMISSIONS.KB_EDIT]);
    await createRole('kh-reports', [PERMISSIONS.HELPDESK_REPORTS]);
    await createRole('kh-agent', [PERMISSIONS.KB_EDIT, PERMISSIONS.HELPDESK_SETTINGS, PERMISSIONS.HELPDESK_INBOX]);
    reviewer = await signedIn(app, 'kh-reviewer@example.test', undefined, '203.0.113.161');
    me = await setRoles('kh-reviewer@example.test', 'member', 'kh-reviewer');
    reviewer2 = await signedIn(app, 'kh-reviewer2@example.test', undefined, '203.0.113.162');
    await setRoles('kh-reviewer2@example.test', 'member', 'kh-reviewer');
    reportsOnly = await signedIn(app, 'kh-reports@example.test', undefined, '203.0.113.163');
    await setRoles('kh-reports@example.test', 'member', 'kh-reports');
    agent = await signedIn(app, 'kh-agent@example.test', undefined, '203.0.113.164');
    await setRoles('kh-agent@example.test', 'member', 'kh-agent');
    member = await signedIn(app, 'kh-member@example.test', undefined, '203.0.113.165');
    await setRoles('kh-member@example.test', 'member');
    guest = new Browser(app, '203.0.113.166');
  });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE "health_issues", "knowledge_health_runs", "kb_chunks", "kb_articles", "kb_categories", "audit_events" RESTART IDENTITY CASCADE'
    );
    await resetHelpdeskSettings();
    delete env.ANTHROPIC_API_KEY;
    jobs.sent.length = 0;
    jobs.refuse = false;
    categoryId = (await db.kbCategory.create({data: {name: 'Visits', slug: 'visits'}, select: {id: true}})).id;
  });

  it('every route: 401 signed out, 403 without the reports permission, 404 for an unknown id', async () => {
    const id = await issue({});
    const accept = {title: 'Visiting us', body: 'How to visit.', categoryId};
    const routes: [string, string, unknown?][] = [
      ['GET', `${H}?state=open&type=all&before=`],
      ['GET', `${H}/${id}`],
      ['POST', `${H}/${id}/accept`, accept],
      ['POST', `${H}/${id}/dismiss`, {}],
      ['POST', `${H}/${id}/draft`, {}],
    ];
    for (const [method, path, body] of routes) {
      expect((await guest.request(method, path, body)).status, `${method} ${path}`).toBe(401);
      for (const browser of [member, agent]) {
        const res = await browser.request(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(JSON.stringify(res.json)).not.toContain('SECRET-BODY-SENTINEL');
        expect(JSON.stringify(res.json)).not.toContain('Can I visit?');
      }
    }
    // Accept writes an article: reports alone is not enough.
    expect((await reportsOnly.post(`${H}/${id}/accept`, accept)).status).toBe(403);
    expect((await db.healthIssue.findUniqueOrThrow({where: {id}, select: {state: true}})).state).toBe('open');
    expect(await db.kbArticle.count()).toBe(0);

    for (const path of [`${H}/99999`, `${H}/abc`, `${H}/0`]) expect((await reportsOnly.get(path)).status).toBe(404);
    expect((await reviewer.post(`${H}/99999/accept`, accept)).status).toBe(404);
    expect((await reviewer.post(`${H}/99999/dismiss`)).status).toBe(404);
    // Not found wins over "AI off".
    expect((await reviewer.post(`${H}/99999/draft`)).status).toBe(404);
    env.ANTHROPIC_API_KEY = 'fake-key';
    expect((await reviewer.post(`${H}/99999/draft`)).status).toBe(404);
  });

  it('the list: by state and type, keyset pages, capped counts, the last run, never the body', async () => {
    const article = await publishedArticle('Holiday shipping', 'Order by the 18th.');
    for (let i = 0; i < 22; i++) await issue({});
    const stale = await issue({type: 'stale', articleId: article, suggestedTitle: '', evidence: {daysSinceReview: 200, views: 7, junk: {a: 1}}});
    const dismissed = await issue({type: 'low_rated', articleId: article});
    await db.healthIssue.update({where: {id: dismissed}, data: {state: 'dismissed', resolvedAt: new Date(), resolvedBy: me}});
    await db.knowledgeHealthRun.create({
      data: {week: new Date('2026-11-09'), timeZone: 'Europe/Berlin', windowStart: new Date('2026-11-02T06:30Z'), windowEnd: new Date('2026-11-09T06:30Z'), state: 'done', gapsFound: 3},
    });

    const first = await reportsOnly.get(`${H}?state=open&type=all&before=`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toMatch(/no-store/);
    const page = first.json as unknown as HealthIssuesPage;
    expect(page.items).toHaveLength(20);
    expect(page.items[0]!.id).toBe(stale);
    expect(page.items[0]).toMatchObject({type: 'stale', title: 'Holiday shipping', article: {id: article, status: 'published'}});
    expect(page.items[0]!.evidence).toEqual({daysSinceReview: 200, views: 7});
    // Drawer-only evidence (sample questions, summary, missing facts) stays out of list rows.
    expect(JSON.stringify(page)).not.toContain('Can I visit?');
    expect(page.openCounts).toEqual({gap: 22, stale: 1, conflict: 0, low_rated: 0});
    expect(page.lastRun).toMatchObject({week: '2026-11-09', timeZone: 'Europe/Berlin', state: 'done', gaps: 3});
    expect(JSON.stringify(page)).not.toContain('SECRET-BODY-SENTINEL');

    const next = (await reportsOnly.get(`${H}?state=open&type=all&before=${page.next}`)).json as unknown as HealthIssuesPage;
    expect(next.items).toHaveLength(3);
    expect(next.next).toBeNull();

    const gaps = (await reportsOnly.get(`${H}?state=open&type=stale&before=`)).json as unknown as HealthIssuesPage;
    expect(gaps.items.map(row => row.id)).toEqual([stale]);
    const gone = (await reportsOnly.get(`${H}?state=dismissed&type=nonsense&before=1%20OR%201=1`)).json as unknown as HealthIssuesPage;
    expect(gone.items.map(row => row.id)).toEqual([dismissed]);

    const detail = await reportsOnly.get(`${H}/${stale}`);
    expect(detail.status).toBe(200);
    const one = detail.json.issue as HealthIssueDetail;
    expect(one.suggestedBody).toContain('SECRET-BODY-SENTINEL');
    expect(one.article).toMatchObject({id: article, slug: 'holiday-shipping', categoryId});

    // The detail keeps the drawer-only evidence; citedArticleId is kept only as a positive id.
    const rich = await issue({
      type: 'conflict',
      evidence: {source: 'ticket', summary: 'Asked about visits.', missingFacts: ['Opening days'], samples: ['Can I visit?'], citedArticleId: article},
    });
    const badCite = await issue({type: 'conflict', evidence: {citedArticleId: -3}});
    const richDetail = (await reportsOnly.get(`${H}/${rich}`)).json.issue as HealthIssueDetail;
    expect(richDetail.evidence).toEqual({
      source: 'ticket',
      summary: 'Asked about visits.',
      missingFacts: ['Opening days'],
      samples: ['Can I visit?'],
      citedArticleId: article,
    });
    const richRow = ((await reportsOnly.get(`${H}?state=open&type=conflict`)).json as unknown as HealthIssuesPage).items;
    expect(richRow.find(row => row.id === rich)!.evidence).toEqual({source: 'ticket', citedArticleId: article});
    expect(richRow.find(row => row.id === badCite)!.evidence).toEqual({});
  });

  it('two accepts at once: one 200, one 409, exactly one draft article and nothing public changes', async () => {
    const id = await issue({});
    const before = await db.kbCategory.findUniqueOrThrow({where: {id: categoryId}, select: {articleCount: true}});
    const body = {title: 'Visiting the roastery', body: '## Cuppings\n\nEvery Saturday.', categoryId, status: 'published'};
    const [a, b] = await Promise.all([reviewer.post(`${H}/${id}/accept`, body), reviewer2.post(`${H}/${id}/accept`, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b;
    const lost = a.status === 200 ? b : a;
    expect(lost.json.error).toBe('changed');
    expect(won.json).toMatchObject({issue: {id, state: 'accepted'}, article: {status: 'draft', mode: 'created', title: 'Visiting the roastery'}});

    const articles = await db.kbArticle.findMany({select: {id: true, status: true, publishedAt: true}});
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({status: 'draft', publishedAt: null});
    expect(await db.kbChunk.count()).toBe(0);
    expect((await db.kbCategory.findUniqueOrThrow({where: {id: categoryId}, select: {articleCount: true}})).articleCount).toBe(before.articleCount);
    const row = await db.healthIssue.findUniqueOrThrow({where: {id}, select: {state: true, acceptedArticleId: true, resolvedAt: true}});
    expect(row.state).toBe('accepted');
    expect(row.acceptedArticleId).toBe(articles[0]!.id);
    expect(row.resolvedAt).not.toBeNull();
    expect(await db.auditEvent.count({where: {action: 'health_issue_accepted'}})).toBe(1);
  });

  it('accept and dismiss at once: one wins, the other gets 409', async () => {
    const id = await issue({});
    const [a, d] = await Promise.all([
      reviewer.post(`${H}/${id}/accept`, {title: 'Visits', body: 'Come by.', categoryId}),
      reviewer2.post(`${H}/${id}/dismiss`),
    ]);
    expect([a.status, d.status].sort()).toEqual([200, 409]);
    const row = await db.healthIssue.findUniqueOrThrow({where: {id}, select: {state: true}});
    expect(row.state).toBe(a.status === 200 ? 'accepted' : 'dismissed');
    expect(await db.kbArticle.count()).toBe(a.status === 200 ? 1 : 0);
  });

  it('accept on a published article makes a separate draft; the published one, its chunks and /kb are untouched', async () => {
    const live = await publishedArticle('Descaling your espresso machine', 'Descale monthly with citric acid.');
    const chunksBefore = await db.kbChunk.findMany({where: {articleId: live}, select: {id: true, text: true}, orderBy: {id: 'asc'}});
    expect(chunksBefore.length).toBeGreaterThan(0);
    const publicBefore = await guest.get('/site-api/kb/articles/descaling-your-espresso-machine');
    const id = await issue({articleId: live});

    // No category sent: the old article's is used.
    const res = await reviewer.post(`${H}/${id}/accept`, {title: 'Descaling your espresso machine', body: 'NEW BODY: water under the machine.'});
    expect(res.status).toBe(200);
    const created = res.json.article as {id: number; mode: string};
    expect(created.mode).toBe('created');
    expect(created.id).not.toBe(live);

    const original = await db.kbArticle.findUniqueOrThrow({where: {id: live}, select: {body: true, status: true}});
    expect(original).toEqual({body: 'Descale monthly with citric acid.', status: 'published'});
    expect(await db.kbChunk.findMany({where: {articleId: live}, select: {id: true, text: true}, orderBy: {id: 'asc'}})).toEqual(chunksBefore);
    expect(await db.kbChunk.count({where: {articleId: created.id}})).toBe(0);
    const draft = await db.kbArticle.findUniqueOrThrow({where: {id: created.id}, select: {status: true, slug: true, categoryId: true}});
    expect(draft.status).toBe('draft');
    expect(draft.categoryId).toBe(categoryId);
    expect(draft.slug).not.toBe('descaling-your-espresso-machine');
    const publicAfter = await guest.get('/site-api/kb/articles/descaling-your-espresso-machine');
    expect(publicAfter.status).toBe(publicBefore.status);
    expect(JSON.stringify(publicAfter.json)).not.toContain('NEW BODY');
  });

  it('accept on a draft target updates that draft in place', async () => {
    const res = await reviewer.post('/site-api/kb/manage/articles', {title: 'Grinder noise', body: 'Old text.', categoryId});
    const draftId = (res.json.article as {id: number}).id;
    const id = await issue({type: 'conflict', articleId: draftId});
    // The reviewer's category choice applies to the updated draft too.
    const other = (await db.kbCategory.create({data: {name: 'Grinders', slug: 'grinders'}, select: {id: true}})).id;
    const accepted = await reviewer.post(`${H}/${id}/accept`, {title: 'Grinder noise, fixed', body: 'New text.', categoryId: other});
    expect(accepted.status).toBe(200);
    expect(accepted.json.article).toMatchObject({id: draftId, mode: 'updated', status: 'draft'});
    expect(await db.kbArticle.count()).toBe(1);
    expect(await db.kbArticle.findUniqueOrThrow({where: {id: draftId}, select: {title: true, body: true, status: true, categoryId: true}})).toEqual({
      title: 'Grinder noise, fixed',
      body: 'New text.',
      status: 'draft',
      categoryId: other,
    });
    const audited = await db.auditEvent.findFirstOrThrow({where: {action: 'health_issue_accepted'}, select: {meta: true}});
    expect(audited.meta).toMatchObject({mode: 'updated', articleId: draftId, sourceArticleId: draftId});
  });

  it('accept on a conflict whose draft is a whole new article never replaces the cited draft', async () => {
    const res = await reviewer.post('/site-api/kb/manage/articles', {title: 'Descaling', body: 'Cited draft text.', categoryId});
    const draftId = (res.json.article as {id: number}).id;
    const id = await issue({
      type: 'conflict',
      articleId: draftId,
      evidence: {source: 'ticket', citedArticleId: draftId, draftAction: 'new'},
    });
    const accepted = await reviewer.post(`${H}/${id}/accept`, {title: 'Descaling with vinegar', body: 'A new article.'});
    expect(accepted.status).toBe(200);
    const created = accepted.json.article as {id: number; mode: string};
    expect(created.mode).toBe('created');
    expect(created.id).not.toBe(draftId);
    expect((await db.kbArticle.findUniqueOrThrow({where: {id: draftId}, select: {body: true}})).body).toBe('Cited draft text.');
  });

  it('accept never overwrites a draft someone edited after the issue was raised: a separate draft', async () => {
    const res = await reviewer.post('/site-api/kb/manage/articles', {title: 'Milk frothing', body: 'Old text.', categoryId});
    const draftId = (res.json.article as {id: number}).id;
    const id = await issue({type: 'conflict', articleId: draftId});
    // An editor keeps working on the draft after the issue was raised.
    await new Promise(resolve => setTimeout(resolve, 5));
    const edited = await reviewer.patch(`/site-api/kb/manage/articles/${draftId}`, {body: 'EDITOR WORK IN PROGRESS'});
    expect(edited.status).toBe(200);

    const accepted = await reviewer.post(`${H}/${id}/accept`, {title: 'Milk frothing', body: 'Suggested text.'});
    expect(accepted.status).toBe(200);
    const created = accepted.json.article as {id: number; mode: string};
    expect(created.mode).toBe('created');
    expect(created.id).not.toBe(draftId);
    expect((await db.kbArticle.findUniqueOrThrow({where: {id: draftId}, select: {body: true}})).body).toBe('EDITOR WORK IN PROGRESS');
    expect(await db.kbArticle.findUniqueOrThrow({where: {id: created.id}, select: {status: true, categoryId: true, body: true}})).toEqual({
      status: 'draft',
      categoryId,
      body: 'Suggested text.',
    });
  });

  it('a slug, a category or a body that fails rolls everything back (the issue stays open)', async () => {
    await publishedArticle('Taken', 'Body.');
    const id = await issue({});
    const slugTaken = await reviewer.post(`${H}/${id}/accept`, {title: 'Visits', body: 'Come.', categoryId, slug: 'taken'});
    // 422 like any field problem: 409 means only "someone else handled this issue".
    expect(slugTaken.status).toBe(422);
    expect(slugTaken.json.error).toBe('invalid_input');
    expect(slugTaken.json.fields).toEqual({slug: 'That slug is already used. Pick another.'});

    const gone = await reviewer.post(`${H}/${id}/accept`, {title: 'Visits', body: 'Come.', categoryId: 999999});
    expect(gone.status).toBe(422);
    expect(gone.json.fields).toHaveProperty('categoryId');

    const noCategory = await reviewer.post(`${H}/${id}/accept`, {title: 'Visits', body: 'Come.'});
    expect(noCategory.status).toBe(422);
    expect(noCategory.json.fields).toHaveProperty('categoryId');

    const bad = await reviewer.post(`${H}/${id}/accept`, {title: '', body: '  ', categoryId});
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields as object).sort()).toEqual(['body', 'title']);

    expect(await db.healthIssue.findUniqueOrThrow({where: {id}, select: {state: true, resolvedAt: true}})).toEqual({state: 'open', resolvedAt: null});
    expect(await db.kbArticle.count()).toBe(1);

    // The same title as an existing article gets a free slug of its own.
    const ok = await reviewer.post(`${H}/${id}/accept`, {title: 'Taken', body: 'Come.', categoryId});
    expect(ok.status).toBe(200);
    expect((await db.kbArticle.findUniqueOrThrow({where: {id: (ok.json.article as {id: number}).id}, select: {slug: true}})).slug).toBe('taken-2');
  });

  it('dismiss: once, conditional on open', async () => {
    const id = await issue({});
    const res = await reportsOnly.post(`${H}/${id}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({issue: {id, state: 'dismissed'}});
    const row = await db.healthIssue.findUniqueOrThrow({where: {id}, select: {state: true, resolvedBy: true}});
    expect(row).toEqual({state: 'dismissed', resolvedBy: await userId('kh-reports@example.test')});
    expect(await db.auditEvent.count({where: {action: 'health_issue_dismissed'}})).toBe(1);
    expect((await reviewer.post(`${H}/${id}/dismiss`)).json.error).toBe('changed');
    expect((await reviewer.post(`${H}/${id}/accept`, {title: 'x', body: 'y', categoryId})).status).toBe(409);
  });

  it('write a draft: AI off, one job per try, already writing, three tries, a refused send', async () => {
    const id = await issue({});
    await db.healthIssue.update({where: {id}, data: {draftState: 'none'}});
    const off = await reportsOnly.post(`${H}/${id}/draft`);
    expect(off.status).toBe(409);
    expect(off.json.error).toBe('ai_off');

    env.ANTHROPIC_API_KEY = 'fake-key';
    const [a, b] = await Promise.all([reportsOnly.post(`${H}/${id}/draft`), reviewer.post(`${H}/${id}/draft`)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(jobs.sent).toHaveLength(1);
    expect(jobs.sent[0]).toMatchObject({list: 'health-drafts', data: {issueId: id}, options: {key: `hdraft-${id}-1`}});
    expect(await db.auditEvent.count({where: {action: 'health_issue_draft_requested'}})).toBe(1);

    // The job failed: another try gets a new key.
    await db.healthIssue.update({where: {id}, data: {draftState: 'failed', draftError: 'failed'}});
    expect((await reportsOnly.post(`${H}/${id}/draft`)).status).toBe(202);
    expect(jobs.sent.at(-1)!.options.key).toBe(`hdraft-${id}-2`);

    // A refused send puts it back to failed (the try still counts).
    await db.healthIssue.update({where: {id}, data: {draftState: 'failed'}});
    jobs.refuse = true;
    const refused = await reportsOnly.post(`${H}/${id}/draft`);
    expect(refused.status).toBe(503);
    expect(refused.json.error).toBe('not_sent');
    expect(await db.healthIssue.findUniqueOrThrow({where: {id}, select: {draftState: true, draftAttempts: true}})).toEqual({
      draftState: 'failed',
      draftAttempts: 3,
    });
    jobs.refuse = false;

    const limit = await reportsOnly.post(`${H}/${id}/draft`);
    expect(limit.status).toBe(409);
    expect(limit.json.error).toBe('draft_limit');
    expect(jobs.sent).toHaveLength(2);

    // Resolved issues get no draft.
    const other = await issue({});
    await db.healthIssue.update({where: {id: other}, data: {draftState: 'none', state: 'dismissed', resolvedAt: new Date()}});
    expect((await reportsOnly.post(`${H}/${other}/draft`)).json.error).toBe('changed');
  });

  it('settings: the time zone is checked with Intl and stored canonical', async () => {
    const S = '/site-api/helpdesk/settings';
    const ok = await agent.patch(S, {timeZone: 'utc'});
    expect(ok.status).toBe(200);
    expect(ok.json.timeZone).toBe('UTC');
    expect((await agent.patch(S, {timeZone: 'Asia/Calcutta'})).json.timeZone).toBe('Asia/Kolkata');
    expect((await agent.patch(S, {timeZone: 'EST5EDT'})).json.timeZone).toBe('America/New_York');
    const berlin = await agent.patch(S, {timeZone: 'Europe/Berlin'});
    expect(berlin.json.timeZone).toBe('Europe/Berlin');
    for (const bad of ['Mars/Olympus', '../etc', 'x'.repeat(65), 42]) {
      const res = await agent.patch(S, {timeZone: bad});
      expect(res.status, String(bad)).toBe(422);
      expect(res.json.fields).toEqual({timeZone: 'Pick a time zone from the list.'});
    }
    expect((await db.helpdeskSettings.findUniqueOrThrow({where: {id: 1}, select: {timeZone: true}})).timeZone).toBe('Europe/Berlin');
    expect((await agent.get(S)).json.timeZone).toBe('Europe/Berlin');
    expect((await reportsOnly.patch(S, {timeZone: 'UTC'})).status).toBe(403);
  });
});
