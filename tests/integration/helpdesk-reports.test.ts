import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {HelpdeskOverview, HelpdeskReport, QuestionsPage, TopReport, WeeksReport} from '../../src/lib/helpdesk-report-types';
import {ensurePermissions} from '../../src/platform/permission-sync';
import {app} from '../../src/server/app';
import {weekKey} from '../../src/server/helpdesk/state';
import {mondayBefore, runWeeklyStats} from '../../src/server/helpdesk/weekly';
import {CATALOGUE, PERMISSIONS} from '../../src/server/permissions';
import {env} from './support/cloudflare-workers';
import {Browser, configureEnv, createRole, DATABASE_URL, db, resetDatabase, resetHelpdeskSettings, setRoles, signedIn} from './support/harness';

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

/**
 * Phase 5 reads: the Overview (AI tiles + "Needs attention", each item only for who may act on
 * it), the weekly ticket numbers and the rankings (only published articles named).
 */
/**
 * Runs `fn` again when the UTC day (or week) changed while it ran: the routes read the real clock,
 * so a run across 00:00 UTC (or Monday 00:00) would compare two different days. `fn` resets what it
 * writes; the second run can't cross midnight again.
 */
async function onOneClock<T>(fn: () => Promise<T>, key: (d: Date) => string = d => d.toISOString().slice(0, 10)): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const before = key(new Date());
    const result = await fn();
    if (key(new Date()) === before || attempt > 0) return result;
  }
}

