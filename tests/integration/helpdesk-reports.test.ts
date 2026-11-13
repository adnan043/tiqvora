import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {HelpdeskReport, QuestionsPage} from '../../src/lib/helpdesk-report-types';
import {ensurePermissions} from '../../src/platform/permission-sync';
import {app} from '../../src/server/app';
import {CATALOGUE, PERMISSIONS} from '../../src/server/permissions';
import {Browser, configureEnv, createRole, DATABASE_URL, db, resetDatabase, setRoles, signedIn} from './support/harness';

/**
 * Help desk analytics (/site-api/helpdesk/reports): who may read it, that the daily totals the
 * trigger keeps match the log (insert and thumbs up/down), and the question list's filters,
 * keyset paging and article join.
 */
describe.skipIf(!DATABASE_URL)('help desk analytics (integration, real Postgres)', () => {
  let reporter: Browser;
  let agent: Browser;
  let member: Browser;
  let guest: Browser;

  /** One log row, written as the ask route writes it (the trigger does the rest). */
  const log = (question: string, outcome: string, extra: {costMicros?: number; topArticleId?: number | null; createdAt?: Date} = {}) =>
    db.$queryRaw<{id: bigint}[]>`
      INSERT INTO "question_logs" ("question", "outcome", "cost_micros", "top_article_id", "created_at")
      VALUES (${question}, ${outcome}, ${extra.costMicros ?? 0}, ${extra.topArticleId ?? null}, ${extra.createdAt ?? new Date()})
      RETURNING "id"`.then(rows => rows[0]!.id);

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    await ensurePermissions(db, CATALOGUE);
    await createRole('an-reports', [PERMISSIONS.HELPDESK_REPORTS]);
    await createRole('an-agent', [PERMISSIONS.HELPDESK_INBOX, PERMISSIONS.KB_EDIT, PERMISSIONS.HELPDESK_SETTINGS]);
    reporter = await signedIn(app, 'reports@example.test', undefined, '203.0.113.151');
    await setRoles('reports@example.test', 'member', 'an-reports');
    agent = await signedIn(app, 'agent@example.test', undefined, '203.0.113.152');
    await setRoles('agent@example.test', 'member', 'an-agent');
    member = await signedIn(app, 'member@example.test', undefined, '203.0.113.153');
    guest = new Browser(app, '203.0.113.154');
  });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "question_logs", "question_stats_daily" RESTART IDENTITY');
  });

  it('only holders of site:helpdesk:reports may read it; everyone else learns nothing', async () => {
    await log('a private question', 'answered');
    for (const path of ['/site-api/helpdesk/reports?range=7d', '/site-api/helpdesk/reports/questions?filter=all&before=']) {
      expect((await guest.get(path)).status).toBe(401);
      for (const browser of [member, agent]) {
        const res = await browser.get(path);
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.json)).not.toContain('a private question');
      }
      const ok = await reporter.get(path);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toMatch(/private|no-store/);
    }
  });

  it('the trigger keeps the day totals: outcomes, cost, and a thumbs vote that changes its mind', async () => {
    const answered = await log('one', 'answered', {costMicros: 12_345});
    await log('two', 'answered', {costMicros: 10_000});
    await log('three', 'handed_off', {costMicros: 5});
    await log('four', 'no_source');
    await log('five', 'ai_off');
    // Yesterday's question lands on yesterday, not today.
    await log('old', 'answered', {createdAt: new Date(Date.now() - 86_400_000)});

    await db.$executeRaw`UPDATE "question_logs" SET "helpful" = TRUE WHERE "id" = ${answered}`;
    let report = (await reporter.get('/site-api/helpdesk/reports?range=7d')).json as unknown as HelpdeskReport;
    expect(report.totals).toMatchObject({questions: 6, answered: 3, handedOff: 1, noSource: 1, aiOff: 1, helpfulUp: 1, helpfulDown: 0});
    expect(report.totals.costCents).toBe(3); // 22,350 micro-dollars, rounded up
    expect(report.buckets.at(-1)!.questions).toBe(5);
    expect(report.buckets.at(-2)!.questions).toBe(1);

    // Changed its mind: up → down moves the vote, it doesn't add one.
    await db.$executeRaw`UPDATE "question_logs" SET "helpful" = FALSE WHERE "id" = ${answered}`;
    report = (await reporter.get('/site-api/helpdesk/reports?range=7d')).json as unknown as HelpdeskReport;
    expect(report.totals).toMatchObject({helpfulUp: 0, helpfulDown: 1});

    // The totals match the log itself (the ground truth).
    const [truth] = await db.$queryRaw<{n: bigint}[]>`SELECT count(*) AS n FROM "question_logs"`;
    const [kept] = await db.$queryRaw<{n: bigint}[]>`SELECT sum("questions") AS n FROM "question_stats_daily"`;
    expect(Number(kept!.n)).toBe(Number(truth!.n));

    // Deleting log rows (a retention clean-up) leaves the totals as they were.
    await db.$executeRawUnsafe('DELETE FROM "question_logs"');
    report = (await reporter.get('/site-api/helpdesk/reports?range=7d')).json as unknown as HelpdeskReport;
    expect(report.totals.questions).toBe(6);
  });

  it('an unknown range reads as 7 days; the period before is counted apart', async () => {
    await log('now', 'answered');
    await log('ten days ago', 'answered', {createdAt: new Date(Date.now() - 10 * 86_400_000)});
    const res = await reporter.get('/site-api/helpdesk/reports?range=1y');
    const report = res.json as unknown as HelpdeskReport;
    expect(report.range).toBe('7d');
    expect(report.totals.questions).toBe(1);
    expect(report.previous.questions).toBe(1);
  });

  it('the question list: filters, keyset pages, and only a published article is named', async () => {
    const category = await db.kbCategory.create({data: {name: 'Orders', slug: 'orders-an'}, select: {id: true}});
    const article = (status: string, slug: string) =>
      db.kbArticle.create({
        data: {categoryId: category.id, title: `Title ${slug}`, slug, body: 'Body.', status, createdBy: 1, updatedBy: 1},
        select: {id: true},
      });
    const live = await article('published', 'live-an');
    const draft = await article('draft', 'secret-draft-an');

    for (let i = 0; i < 27; i++) await log(`no source ${i}`, 'no_source');
    await log('with live article', 'answered', {topArticleId: live.id});
    const unhelpful = await log('with draft article', 'handed_off', {topArticleId: draft.id});
    await db.$executeRaw`UPDATE "question_logs" SET "helpful" = FALSE WHERE "id" = ${unhelpful}`;

    const all = (await reporter.get('/site-api/helpdesk/reports/questions?filter=all&before=')).json as unknown as QuestionsPage;
    expect(all.items).toHaveLength(25);
    expect(all.items[0]!.question).toBe('with draft article');
    expect(all.items[0]!.article).toBeNull(); // a draft's title never shows
    expect(all.items[1]!.article).toEqual({title: 'Title live-an', slug: 'live-an'});
    expect(JSON.stringify(all)).not.toContain('secret-draft-an');

    const next = (await reporter.get(`/site-api/helpdesk/reports/questions?filter=all&before=${all.nextBefore}`)).json as unknown as QuestionsPage;
    expect(next.items).toHaveLength(4);
    expect(next.nextBefore).toBeNull();
    expect(new Set([...all.items, ...next.items].map(row => row.id)).size).toBe(29);

    const noSource = (await reporter.get('/site-api/helpdesk/reports/questions?filter=no_source&before=')).json as unknown as QuestionsPage;
    expect(noSource.items.every(row => row.outcome === 'no_source')).toBe(true);

    const bad = (await reporter.get('/site-api/helpdesk/reports/questions?filter=unhelpful&before=1%20OR%201%3D1')).json as unknown as QuestionsPage;
    expect(bad.items.map(row => row.question)).toEqual(['with draft article']);
  });
});
