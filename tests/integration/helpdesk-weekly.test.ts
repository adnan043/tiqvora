import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {mondayBefore, runWeeklyStats} from '../../src/server/helpdesk/weekly';
import {configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * The nightly weekly numbers (src/server/helpdesk/weekly.ts): tickets per UTC week (created,
 * solved confirmed / assumed, median first response, CSAT apart), the last 3 weeks recomputed and
 * older ones frozen, the rankings for this week and last, and the clean-up. A fixed clock.
 */
describe.skipIf(!DATABASE_URL)('weekly help desk numbers (integration, real Postgres)', () => {
  const NOW = new Date('2026-11-11T12:00:00Z'); // a Wednesday
  const W0 = '2026-11-09';
  const W1 = '2026-11-02';
  const W2 = '2026-10-26';
  const at = (iso: string) => new Date(iso);

  /** One ticket and its conversation, with the times the reports read. */
  async function ticket(o: {
    created: string;
    status?: string;
    resolution?: string;
    solved?: string | null;
    firstResponse?: string | null;
    csat?: number | null;
    csatAt?: string | null;
  }): Promise<number> {
    const rows = await db.$queryRaw<{id: number}[]>`
      WITH c AS (
        INSERT INTO "conversations" ("status", "resolution", "request_key", "created_at", "updated_at")
        VALUES (${o.status ?? 'open'}, ${o.resolution ?? 'none'}, ${'k' + Math.random().toString(36).slice(2)}, ${at(o.created)}, now())
        RETURNING "id"
      )
      INSERT INTO "tickets" ("conversation_id", "subject", "solved_at", "first_response_at", "csat", "csat_at", "created_at", "updated_at")
      SELECT c."id", 'A ticket', ${o.solved ? at(o.solved) : null}::timestamptz, ${o.firstResponse ? at(o.firstResponse) : null}::timestamptz,
             ${o.csat ?? null}::smallint, ${o.csatAt ? at(o.csatAt) : null}::timestamptz, ${at(o.created)}, now()
      FROM c RETURNING "id"`;
    return rows[0]!.id;
  }

  const solved = (created: string, when: string, resolution: 'confirmed' | 'assumed', extra: Partial<Parameters<typeof ticket>[0]> = {}) =>
    ticket({created, status: 'solved', resolution, solved: when, ...extra});

  const week = async (monday: string) => {
    const row = await db.helpdeskStatsWeekly.findUnique({where: {week: new Date(`${monday}T00:00:00Z`)}});
    if (!row) return null;
    const {updatedAt: _updated, week: _week, ...numbers} = row;
    return numbers;
  };

  const top = (monday: string, list: string) =>
    db.helpdeskTopWeekly.findMany({
      where: {week: new Date(`${monday}T00:00:00Z`), list},
      orderBy: {rank: 'asc'},
      select: {rank: true, articleId: true, question: true, value: true, value2: true},
    });

  const log = (question: string, outcome: string, createdAt: string, topArticleId: number | null = null) =>
    db.$executeRaw`
      INSERT INTO "question_logs" ("question", "outcome", "top_article_id", "created_at")
      VALUES (${question}, ${outcome}, ${topArticleId}, ${at(createdAt)})`;

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
  });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE "helpdesk_stats_weekly", "helpdesk_top_weekly", "question_logs", "question_stats_daily", "conversations", "tickets", "messages", "kb_articles", "kb_categories" RESTART IDENTITY CASCADE'
    );
  });

  it('counts each week: created, solved by resolution (Sunday 23:59 vs Monday 00:00), first response median, CSAT apart', async () => {
    // Created this week: replies after 10, 20 and 30 minutes, one not answered yet.
    await ticket({created: '2026-11-09T08:00:00Z', firstResponse: '2026-11-09T08:10:00Z'});
    await ticket({created: '2026-11-10T08:00:00Z', firstResponse: '2026-11-10T08:20:00Z'});
    await ticket({created: '2026-11-10T09:00:00Z', firstResponse: '2026-11-10T09:30:00Z'});
    await ticket({created: '2026-11-11T09:00:00Z'});
    // Solved this week (created the week before): 1 confirmed, 2 assumed; Monday 00:00 is this week.
    await solved('2026-11-03T08:00:00Z', '2026-11-09T00:00:00Z', 'confirmed', {csat: 5, csatAt: '2026-11-10T10:00:00Z'});
    await solved('2026-11-03T09:00:00Z', '2026-11-10T10:00:00Z', 'assumed', {csat: 3, csatAt: '2026-11-11T10:00:00Z'});
    await solved('2026-11-03T10:00:00Z', '2026-11-11T10:00:00Z', 'assumed');
    // Sunday 23:59:59.999 is last week; rated last week.
    await solved('2026-11-04T10:00:00Z', '2026-11-08T23:59:59.999Z', 'confirmed', {csat: 4, csatAt: '2026-11-08T23:59:59Z'});
    // Reopened: no longer solved, counted nowhere.
    await ticket({created: '2026-11-04T10:00:00Z', status: 'open', solved: null});

    await runWeeklyStats(db, NOW);

    expect(await week(W0)).toEqual({
      ticketsCreated: 4,
      ticketsSolved: 3,
      solvedConfirmed: 1,
      solvedAssumed: 2,
      firstResponses: 3,
      firstResponseMedianSecs: 1200,
      csatCount: 2,
      csatSum: 8,
    });
    expect(await week(W1)).toEqual({
      ticketsCreated: 5,
      ticketsSolved: 1,
      solvedConfirmed: 1,
      solvedAssumed: 0,
      firstResponses: 0,
      firstResponseMedianSecs: null,
      csatCount: 1,
      csatSum: 4,
    });
    expect(await week(W2)).toMatchObject({ticketsCreated: 0, ticketsSolved: 0, firstResponseMedianSecs: null});
    expect(await week(mondayBefore(W0, 3))).toBeNull(); // only 3 weeks are written

    // Idempotent: a second run (a retry) writes the same numbers.
    const before = await db.helpdeskStatsWeekly.findMany({orderBy: {week: 'asc'}, omit: {updatedAt: true}});
    await runWeeklyStats(db, NOW);
    expect(await db.helpdeskStatsWeekly.findMany({orderBy: {week: 'asc'}, omit: {updatedAt: true}})).toEqual(before);
  });

  it('first response median: an even count is the mean of the middle two (600 & 1200 → 900); a reply stamped before the ticket counts as 0', async () => {
    await ticket({created: '2026-11-09T08:00:00Z', firstResponse: '2026-11-09T08:10:00Z'}); // 600 s
    await ticket({created: '2026-11-10T08:00:00Z', firstResponse: '2026-11-10T08:20:00Z'}); // 1200 s
    // Last week: a clock skew put the first reply 5 minutes BEFORE the ticket (negative → 0).
    await ticket({created: '2026-11-03T08:00:00Z', firstResponse: '2026-11-03T07:55:00Z'});
    await runWeeklyStats(db, NOW);
    expect(await week(W0)).toMatchObject({firstResponses: 2, firstResponseMedianSecs: 900});
    expect(await week(W1)).toMatchObject({firstResponses: 1, firstResponseMedianSecs: 0});
  });

  it('every run writes all 3 weeks (zeros included): a computed week is told apart from one never worked out', async () => {
    await runWeeklyStats(db, NOW);
    const rows = await db.helpdeskStatsWeekly.findMany({orderBy: {week: 'asc'}, select: {week: true, ticketsCreated: true, updatedAt: true}});
    expect(rows.map(r => r.week.toISOString().slice(0, 10))).toEqual([W2, W1, W0]);
    expect(rows.every(r => r.ticketsCreated === 0 && r.updatedAt instanceof Date)).toBe(true);
    expect(await db.helpdeskTopWeekly.count()).toBe(0);
  });

  it('recomputes 3 weeks: a reopen 10 days after the solve changes the week before last; older weeks stay frozen', async () => {
    const id = await solved('2026-10-27T08:00:00Z', '2026-10-28T08:00:00Z', 'assumed'); // week W2
    const frozen = mondayBefore(W0, 3);
    await db.helpdeskStatsWeekly.create({data: {week: new Date(`${frozen}T00:00:00Z`), ticketsCreated: 7, ticketsSolved: 7, solvedAssumed: 7}});

    await runWeeklyStats(db, NOW);
    expect(await week(W2)).toMatchObject({ticketsCreated: 1, ticketsSolved: 1, solvedAssumed: 1});

    // The customer reopens it on 2026-11-07 (10 days later): solved_at cleared.
    await db.$executeRaw`UPDATE "tickets" SET "solved_at" = NULL WHERE "id" = ${id}`;
    await db.$executeRaw`UPDATE "conversations" SET "status" = 'open', "resolution" = 'none' WHERE "id" = (SELECT "conversation_id" FROM "tickets" WHERE "id" = ${id})`;
    await runWeeklyStats(db, NOW);
    expect(await week(W2)).toMatchObject({ticketsCreated: 1, ticketsSolved: 0, solvedAssumed: 0});
    // Four weeks back is history: not recomputed, even though no ticket backs it.
    expect(await week(frozen)).toMatchObject({ticketsCreated: 7, ticketsSolved: 7, solvedAssumed: 7});
  });

  it('a customer confirming a team-solved ticket moves it from assumed to confirmed on the next run', async () => {
    const id = await solved('2026-11-02T08:00:00Z', '2026-11-03T08:00:00Z', 'assumed');
    await runWeeklyStats(db, NOW);
    expect(await week(W1)).toMatchObject({ticketsSolved: 1, solvedConfirmed: 0, solvedAssumed: 1});
    await db.$executeRaw`UPDATE "conversations" SET "resolution" = 'confirmed' WHERE "id" = (SELECT "conversation_id" FROM "tickets" WHERE "id" = ${id})`;
    await runWeeklyStats(db, NOW);
    expect(await week(W1)).toMatchObject({ticketsSolved: 1, solvedConfirmed: 1, solvedAssumed: 0});
  });

  it('rankings: unanswered grouped, most used (published only), lowest rated (≥ 5 votes, this week only); ≤ 10 each', async () => {
    const category = await db.kbCategory.create({data: {name: 'Orders', slug: 'orders-wk'}, select: {id: true}});
    const article = (slug: string, status: string, helpful = 0, notHelpful = 0) =>
      db.kbArticle
        .create({
          data: {categoryId: category.id, title: slug, slug, body: 'Body.', status, helpfulCount: helpful, notHelpfulCount: notHelpful, createdBy: 1, updatedBy: 1},
          select: {id: true},
        })
        .then(row => row.id);
    const a = await article('returns', 'published', 1, 9);
    const b = await article('sizes', 'published', 4, 1);
    const c = await article('secret-draft', 'draft', 0, 50);
    await article('few-votes', 'published', 0, 4);

    // This week: "where is my order" 3 ways, plus 12 different questions (only 10 ranked in all).
    await log('where is my order', 'no_source', '2026-11-09T10:00:00Z');
    await log('Where is my order?', 'no_source', '2026-11-10T10:00:00Z');
    await log('WHERE IS MY ORDER', 'no_source', '2026-11-11T10:00:00Z');
    for (let i = 0; i < 12; i++) await log(`other question ${i}`, 'no_source', `2026-11-10T11:${String(10 + i)}:00Z`);
    await log('answered elsewhere', 'answered', '2026-11-10T10:00:00Z'); // not a no_source: not ranked
    for (let i = 0; i < 3; i++) await log('returns?', 'answered', '2026-11-10T12:00:00Z', a);
    await log('sizes?', 'answered', '2026-11-10T12:00:00Z', b);
    for (let i = 0; i < 5; i++) await log('draft?', 'answered', '2026-11-10T12:00:00Z', c); // a draft: never ranked
    await log('handed off', 'handed_off', '2026-11-10T12:00:00Z', b); // not answered: not counted
    // Last week: one unanswered question. Its low_rated snapshot was written by last week's run.
    await log('Refund?', 'no_source', '2026-11-03T10:00:00Z');
    await db.helpdeskTopWeekly.create({data: {week: new Date(`${W1}T00:00:00Z`), list: 'low_rated', rank: 1, articleId: b, value: 1, value2: 4}});

    await runWeeklyStats(db, NOW);

    const unanswered = await top(W0, 'unanswered');
    expect(unanswered).toHaveLength(10);
    expect(unanswered[0]).toEqual({rank: 1, articleId: null, question: 'WHERE IS MY ORDER', value: 3, value2: 0});
    expect(await top(W0, 'used')).toEqual([
      {rank: 1, articleId: a, question: '', value: 3, value2: 0},
      {rank: 2, articleId: b, question: '', value: 1, value2: 0},
    ]);
    expect(await top(W0, 'low_rated')).toEqual([
      {rank: 1, articleId: a, question: '', value: 9, value2: 1},
      {rank: 2, articleId: b, question: '', value: 1, value2: 4},
    ]);
    expect(await top(W1, 'unanswered')).toEqual([{rank: 1, articleId: null, question: 'Refund?', value: 1, value2: 0}]);
    expect(await top(W1, 'low_rated')).toEqual([{rank: 1, articleId: b, question: '', value: 1, value2: 4}]); // left as it was

    // Fewer rows next time: the ranks no longer written are deleted, not left stale.
    await db.$executeRawUnsafe(`DELETE FROM "question_logs" WHERE "question" LIKE 'other question%'`);
    await db.kbArticle.update({where: {id: b}, data: {status: 'archived'}});
    await runWeeklyStats(db, NOW);
    expect(await top(W0, 'unanswered')).toHaveLength(1);
    expect((await top(W0, 'used')).map(row => row.articleId)).toEqual([a]);
    expect((await top(W0, 'low_rated')).map(row => row.articleId)).toEqual([a]);
  });

  it('clean-up: weekly rows kept 53 weeks, rankings only for this week and last', async () => {
    const keep = mondayBefore(W0, 52);
    const drop = mondayBefore(W0, 53);
    await db.helpdeskStatsWeekly.createMany({data: [keep, drop].map(w => ({week: new Date(`${w}T00:00:00Z`), ticketsCreated: 1}))});
    await db.helpdeskTopWeekly.createMany({
      data: [W2, W1].map(w => ({week: new Date(`${w}T00:00:00Z`), list: 'unanswered', rank: 1, question: 'old', value: 1})),
    });

    await runWeeklyStats(db, NOW);
    expect(await week(keep)).not.toBeNull();
    expect(await week(drop)).toBeNull();
    expect(await top(W2, 'unanswered')).toEqual([]);
    // Last week's ranking is recomputed (no question logged then: empty), not kept as "old".
    expect(await top(W1, 'unanswered')).toEqual([]);
  });
});
