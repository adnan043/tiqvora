import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {ASK_LIMITS} from '../../lib/helpdesk-types';
import {TEST_LAB_LIMITS, type TestOutcome} from '../../lib/test-lab';
import {DontRetry, type JobInfo, JobRejected, sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {answerQuestion, type AnswerOutcome} from '../ai/answer';
import {retrieve} from '../ai/retrieve';
import {recordAiCost} from '../ai/usage';
import {HELPDESK_DEFAULTS} from '../kb/settings';
import {takeRateWindow} from '../rate-window';

/**
 * Test Lab's background job (`test-lab` list, p4 design §5.5): one batch of up to 10 test
 * questions of one "Run all", asked 4 at a time through the real assistant (`answerQuestion` in
 * `mode: 'test'`: the same rules, masking, threshold, monthly cap and hold; only the customers'
 * per-minute windows are skipped, Test Lab has its own `ai-testlab-batch` window).
 *
 *   POST /helpdesk/test-lab/runs  → job {runId, after: 0}
 *   each batch                    → job {runId, after: <last case id done>} until the last case
 *
 * Safe to repeat (at-least-once): a batch acts only while the run is `running` AND its cursor is
 * still `after`; the cases' results and the run's counters + cursor are written in ONE
 * conditional statement (per case: `last_run_id` NULL or an OLDER run, and the question unchanged;
 * `cursor = after AND state = 'running'` for the run), so a duplicate delivery changes nothing and
 * sends nothing new. Two deliveries of the same batch at the same moment both pay for their calls
 * (at-least-once; bounded by the cap's holds); only one is counted.
 * A cancel that lands while a batch runs: the cases keep their real results (the money was
 * spent), the run is not advanced and no next batch is sent.
 *
 * Test Lab writes NO `question_logs` row (the analytics and the weekly gaps stay customer-only).
 * Its spend lands in the same `ai_usage` month and cap as the assistant's: each call's hold is
 * settled with `recordAiCost` as soon as it answers.
 */

/** The job list (background.json, src/server/background.ts). */
export const TEST_LAB_LIST = 'test-lab';
/** Site-wide Test Lab batches per minute (so ≤ 30 AI calls a minute), apart from the customers' windows. */
export const TEST_LAB_BUCKET = 'ai-testlab-batch';
export const TEST_LAB_BATCHES_PER_MINUTE = 3;
/** Cases per batch: ≤ 10 AI calls, well inside a job's 60 seconds. */
const BATCH: number = TEST_LAB_LIMITS.batch;
/**
 * Cases asked at once. A Worker has ~6 connections open at a time; each case is a retrieve, a
 * reserve, the AI call and a settle, so 4 at once leaves room and nothing queues into a timeout.
 */
const CONCURRENCY = 4;
const INT_MAX = 2147483647;
/** Send refusals that pass (the minute's limit, the platform not answering): the job is tried again. */
const TRANSIENT_SEND_CODES = new Set(['E_JOBS_RATE_LIMITED', 'E_JOBS_UNREACHABLE']);
/** The `last_answer` column is VARCHAR(1200). */
const ANSWER_MAX = 1200;
/** The `last_sources` snapshot: what the answer cited, at most 3. */
const SOURCES_MAX = 3;

export const testLabJobKey = (runId: number, after: number) => `testlab-${runId}-${after}`;
export const testLabJobLabel = (runId: number) => `Test Lab · run ${runId}`;

type Expect = 'answer' | 'handoff';
type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface TestLabCase {
  id: number;
  question: string;
  expect: string;
  expectedArticleId: number | null;
}

/** One case's result, as written to `test_cases.last_*`. */
export interface CaseResult {
  id: number;
  answer: string | null;
  confidence: Confidence | null;
  sources: {id: number | null; title: string; url: string}[] | null;
  outcome: TestOutcome;
  /** Null: not scored (`cap`, `error`). */
  passed: boolean | null;
  /** Real cost of the call, micro-dollars (0 when no call). */
  costMicros: number;
}

const isSafeId = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= INT_MAX;

/** `fn` over `items`, at most `limit` at a time; results in the items' order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

/**
 * The pass rule (§5.5 step 5, with the owner's `expect` override). Pure.
 *
 * expect 'answer':  answered citing the expected article (or none expected, or it is the top match) → pass;
 *                   answered citing another → wrong_source; a rule hand-off (no model) → person;
 *                   another hand-off → handoff; no_source → no_source.
 * expect 'handoff': any hand-off (a rule's included) → pass; answered → answered_instead; no_source → no_source.
 * Both: `off` (the key is there and windows are skipped, so only the monthly cap does this) → cap, not scored.
 * Both: the AI call failed (answer.ts hands off with confidence 'none' AND a model set; a parsed
 * reply is never 'none', and the rule hand-off / no_source have no model) → error, not scored.
 */
export function scoreOutcome(
  testCase: Pick<TestLabCase, 'expect' | 'expectedArticleId'>,
  outcome: Pick<AnswerOutcome, 'status' | 'confidence' | 'citedArticleIds'> & {log: {model: string}},
  topArticleId: number | null
): {outcome: TestOutcome; passed: boolean | null} {
  if (outcome.status === 'off') return {outcome: 'cap', passed: null};
  if (outcome.status === 'handoff' && outcome.confidence === 'none' && outcome.log.model !== '') return {outcome: 'error', passed: null};
  const expectHandoff = (testCase.expect as Expect) === 'handoff';
  if (outcome.status === 'no_source') return {outcome: 'no_source', passed: false};
  if (outcome.status === 'handoff') {
    if (expectHandoff) return {outcome: 'pass', passed: true};
    return outcome.log.model === '' ? {outcome: 'person', passed: false} : {outcome: 'handoff', passed: false};
  }
  // answered
  if (expectHandoff) return {outcome: 'answered_instead', passed: false};
  const expected = testCase.expectedArticleId;
  const right = expected === null || (outcome.citedArticleIds ?? []).includes(expected) || expected === topArticleId;
  return right ? {outcome: 'pass', passed: true} : {outcome: 'wrong_source', passed: false};
}

interface AskContext {
  db: PrismaClient;
  key: string;
  capCents: number;
  settings: {assistantName: string; tone: string; confidenceThreshold: string; model: string};
  humanTopics: string[];
}

/**
 * Asks one case. Never throws: a thrown error (retrieve, the reserve) is the `error` outcome, not
 * scored. The call's hold is settled here (a failed settle leaves the hold counted as spent:
 * fails safe, the cap is never under-counted).
 */
async function askCase(ctx: AskContext, testCase: TestLabCase): Promise<CaseResult> {
  try {
    const retrieved = await retrieve(ctx.db, testCase.question);
    const outcome = await answerQuestion({
      db: ctx.db,
      key: ctx.key,
      settings: ctx.settings,
      capCents: ctx.capCents,
      humanTopics: ctx.humanTopics,
      question: testCase.question,
      retrieved,
      history: [],
      language: '',
      page: '',
      clientKey: null,
      mode: 'test',
    });
    const {log} = outcome;
    if (log.heldMicros > 0 || log.costMicros > 0) {
      await recordAiCost(ctx.db, log.costMicros, log.heldMicros, log.month).catch(() =>
        console.warn('[test-lab] settle failed; the hold stays counted')
      );
    }
    const scored = scoreOutcome(testCase, outcome, retrieved.topArticleId);
    if (scored.outcome === 'cap' || scored.outcome === 'error') {
      return {id: testCase.id, answer: null, confidence: null, sources: null, ...scored, costMicros: Math.max(0, log.costMicros)};
    }
    // The citations as a snapshot, with the article id when it is one (a snippet has no page).
    const sources = outcome.citations.slice(0, SOURCES_MAX).map(citation => ({
      id: retrieved.sources.find(source => source.url === citation.url)?.articleId ?? null,
      title: citation.title,
      url: citation.url,
    }));
    return {
      id: testCase.id,
      answer: outcome.answer.slice(0, ANSWER_MAX),
      confidence: outcome.confidence,
      sources,
      ...scored,
      costMicros: Math.max(0, log.costMicros),
    };
  } catch {
    console.warn(`[test-lab] case ${testCase.id} failed`);
    return {id: testCase.id, answer: null, confidence: null, sources: null, outcome: 'error', passed: null, costMicros: 0};
  }
}

const toMicros = (n: number): bigint => BigInt(Math.max(0, Math.ceil(Number.isFinite(n) ? n : 0)));

/**
 * The batch's ONE write: every case's result (only where this run hasn't written it yet) and the
 * run's cursor, counters, cost and end state (only while it is `running` at cursor `after`).
 * Returns the run's state after it, or null when the run was not advanced (cancelled meanwhile,
 * or another delivery got there first).
 */
async function writeBatch(
  db: PrismaClient,
  run: {id: number; after: number; newCursor: number; last: boolean; capHit: boolean},
  results: readonly (CaseResult & {question: string})[]
): Promise<string | null> {
  const cost = toMicros(results.reduce((sum, r) => sum + r.costMicros, 0));
  const casesCte = results.length
    ? Prisma.sql`v ("id", "question", "answer", "confidence", "sources", "outcome", "passed") AS (
        VALUES ${Prisma.join(
          results.map(
            r => Prisma.sql`(${r.id}::int, ${r.question}::varchar, ${r.answer}::varchar, ${r.confidence}::varchar,
              ${r.sources === null ? null : JSON.stringify(r.sources)}::jsonb, ${r.outcome}::varchar, ${r.passed}::boolean)`
          )
        )}
      ), c AS (
        UPDATE "test_cases" t
        SET "last_answer" = v."answer", "last_confidence" = v."confidence", "last_sources" = v."sources",
            "last_outcome" = v."outcome", "last_passed" = v."passed", "last_run_at" = now(),
            "last_run_id" = ${run.id}, "updated_at" = now()
        FROM v
        -- Not twice for this run, never over a NEWER run's result (a late batch of an old run),
        -- and not when the case was edited since it was asked (its question changed).
        WHERE t."id" = v."id" AND (t."last_run_id" IS NULL OR t."last_run_id" < ${run.id})
          AND t."question" = v."question"
        RETURNING t."last_passed"
      )`
    : Prisma.sql`c AS (SELECT NULL::boolean AS "last_passed" WHERE false)`;
  const rows = await db.$queryRaw<{state: string | null}[]>`
    WITH ${casesCte},
    d AS (
      SELECT count(*) FILTER (WHERE "last_passed" IS NOT NULL)::int AS "scored",
             count(*) FILTER (WHERE "last_passed")::int AS "passed"
      FROM c
    ),
    r AS (
      UPDATE "test_runs"
      SET "cursor" = ${run.newCursor},
          -- LEAST: the CHECK (done <= total, passed <= done) holds even if a case slipped in at the start.
          "done" = LEAST("total", "done" + (SELECT "scored" FROM d)),
          "passed" = LEAST(LEAST("total", "done" + (SELECT "scored" FROM d)), "passed" + (SELECT "passed" FROM d)),
          "cost_micros" = "cost_micros" + ${cost},
          "state" = CASE WHEN ${run.capHit}::boolean THEN 'stopped' WHEN ${run.last}::boolean THEN 'done' ELSE "state" END,
          "stop_reason" = CASE WHEN ${run.capHit}::boolean THEN 'cap' ELSE "stop_reason" END,
          "finished_at" = CASE WHEN ${run.capHit}::boolean OR ${run.last}::boolean THEN now() ELSE "finished_at" END,
          "updated_at" = now()
      WHERE "id" = ${run.id} AND "cursor" = ${run.after} AND "state" = 'running'
      RETURNING "state"
    )
    SELECT (SELECT "state" FROM r) AS "state"`;
  return rows[0]?.state ?? null;
}

/** Ends a still-running run (conditionally: only at this cursor, so a stale delivery never ends a healthy run). */
async function endRun(db: PrismaClient, runId: number, after: number, state: 'stopped' | 'failed', reason: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "test_runs"
    SET "state" = ${state}, "stop_reason" = ${reason}, "finished_at" = now(), "updated_at" = now()
    WHERE "id" = ${runId} AND "cursor" = ${after} AND "state" = 'running'`;
}

/** The next batch could not be sent YET (the minute's job limit, the platform not answering): try the job again. */
class SendLater extends Error {}

/**
 * Sends a batch job. False when the platform refused it for good (or, locally, it can't be
 * sent); throws `SendLater` when trying again will help (E_JOBS_RATE_LIMITED, E_JOBS_UNREACHABLE).
 */
async function sendBatch(siteUrl: string, runId: number, after: number, extra: {delay?: number; keySuffix?: string} = {}): Promise<boolean> {
  try {
    await sendJob(
      siteUrl,
      TEST_LAB_LIST,
      {runId, after},
      {
        key: testLabJobKey(runId, after) + (extra.keySuffix ?? ''),
        label: testLabJobLabel(runId),
        ...(extra.delay ? {delay: extra.delay} : {}),
      }
    );
    return true;
  } catch (error) {
    // A code only, never the data.
    const code = error instanceof JobRejected ? error.code : 'error';
    console.warn(`[test-lab] batch not sent: ${code}`);
    if (TRANSIENT_SEND_CODES.has(code)) throw new SendLater(code);
    return false;
  }
}

/**
 * The `test-lab` job: one batch of run `data.runId`, the cases after `data.after`.
 * `siteUrl` = `config.siteUrl` (finds the platform for the next batch's send); null (not set):
 * the run ends as failed/stalled, before anything is asked.
 * Bounds: 1 round trip of reads, 1 window, ≤ 10 × (retrieve + reserve + call + settle), 4 at a
 * time, 1 write, ≤ 1 send.
 *
 * Sending the next batch can fail for a moment (the minute's job limit, the platform not
 * answering): the job throws and is tried again. Its retry finds the run already moved on
 * (`cursor > after`) and sends the batch at the run's cursor again: the job key makes that a
 * no-op if it was sent already. On the last try the run ends as failed/stalled.
 */
export async function runTestLabBatch(
  db: PrismaClient,
  data: {runId: number; after: number},
  job: Pick<JobInfo, 'attempt' | 'maxAttempts'> & Partial<Pick<JobInfo, 'local'>>,
  siteUrl: string | null
): Promise<void> {
  const runId = data?.runId;
  const after = data?.after;
  if (!isSafeId(runId, 1) || !isSafeId(after, 0)) throw new DontRetry('Bad Test Lab run.');

  // Where the run stands (for the last try's end): moves on once this batch is written.
  let cursor = after;
  // An old delivery re-sending the run's current batch: it never ends the run (that batch may be
  // queued and healthy); the tick's stalled-run sweep ends a chain that is truly dead.
  let healing = false;
  try {
    // 1. One round trip: the run, the settings (money: the DATABASE row, never the cache), the
    // human-only topics, and this batch's cases (≤ the run's max case id).
    const [run, settings, topics, cases] = await Promise.all([
      db.testRun.findUnique({where: {id: runId}, select: {state: true, cursor: true, maxCaseId: true}}),
      db.helpdeskSettings.findUnique({
        where: {id: 1},
        select: {monthlyCapCents: true, model: true, assistantName: true, tone: true, confidenceThreshold: true},
      }),
      db.helpdeskHumanTopic.findMany({select: {keyword: true}, orderBy: {id: 'asc'}, take: ASK_LIMITS.humanTopics}),
      db.$queryRaw<TestLabCase[]>`
        SELECT "id", "question", "expect", "expected_article_id" AS "expectedArticleId"
        FROM "test_cases"
        WHERE "id" > ${after} AND "id" <= (SELECT "max_case_id" FROM "test_runs" WHERE "id" = ${runId})
        ORDER BY "id"
        LIMIT ${BATCH}`,
    ]);

    // 2. Cancelled or finished: nothing to do.
    if (!run || run.state !== 'running') return;
    if (run.cursor !== after) {
      // An old delivery, or the retry of a batch whose next send failed: make sure the batch at the
      // run's cursor is on its way (same key: a no-op if it is). A run behind `after` is not ours.
      cursor = run.cursor;
      healing = true;
      if (run.cursor > after && siteUrl) await sendBatch(siteUrl, runId, run.cursor);
      return;
    }

    // 3. No key, or the cap is 0: the assistant is off. No site address: the chain can't go on.
    const key = config.ownerSecret(AI_SECRET_NAMES.anthropic);
    const capCents = settings?.monthlyCapCents ?? 2000;
    if (!key || capCents <= 0) {
      await endRun(db, runId, after, 'stopped', 'ai_off');
      return;
    }
    if (!siteUrl) {
      console.warn("[test-lab] the site's address is not set; the run stops");
      await endRun(db, runId, after, 'failed', 'stalled');
      return;
    }

    // 4. Test Lab's own per-minute window: full → this same batch again in a minute.
    if (!(await takeRateWindow(db, TEST_LAB_BUCKET, TEST_LAB_BATCHES_PER_MINUTE))) {
      if (job.local) {
        // Locally a send runs at once, in this process: it would only find the window full again.
        console.warn('[test-lab] the per-minute limit is reached; locally the run stops here');
        await endRun(db, runId, after, 'failed', 'stalled');
        return;
      }
      const minute = Math.floor(Date.now() / 60_000);
      if (!(await sendBatch(siteUrl, runId, after, {delay: 60, keySuffix: `-w${minute}`}))) {
        await endRun(db, runId, after, 'failed', 'stalled');
      }
      return;
    }

    // 5. The cases, 4 at a time. No question_logs rows.
    const ctx: AskContext = {
      db,
      key,
      capCents,
      settings: {
        assistantName: settings?.assistantName ?? HELPDESK_DEFAULTS.assistantName,
        tone: settings?.tone ?? HELPDESK_DEFAULTS.tone,
        confidenceThreshold: settings?.confidenceThreshold ?? HELPDESK_DEFAULTS.confidenceThreshold,
        model: settings?.model ?? HELPDESK_DEFAULTS.model,
      },
      humanTopics: topics.map(topic => topic.keyword),
    };
    const results = await mapPool(cases, CONCURRENCY, async testCase => ({
      ...(await askCase(ctx, testCase)),
      question: testCase.question,
    }));

    // 6. Every case asked has a final result for this run (cap and error included), so the
    // cursor moves past the last one. One statement for the whole batch.
    const newCursor = cases.length ? cases[cases.length - 1]!.id : after;
    const last = cases.length < BATCH || newCursor >= run.maxCaseId;
    const capHit = results.some(result => result.outcome === 'cap');
    const state = await writeBatch(db, {id: runId, after, newCursor, last, capHit}, results);
    if (state !== null) cursor = newCursor;

    // 7. Still running → the next batch (refused for good → the run ends; for a moment → thrown, tried again).
    if (state === 'running' && !(await sendBatch(siteUrl, runId, newCursor))) {
      await endRun(db, runId, newCursor, 'failed', 'stalled');
    }
  } catch (error) {
    const later = error instanceof SendLater;
    // 8. A database error or a send that failed for a moment: tried again; on the last try the
    // run ends as failed (at wherever its cursor got to).
    if (job.attempt >= job.maxAttempts && !healing) {
      await endRun(db, runId, cursor, 'failed', later ? 'stalled' : 'error').catch(() => undefined);
    }
    if (later) throw new Error('The next Test Lab batch could not be sent yet. It will be tried again.');
    const code = (error as {code?: unknown} | null)?.code;
    console.warn(`[test-lab] batch failed${typeof code === 'string' ? ` (${code})` : ''}`);
    // Words for the owner's Jobs tab: never the database's own message.
    throw new Error('A Test Lab batch could not be saved.');
  }
}
