import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import type {PrismaClient} from '../../src/generated/prisma/client';
import {handleJobDelivery} from '../../src/platform/background';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {background} from '../../src/server/background';
import {runKnowledgeHealth} from '../../src/server/knowledge/health';
import {runKnowledgeTick} from '../../src/server/knowledge/tick';
import {env} from './support/cloudflare-workers';
import {configureEnv, DATABASE_URL, db, JOBS_SECRET, jobDelivery, resetDatabase, resetHelpdeskSettings, seedTickets} from './support/harness';

/** Jobs the code sends are captured, never run inline; `refuse` makes the platform say no. */
const h = vi.hoisted(() => ({sent: [] as {list: string; data: unknown; options: Record<string, unknown>}[], refuse: false}));
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options: Record<string, unknown> = {}) => {
      if (h.refuse) throw new real.JobRejected('Too many jobs this minute.', 'E_JOBS_RATE_LIMITED', 429);
      h.sent.push({list, data, options});
      return {id: `job_t${h.sent.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});

/**
 * The weekly Knowledge health run (`knowledge-health`) and its 30-minute tick, against a real
 * Postgres: the gap clusters (stemmed bag of words, per weak article, `simple` for other
 * languages, MIN_GROUP, the window), idempotent upserts and the 90-day snooze, stale and
 * low-rated articles over keyset batches, duplicate deliveries, and the tick's guard row, sends,
 * sweep limits and stalled runs. No AI anywhere.
 */
const WEEK = '2026-11-09';
const FROM = new Date('2026-11-02T07:30:00Z');
const TO = new Date('2026-11-09T07:30:00Z');
const IN_WINDOW = new Date('2026-11-05T12:00:00Z');
const URL_ = 'https://shop.example.test';
const JOB = {attempt: 1, maxAttempts: 4};

vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

async function startRun(week = WEEK, from = FROM, to = TO) {
  await db.$executeRaw`
    INSERT INTO "knowledge_health_runs" ("week", "time_zone", "window_start", "window_end")
    VALUES (${week}::date, 'UTC', ${from}::timestamptz, ${to}::timestamptz)`;
}

async function runRow(week = WEEK) {
  const rows = await db.$queryRaw<{phase: string; state: string; cursor: number; gaps: number; stale: number; lowRated: number; finished: boolean}[]>`
    SELECT "phase", "state", "cursor", "gaps_found" AS "gaps", "stale_found" AS "stale", "low_rated_found" AS "lowRated",
      "finished_at" IS NOT NULL AS "finished"
    FROM "knowledge_health_runs" WHERE "week" = ${week}::date`;
  return rows[0];
}

async function log(question: string, o: {outcome?: string; confidence?: string; language?: string; article?: number | null; at?: Date} = {}) {
  await db.$executeRaw`
    INSERT INTO "question_logs" ("question", "language", "top_article_id", "confidence", "outcome", "created_at")
    VALUES (${question}, ${o.language ?? 'en'}, ${o.article ?? null}::int, ${o.confidence ?? 'none'}, ${o.outcome ?? 'no_source'},
      ${o.at ?? IN_WINDOW}::timestamptz)`;
}

let categoryId = 0;
async function article(
  slug: string,
  o: {status?: string; reviewedDaysAgo?: number; helpful?: number; notHelpful?: number; title?: string} = {}
): Promise<number> {
  if (!categoryId) {
    const rows = await db.$queryRaw<{id: number}[]>`
      INSERT INTO "kb_categories" ("name", "slug", "updated_at") VALUES ('Help', 'help', now()) RETURNING "id"`;
    categoryId = rows[0]!.id;
  }
  const rows = await db.$queryRaw<{id: number}[]>`
    INSERT INTO "kb_articles" ("category_id", "title", "slug", "body", "status", "published_at", "last_reviewed_at",
      "helpful_count", "not_helpful_count", "view_count", "created_by", "updated_by", "updated_at")
    VALUES (${categoryId}, ${o.title ?? `Article ${slug}`}, ${slug}, 'Body.', ${o.status ?? 'published'}, now(),
      now() - make_interval(days => ${o.reviewedDaysAgo ?? 1}::int), ${o.helpful ?? 0}::int, ${o.notHelpful ?? 0}::int, 5, 0, 0, now())
    RETURNING "id"`;
  return rows[0]!.id;
}

interface Issue {
  id: number;
  type: string;
  articleId: number | null;
  fingerprint: string;
  week: Date | null;
  evidence: Record<string, unknown>;
  title: string;
  state: string;
  updatedAt: Date;
}
const issues = () =>
  db.$queryRaw<Issue[]>`
    SELECT "id", "type", "article_id" AS "articleId", "fingerprint", "week", "evidence", "suggested_title" AS "title", "state",
      "updated_at" AS "updatedAt"
    FROM "health_issues" ORDER BY "id"`;
const fp = async (cluster: string) => (await db.$queryRaw<{fp: string}[]>`SELECT md5(${cluster}) AS "fp"`)[0]!.fp;
const qKey = async (config: 'english' | 'simple', text: string) =>
  (
    await db.$queryRaw<{k: string}[]>`
      SELECT 'q:' || array_to_string(tsvector_to_array(to_tsvector(${config}::regconfig, ${text})), ' ') AS "k"`
  )[0]!.k;

const run = (data: unknown, attempt = 1, maxAttempts = 4) =>
  inRequestScope(async () => {
    const res = await handleJobDelivery(jobDelivery({id: `job_kh_${Math.random()}`, list: 'knowledge-health', data, attempt, maxAttempts}), background);
    await getDb()?.$disconnect();
    return res.status;
  });

describe.skipIf(!DATABASE_URL)('knowledge health weekly run (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
    env.SITE_JOBS_SECRET = JOBS_SECRET;
  });
  afterAll(() => {
    delete env.SITE_JOBS_SECRET;
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetHelpdeskSettings();
    categoryId = 0;
    h.sent.length = 0;
    h.refuse = false;
  });

  it('groups the week’s unanswered questions into gaps, and only those', async () => {
    const weak = await article('descaling', {title: 'Descaling your espresso machine'});
    // Same bag of stemmed words: one group.
    await log('How do I cancel my subscription?');
    await log('cancel subscriptions', {language: ''});
    // Different words: two singletons, below MIN_GROUP.
    await log('stop my plan');
    await log('end my plan');
    // Spanish: the `simple` configuration (no stemming), two identical questions group.
    await log('¿Cómo cancelo mi suscripción?', {language: 'es'});
    await log('¿Cómo cancelo mi suscripción?', {language: 'es-MX'});
    // A weak answer from an existing article: one group per article, whatever the words.
    await log('My espresso machine leaks water', {outcome: 'answered', confidence: 'low', article: weak});
    await log('Water under the machine', {outcome: 'handed_off', confidence: 'low', article: weak});
    // Answered fine: not a gap.
    await log('How do I cancel my subscription?', {outcome: 'answered', confidence: 'high'});
    // Outside the window: ignored (they would make the cancel group 4).
    await log('cancel subscription', {at: new Date('2026-11-01T12:00:00Z')});
    await log('cancel subscription', {at: TO});
    await startRun();

    expect(await run({week: WEEK})).toBe(200);

    const found = await issues();
    expect(found).toHaveLength(3);
    const byFp = new Map(found.map(i => [i.fingerprint, i]));
    const cancel = byFp.get(await fp(await qKey('english', 'cancel subscriptions')));
    expect(cancel).toMatchObject({type: 'gap', articleId: null, state: 'open', title: 'cancel subscriptions'});
    expect(cancel!.evidence).toMatchObject({source: 'weekly', questions: 2, noSource: 2, lowConfidence: 0, samples: ['cancel subscriptions', 'How do I cancel my subscription?']});
    expect(cancel!.week?.toISOString().slice(0, 10)).toBe(WEEK);

    const spanish = byFp.get(await fp(await qKey('simple', '¿Cómo cancelo mi suscripción?')));
    expect(spanish?.evidence).toMatchObject({questions: 2});

    const edit = byFp.get(await fp(`a:${weak}`));
    expect(edit).toMatchObject({type: 'gap', articleId: weak, title: 'Descaling your espresso machine'});
    expect(edit!.evidence).toMatchObject({questions: 2, noSource: 0, lowConfidence: 2});

    expect(await runRow()).toMatchObject({phase: 'done', state: 'done', gaps: 3, finished: true});
    expect(h.sent).toEqual([]);
  });

  it('a second run of the same week adds nothing and refreshes the evidence; a duplicate delivery is a no-op', async () => {
    await log('cancel subscription');
    await log('cancel subscriptions');
    await startRun();
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    const first = await issues();
    expect(first).toHaveLength(1);

    // The same delivery again: the run is done, nothing runs.
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    expect(await issues()).toEqual(first);

    // The week is checked again (e.g. a time-zone change started another run): one more question.
    await log('Cancel my subscription');
    await db.$executeRaw`UPDATE "knowledge_health_runs" SET "phase" = 'gaps', "state" = 'running', "finished_at" = NULL`;
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    const second = await issues();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.evidence).toMatchObject({questions: 3});
    expect(second[0]!.updatedAt.getTime()).toBeGreaterThan(first[0]!.updatedAt.getTime());
  });

  it('a refresh keeps what a draft added to the evidence (summary, missingFacts, noDraftReason)', async () => {
    await log('cancel subscription');
    await log('cancel subscriptions');
    await startRun();
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    await db.$executeRaw`
      UPDATE "health_issues" SET "evidence" = "evidence" || '{"summary": "Explains cancelling.", "missingFacts": ["the notice period"]}'::jsonb`;
    await log('Cancel my subscription');
    await db.$executeRaw`UPDATE "knowledge_health_runs" SET "phase" = 'gaps', "state" = 'running', "finished_at" = NULL`;
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    const [row] = await issues();
    expect(row!.evidence).toMatchObject({questions: 3, summary: 'Explains cancelling.', missingFacts: ['the notice period']});
    // Keys a draft never added stay absent (no nulls).
    expect(row!.evidence).not.toHaveProperty('noDraftReason');
  });

  it('two deliveries at once: one set of issues and the counts once', async () => {
    await log('cancel subscription');
    await log('cancel subscriptions');
    await article('old', {reviewedDaysAgo: 200});
    await article('disliked', {helpful: 7, notHelpful: 3});
    await startRun();
    await Promise.all([runKnowledgeHealth(db, WEEK, JOB, URL_), runKnowledgeHealth(db, WEEK, JOB, URL_)]);
    expect((await issues()).map(i => i.type).sort()).toEqual(['gap', 'low_rated', 'stale']);
    expect(await runRow()).toMatchObject({state: 'done', gaps: 1, stale: 1, lowRated: 1});
  });

  it('does not bring back a gap dismissed in the last 90 days, but does after that', async () => {
    await log('cancel subscription');
    await log('cancel subscriptions');
    await startRun();
    await runKnowledgeHealth(db, WEEK, JOB, URL_);
    await db.$executeRaw`UPDATE "health_issues" SET "state" = 'dismissed', "resolved_at" = now() - interval '10 days', "resolved_by" = 1`;

    await startRun('2026-11-16', TO, new Date('2026-11-16T07:30:00Z'));
    await log('cancel subscription', {at: new Date('2026-11-10T12:00:00Z')});
    await log('cancel subscriptions', {at: new Date('2026-11-11T12:00:00Z')});
    await runKnowledgeHealth(db, '2026-11-16', JOB, URL_);
    expect((await issues()).filter(i => i.state === 'open')).toHaveLength(0);
    expect(await runRow('2026-11-16')).toMatchObject({state: 'done', gaps: 0});

    await db.$executeRaw`UPDATE "health_issues" SET "resolved_at" = now() - interval '91 days'`;
    await db.$executeRaw`UPDATE "knowledge_health_runs" SET "phase" = 'gaps', "state" = 'running' WHERE "week" = '2026-11-16'`;
    await runKnowledgeHealth(db, '2026-11-16', JOB, URL_);
    expect((await issues()).filter(i => i.state === 'open')).toHaveLength(1);
  });

  it('files stale and low-rated published articles (≥ 10 votes, ≥ 30 % not helpful)', async () => {
    const stale = await article('stale', {reviewedDaysAgo: 200, title: 'Holiday shipping cut-offs'});
    await article('fresh', {reviewedDaysAgo: 179});
    await article('stale-draft', {reviewedDaysAgo: 400, status: 'draft'});
    const bad = await article('three-of-ten', {helpful: 7, notHelpful: 3});
    await article('two-of-ten', {helpful: 8, notHelpful: 2});
    await article('three-of-nine', {helpful: 6, notHelpful: 3});
    await startRun();
    await runKnowledgeHealth(db, WEEK, JOB, URL_);

    const found = await issues();
    expect(found.map(i => [i.type, i.articleId, i.fingerprint])).toEqual([
      ['stale', stale, `article:${stale}`],
      ['low_rated', bad, `article:${bad}`],
    ]);
    expect(found[0]).toMatchObject({title: 'Holiday shipping cut-offs'});
    expect(found[0]!.evidence).toMatchObject({daysSinceReview: 200, views: 5});
    expect(found[1]!.evidence).toMatchObject({helpful: 7, notHelpful: 3, rate: 0.3});
    expect(await runRow()).toMatchObject({state: 'done', stale: 1, lowRated: 1});
  });

  it('walks the articles in keyset batches and sends the next job with the cursor', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await article(`a${i}`, {reviewedDaysAgo: 365}));
    await startRun();

    // 2 per batch, 2 batches per job: 4 articles, then the next job.
    await runKnowledgeHealth(db, WEEK, JOB, URL_, {articleBatch: 2, maxBatches: 2});
    expect(await runRow()).toMatchObject({phase: 'articles', state: 'running', cursor: ids[3], stale: 4});
    expect(h.sent).toEqual([
      {list: 'knowledge-health', data: {week: WEEK}, options: {key: `kh-${WEEK}-${ids[3]}`, label: `Knowledge health · week of ${WEEK}`}},
    ]);

    // That job, delivered twice: the counts move once.
    await Promise.all([
      runKnowledgeHealth(db, WEEK, JOB, URL_, {articleBatch: 2, maxBatches: 2}),
      runKnowledgeHealth(db, WEEK, JOB, URL_, {articleBatch: 2, maxBatches: 2}),
    ]);
    expect(await runRow()).toMatchObject({phase: 'done', state: 'done', stale: 7, finished: true});
    expect(await issues()).toHaveLength(7);
    expect(h.sent).toHaveLength(1);
  });

  it('marks the run failed on its last try, and refuses a bad week without retrying', async () => {
    await startRun();
    const broken = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('').includes('WITH win AS') ? Promise.reject(new Error('connection lost')) : db.$queryRaw(strings, ...values),
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => db.$executeRaw(strings, ...values),
    } as unknown as PrismaClient;
    await expect(runKnowledgeHealth(broken, WEEK, {attempt: 1, maxAttempts: 4}, URL_)).rejects.toThrow('connection lost');
    expect(await runRow()).toMatchObject({state: 'running'});
    await expect(runKnowledgeHealth(broken, WEEK, {attempt: 4, maxAttempts: 4}, URL_)).rejects.toThrow('connection lost');
    expect(await runRow()).toMatchObject({state: 'failed'});

    for (const data of [{week: '2026-02-30'}, {week: 'x'}, {}, null]) expect(await run(data)).toBe(422);
    // A week with no run row: nothing to do.
    expect(await run({week: '2026-01-05'})).toBe(200);
  });
});

describe.skipIf(!DATABASE_URL)('knowledge health tick (integration, real Postgres)', () => {
  const MONDAY_0800 = new Date('2026-11-09T08:00:00Z');

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
    await resetHelpdeskSettings();
    h.sent.length = 0;
    h.refuse = false;
  });

  it('two ticks at once on a due Monday: one guard row, one send', async () => {
    await Promise.all([runKnowledgeTick(db, URL_, MONDAY_0800), runKnowledgeTick(db, URL_, MONDAY_0800)]);
    expect(await runRow()).toMatchObject({phase: 'gaps', state: 'running'});
    const window = await db.$queryRaw<{from: Date; to: Date}[]>`
      SELECT "window_start" AS "from", "window_end" AS "to" FROM "knowledge_health_runs"`;
    expect(window).toEqual([{from: FROM, to: TO}]);
    expect(h.sent).toEqual([
      {list: 'knowledge-health', data: {week: WEEK}, options: {key: `kh-${WEEK}`, label: `Knowledge health · week of ${WEEK}`}},
    ]);
    // Later ticks that week: nothing more.
    await runKnowledgeTick(db, URL_, new Date('2026-11-12T10:00:00Z'));
    expect(h.sent).toHaveLength(1);
  });

  it('follows the owner’s time zone, and does nothing before Monday 07:30 local', async () => {
    await db.$executeRaw`UPDATE "helpdesk_settings" SET "time_zone" = 'America/Los_Angeles'`;
    await runKnowledgeTick(db, URL_, MONDAY_0800); // 00:00 local
    expect(h.sent).toEqual([]);
    expect(await db.$queryRaw`SELECT 1 FROM "knowledge_health_runs"`).toEqual([]);
    await runKnowledgeTick(db, URL_, new Date('2026-11-09T15:30:00Z')); // 07:30 PST
    expect(h.sent.map(s => s.data)).toEqual([{week: WEEK}]);
  });

  it('a refused send deletes the guard row, so the next tick tries again', async () => {
    h.refuse = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runKnowledgeTick(db, URL_, MONDAY_0800);
    expect(await runRow()).toBeUndefined();
    h.refuse = false;
    await runKnowledgeTick(db, URL_, MONDAY_0800);
    expect(await runRow()).toMatchObject({state: 'running'});
    expect(h.sent).toHaveLength(1);
  });

  it('re-sends at most 3 missed drafts and gives up on ones older than 48 hours', async () => {
    const hour = 3600_000;
    await seedTickets(4, {userId: null, status: 'solved', solvedAt: new Date(Date.now() - hour)});
    await seedTickets(1, {userId: null, status: 'solved', solvedAt: new Date(Date.now() - 5 * 60_000)});
    await seedTickets(2, {userId: null, status: 'solved', solvedAt: new Date(Date.now() - 50 * hour)});
    await runKnowledgeTick(db, URL_, new Date('2026-11-04T08:00:00Z'));
    const drafts = h.sent.filter(s => s.list === 'article-drafts');
    expect(drafts).toHaveLength(3);
    for (const d of drafts) expect(d.options.key).toBe(`draft-${(d.data as {ticketId: number}).ticketId}`);
    const checked = await db.$queryRaw<{old: number; recent: number}[]>`
      SELECT count(*) FILTER (WHERE "solved_at" < now() - interval '48 hours' AND "draft_checked_at" IS NOT NULL)::int AS "old",
             count(*) FILTER (WHERE "solved_at" > now() - interval '48 hours' AND "draft_checked_at" IS NOT NULL)::int AS "recent"
      FROM "tickets"`;
    expect(checked).toEqual([{old: 2, recent: 0}]);
  });

  it('fails weekly runs silent for 2 hours and Test Lab runs silent for 15 minutes; prunes old weeks', async () => {
    await db.$executeRaw`
      INSERT INTO "knowledge_health_runs" ("week", "time_zone", "window_start", "window_end", "updated_at") VALUES
        ('2026-10-26', 'UTC', '2026-10-19T07:30Z', '2026-10-26T07:30Z', now() - interval '3 hours'),
        ('2026-11-02', 'UTC', '2026-10-26T07:30Z', '2026-11-02T07:30Z', now() - interval '1 hour'),
        ('2025-01-06', 'UTC', '2024-12-30T07:30Z', '2025-01-06T07:30Z', now())`;
    await db.$executeRaw`
      INSERT INTO "test_runs" ("state", "total", "max_case_id", "started_by", "updated_at") VALUES
        ('running', 5, 5, 1, now() - interval '20 minutes')`;
    await runKnowledgeTick(db, URL_, new Date('2026-11-09T07:00:00Z'));
    const runs = await db.$queryRaw<{week: Date; state: string}[]>`
      SELECT "week", "state" FROM "knowledge_health_runs" ORDER BY "week"`;
    expect(runs.map(r => [r.week.toISOString().slice(0, 10), r.state])).toEqual([
      ['2026-10-26', 'failed'],
      ['2026-11-02', 'running'],
    ]);
    const tests = await db.$queryRaw<{state: string; stopReason: string; finished: boolean}[]>`
      SELECT "state", "stop_reason" AS "stopReason", "finished_at" IS NOT NULL AS "finished" FROM "test_runs"`;
    expect(tests).toEqual([{state: 'failed', stopReason: 'stalled', finished: true}]);
  });

  it('fails health drafts left pending for 15 minutes (and only those)', async () => {
    const insert = (fp: string, draftState: string, age: string, state = 'open') => db.$executeRaw`
      INSERT INTO "health_issues" ("type", "fingerprint", "evidence", "state", "resolved_at", "draft_state", "draft_attempts", "created_at", "updated_at")
      VALUES ('gap', ${fp}, '{}'::jsonb, ${state}, ${state === 'open' ? null : new Date()}::timestamptz, ${draftState}, 1, now(),
        now() - ${age}::interval)`;
    await insert('old-pending', 'pending', '20 minutes');
    await insert('new-pending', 'pending', '5 minutes');
    await insert('old-ready', 'ready', '20 minutes');
    await insert('old-dismissed', 'pending', '20 minutes', 'dismissed');
    await runKnowledgeTick(db, URL_, new Date('2026-11-04T08:00:00Z'));
    const rows = await db.$queryRaw<{fingerprint: string; draftState: string; draftError: string | null}[]>`
      SELECT "fingerprint", "draft_state" AS "draftState", "draft_error" AS "draftError" FROM "health_issues" ORDER BY "id"`;
    expect(rows).toEqual([
      {fingerprint: 'old-pending', draftState: 'failed', draftError: 'failed'},
      {fingerprint: 'new-pending', draftState: 'pending', draftError: null},
      {fingerprint: 'old-ready', draftState: 'ready', draftError: null},
      {fingerprint: 'old-dismissed', draftState: 'pending', draftError: null},
    ]);
  });
});