describe.skipIf(!DATABASE_URL)('help desk overview, weeks and rankings (integration, real Postgres)', () => {
  let reporter: Browser; // reports only
  let lead: Browser; // reports + knowledge editing + assistant settings
  let agent: Browser; // everything but reports
  let guest: Browser;
  const PATHS = ['/site-api/helpdesk/reports/overview', '/site-api/helpdesk/reports/weeks?count=4', '/site-api/helpdesk/reports/top?week=current'];
  const overview = async (b: Browser) => (await b.get(PATHS[0]!)).json as unknown as HelpdeskOverview;

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    await ensurePermissions(db, CATALOGUE);
    await createRole('p5-reports', [PERMISSIONS.HELPDESK_REPORTS]);
    await createRole('p5-lead', [PERMISSIONS.HELPDESK_REPORTS, PERMISSIONS.KB_EDIT, PERMISSIONS.HELPDESK_SETTINGS]);
    await createRole('p5-agent', [PERMISSIONS.HELPDESK_INBOX, PERMISSIONS.KB_EDIT, PERMISSIONS.HELPDESK_SETTINGS]);
    reporter = await signedIn(app, 'p5-reports@example.test', undefined, '203.0.113.161');
    await setRoles('p5-reports@example.test', 'member', 'p5-reports');
    lead = await signedIn(app, 'p5-lead@example.test', undefined, '203.0.113.162');
    await setRoles('p5-lead@example.test', 'member', 'p5-lead');
    agent = await signedIn(app, 'p5-agent@example.test', undefined, '203.0.113.163');
    await setRoles('p5-agent@example.test', 'member', 'p5-agent');
    guest = new Browser(app, '203.0.113.164');
  });
  afterAll(() => {
    delete env.ANTHROPIC_API_KEY;
  });
  beforeEach(async () => {
    delete env.ANTHROPIC_API_KEY;
    await resetHelpdeskSettings();
    await db.$executeRawUnsafe(
      'TRUNCATE "question_logs", "question_stats_daily", "ai_usage", "health_issues", "kb_sources", "helpdesk_stats_weekly", "helpdesk_top_weekly", "kb_articles", "kb_categories", "conversations", "tickets", "messages" RESTART IDENTITY CASCADE'
    );
  });

  it('only holders of site:helpdesk:reports may read them', async () => {
    for (const path of PATHS) {
      expect((await guest.get(path)).status).toBe(401);
      expect((await agent.get(path)).status).toBe(403);
      const ok = await reporter.get(path);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toMatch(/private|no-store/);
    }
  });

  it("overview: this week from the daily totals; the month's spend only for who holds the assistant settings", async () => {
    const [o, forLead] = await onOneClock(async () => {
      await db.$executeRawUnsafe('TRUNCATE "question_logs", "question_stats_daily", "ai_usage" RESTART IDENTITY');
      await db.$executeRaw`INSERT INTO "question_logs" ("question", "outcome") VALUES ('a', 'answered'), ('b', 'answered'), ('c', 'handed_off'), ('d', 'no_source')`;
      await db.$executeRaw`INSERT INTO "ai_usage" ("month", "spent_micros", "requests", "updated_at") VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1234567, 12, now())`;
      return [await overview(reporter), await overview(lead)] as const;
    });
    expect(o.week.from).toBe(weekKey(new Date(`${o.week.to}T12:00:00Z`)));
    expect(o).toMatchObject({questions: 4, answered: 2, handedOff: 1, noSource: 1});
    expect(o.answeredByDay.at(-1)).toBe(2);
    expect(o.answeredByDay.length).toBe(Math.round((Date.parse(o.week.to) - Date.parse(o.week.from)) / 86_400_000) + 1);
    // Money is for who can change the budget: the reporter gets no `spend` at all.
    expect('spend' in o).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/spentCents|capCents|1234567/);
    expect(forLead.spend).toMatchObject({spentCents: 124, capCents: 2000, requests: 12});
    expect(o.aiReady).toBe(false); // no key
    expect(o.health.map(h => h.kind)).toEqual(['no_source']); // the reporter can't change the AI settings
    expect(JSON.stringify(o)).not.toMatch(/sk-|ANTHROPIC/);
    expect(JSON.stringify(forLead)).not.toMatch(/sk-|ANTHROPIC/);
  });

  it('overview: exactly 6 failed files is "6", 7 is "6+"; conflicts are not counted as gaps', async () => {
    const failed = (from: number, to: number) => db.$executeRaw`
      INSERT INTO "kb_sources" ("file_id", "name", "kind", "size", "state", "created_by", "updated_at")
      SELECT 'file_' || lpad(g::text, 26, '0'), 'Guide ' || g || '.pdf', 'pdf', 1000, 'failed', 1, now() FROM generate_series(${from}::int, ${to}::int) g`;
    await failed(1, 6);
    await db.$executeRaw`INSERT INTO "health_issues" ("type", "fingerprint", "state") VALUES ('conflict', 'c1', 'open'), ('conflict', 'c2', 'open')`;
    let o = await overview(lead);
    expect(o.health.find(h => h.kind === 'failed_files')).toEqual({kind: 'failed_files', count: 6, more: false});
    expect(o.health.map(h => h.kind)).not.toContain('knowledge_gaps');
    await failed(7, 7);
    await db.$executeRaw`INSERT INTO "health_issues" ("type", "fingerprint", "state") VALUES ('gap', 'g1', 'open')`;
    o = await overview(lead);
    expect(o.health.find(h => h.kind === 'failed_files')).toEqual({kind: 'failed_files', count: 6, more: true});
    expect(o.health.find(h => h.kind === 'knowledge_gaps')).toEqual({kind: 'knowledge_gaps', count: 1, more: false});
  });

  it('overview health: AI state only with settings, failed files only with knowledge editing, Knowledge health counts capped', async () => {
    // 101 open issues (the scan reads 100), one dismissed, plus 7 failed files.
    await db.$executeRaw`
      INSERT INTO "health_issues" ("type", "fingerprint", "state")
      SELECT (ARRAY['gap', 'conflict', 'stale', 'low_rated'])[1 + g % 4], 'f' || g, 'open' FROM generate_series(1, 101) g`;
    await db.$executeRaw`INSERT INTO "health_issues" ("type", "fingerprint", "state", "resolved_at") VALUES ('stale', 'gone', 'dismissed', now())`;
    await db.$executeRaw`
      INSERT INTO "kb_sources" ("file_id", "name", "kind", "size", "state", "created_by", "updated_at")
      SELECT 'file_' || lpad(g::text, 26, '0'), 'Guide ' || g || '.pdf', 'pdf', 1000, 'failed', 1, now() FROM generate_series(1, 7) g`;

    const forLead = await overview(lead);
    expect(forLead.health.map(h => h.kind)).toEqual(['assistant_off', 'failed_files', 'knowledge_gaps', 'low_rated', 'stale_articles']);
    expect(forLead.health.find(h => h.kind === 'failed_files')).toEqual({kind: 'failed_files', count: 6, more: true});
    const counted = forLead.health.filter(h => ['knowledge_gaps', 'low_rated', 'stale_articles'].includes(h.kind));
    // The 100 newest open rows are scanned; conflicts among them are not a "gap".
    const [scan] = await db.$queryRaw<{conflicts: number}[]>`
      SELECT count(*) FILTER (WHERE s."type" = 'conflict')::int AS "conflicts"
      FROM (SELECT "type" FROM "health_issues" WHERE "state" = 'open' ORDER BY "id" DESC LIMIT 100) s`;
    expect(scan!.conflicts).toBeGreaterThan(0);
    expect(counted.reduce((sum, h) => sum + h.count, 0)).toBe(100 - scan!.conflicts);
    expect(counted.every(h => h.more)).toBe(true);

    const forReporter = await overview(reporter);
    expect(forReporter.health.map(h => h.kind)).toEqual(['knowledge_gaps', 'low_rated', 'stale_articles']);

    // A key and spend at 85 %: "near", only for the lead; at 100 %: "used up".
    env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    await db.$executeRaw`INSERT INTO "ai_usage" ("month", "spent_micros", "requests", "updated_at") VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 17000000, 3, now())`;
    let o = await overview(lead);
    expect(o.aiReady).toBe(true);
    expect(o.health[0]).toEqual({kind: 'cap_near', count: 85, more: false});
    expect((await overview(reporter)).health.map(h => h.kind)).not.toContain('cap_near');
    await db.$executeRaw`UPDATE "ai_usage" SET "spent_micros" = 20000000`;
    o = await overview(lead);
    expect(o.health[0]!.kind).toBe('cap_reached');
    expect(JSON.stringify(o)).not.toContain('sk-ant-test-key');
  });

  it("weeks: zeros and no date before the first run; then the job's numbers, exactly 4 or 13 weeks", async () => {
    let weeks = (await reporter.get('/site-api/helpdesk/reports/weeks?count=4')).json as unknown as WeeksReport;
    expect(weeks.updatedAt).toBeNull();
    const shown = weeks.weeks.at(-1)!.week;
    expect(weeks.weeks.map(w => w.week)).toEqual([3, 2, 1, 0].map(n => mondayBefore(shown, n)));
    expect(weeks.weeks.every(w => w.ticketsCreated === 0 && w.firstResponseMedianSecs === null)).toBe(true);

    // The ticket and the job on a fixed clock inside one week (Tuesday noon), whatever the time now;
    // the route shows that week as the newest or, across a Monday 00:00 UTC, the one before.
    const monday = weekKey();
    const at = new Date(`${monday}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() + 1);
    at.setUTCHours(12);
    await db.$executeRaw`
      WITH c AS (INSERT INTO "conversations" ("status", "resolution", "request_key", "created_at", "updated_at") VALUES ('solved', 'confirmed', 'rk1', ${at}, now()) RETURNING "id")
      INSERT INTO "tickets" ("conversation_id", "subject", "created_at", "solved_at", "first_response_at", "csat", "csat_at", "updated_at")
      SELECT c."id", 'Broken', ${at}, ${at}, ${at}::timestamptz + interval '90 seconds', 5, ${at}, now() FROM c`;
    await runWeeklyStats(db, at);
    weeks = (await reporter.get('/site-api/helpdesk/reports/weeks?count=4')).json as unknown as WeeksReport;
    expect(weeks.updatedAt).not.toBeNull();
    expect(weeks.weeks.find(w => w.week === monday)).toEqual({
      week: monday,
      ticketsCreated: 1,
      ticketsSolved: 1,
      solvedConfirmed: 1,
      solvedAssumed: 0,
      firstResponses: 1,
      firstResponseMedianSecs: 90,
      csatCount: 1,
      csatSum: 5,
    });

    for (const count of ['13', '7', 'x']) {
      const report = (await reporter.get(`/site-api/helpdesk/reports/weeks?count=${count}`)).json as unknown as WeeksReport;
      expect(report.weeks).toHaveLength(13);
    }
  });

  it('top: updatedAt is when the week was worked out — null before the job, set (empty lists) after a run with nothing to rank', async () => {
    await onOneClock(async () => {
      await db.$executeRawUnsafe('TRUNCATE "helpdesk_stats_weekly", "helpdesk_top_weekly"');
      const before = (await reporter.get('/site-api/helpdesk/reports/top?week=current')).json as unknown as TopReport;
      expect(before).toEqual({week: weekKey(), updatedAt: null, unanswered: [], mostUsed: [], lowestRated: []});
      await runWeeklyStats(db);
      expect(await db.helpdeskTopWeekly.count()).toBe(0);
      const row = await db.helpdeskStatsWeekly.findUniqueOrThrow({where: {week: new Date(`${weekKey()}T00:00:00Z`)}, select: {updatedAt: true}});
      const after = (await reporter.get('/site-api/helpdesk/reports/top?week=current')).json as unknown as TopReport;
      expect(after).toEqual({week: weekKey(), updatedAt: row.updatedAt.toISOString(), unanswered: [], mostUsed: [], lowestRated: []});
      // Last week was worked out by the same run.
      expect(((await reporter.get('/site-api/helpdesk/reports/top?week=previous')).json as unknown as TopReport).updatedAt).not.toBeNull();
    }, d => weekKey(d));
  });

  it('top: this week or last; an article no longer published is null and its title never shows', async () => {
    const category = await db.kbCategory.create({data: {name: 'Orders', slug: 'orders-p5'}, select: {id: true}});
    const article = (slug: string, status: string) =>
      db.kbArticle.create({data: {categoryId: category.id, title: `Title ${slug}`, slug, body: 'Body.', status, createdBy: 1, updatedBy: 1}, select: {id: true}});
    const live = await article('live-p5', 'published');
    const hidden = await article('secret-draft-p5', 'draft');
    const current = new Date(`${weekKey()}T00:00:00Z`);
    const previous = new Date(`${mondayBefore(weekKey(), 1)}T00:00:00Z`);
    await db.helpdeskTopWeekly.createMany({
      data: [
        {week: current, list: 'used', rank: 1, articleId: live.id, value: 8},
        {week: current, list: 'used', rank: 2, articleId: hidden.id, value: 3},
        {week: current, list: 'low_rated', rank: 1, articleId: live.id, value: 6, value2: 2},
        {week: current, list: 'unanswered', rank: 1, question: 'Where is my order?', value: 4},
        {week: previous, list: 'unanswered', rank: 1, question: 'Last week question', value: 2},
      ],
    });

    // Rankings without the week's stats row (a run always writes both): the newest ranking row's time.
    const top = (await reporter.get('/site-api/helpdesk/reports/top?week=current')).json as unknown as TopReport;
    expect(top.week).toBe(weekKey());
    expect(top.updatedAt).not.toBeNull();
    expect(top.mostUsed).toEqual([
      {article: {id: live.id, title: 'Title live-p5', slug: 'live-p5'}, answered: 8},
      {article: null, answered: 3},
    ]);
    expect(top.lowestRated).toEqual([{article: {id: live.id, title: 'Title live-p5', slug: 'live-p5'}, helpful: 2, notHelpful: 6}]);
    expect(top.unanswered).toEqual([{question: 'Where is my order?', asked: 4}]);
    expect(JSON.stringify(top)).not.toContain('secret-draft-p5');

    const last = (await reporter.get('/site-api/helpdesk/reports/top?week=previous')).json as unknown as TopReport;
    expect(last.unanswered).toEqual([{question: 'Last week question', asked: 2}]);
    const bad = (await reporter.get('/site-api/helpdesk/reports/top?week=1%27%20OR%201%3D1')).json as unknown as TopReport;
    expect(bad.week).toBe(weekKey());

    await db.$executeRawUnsafe('TRUNCATE "helpdesk_top_weekly"');
    const empty = (await reporter.get('/site-api/helpdesk/reports/top')).json as unknown as TopReport;
    expect(empty).toEqual({week: weekKey(), updatedAt: null, unanswered: [], mostUsed: [], lowestRated: []});
  });
});
