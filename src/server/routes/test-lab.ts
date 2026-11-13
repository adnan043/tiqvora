import {type Context, Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {
  hasControlChars,
  IMPORT_EMPTY_MESSAGE,
  IMPORT_TOO_LONG_MESSAGE,
  launchScore,
  normalizeQuestion,
  oneLine,
  parseImport,
  QUESTION_MESSAGE,
  questionOf,
  TEST_LAB_LIMITS,
  type TestCaseRow,
  type TestCasesPage,
  type TestOutcome,
  type TestRunView,
} from '../../lib/test-lab';
import {audit} from '../../platform/auth';
import {sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {MICROS_PER_CENT} from '../ai/spend';
import {TEST_LAB_LIST, testLabJobKey, testLabJobLabel} from '../knowledge/test-lab';
import {PERMISSIONS} from '../permissions';

/**
 * Test Lab, for holders of `site:helpdesk:settings` (p4 design §7.2). Mounted at
 * `/site-api/helpdesk/test-lab` (src/server/app.ts), BEFORE the public `/helpdesk`.
 *
 *   GET    /cases?after=<id>     TestCasesPage: 50 cases by id, the total, the latest run, the score
 *   POST   /cases                {question, expect?, expectedArticleId?} → 201 {case}
 *   POST   /cases/import         {text} one question per line (≤ 100) → {added, duplicates, overLimit}
 *   PATCH  /cases/:id            {question?, expect?, expectedArticleId?} → {case} (its old result cleared)
 *   DELETE /cases/:id            → {ok: true}
 *   GET    /articles?q=          published articles by title, for the "Expected article" picker
 *   POST   /runs                 "Run all" → 202 {run}; the `test-lab` job asks the questions
 *   GET    /runs/current         {run | null}: the latest run
 *   POST   /runs/:id/cancel      → {run}
 *
 * Limits are the database's, in ONE conditional statement each: ≤ 500 cases (the insert's
 * count), one question per normalized key (UNIQUE), the cases can't change while a run is
 * running (`NOT EXISTS running` in every write), and only ONE run may be running (the partial
 * unique index `test_runs_one_running_key`: "Run all" twice → one run, one job, one 409).
 * A run uses the assistant's monthly cap (src/server/knowledge/test-lab.ts). The settings row is
 * read from the database (money: never the cache). No cache here: an edit screen.
 * Audited: test_lab_run_started, test_lab_run_cancelled, test_lab_cases_imported, test_lab_case_deleted.
 */

const canManage = requirePermission(PERMISSIONS.HELPDESK_SETTINGS);

const PAGE = 50;
const ARTICLES = 20;
const ARTICLE_QUERY_MAX = 80;
const ID_RE = /^[1-9][0-9]{0,9}$/;
const INT_MAX = 2147483647;
const EXPECTS = ['answer', 'handoff'] as const;
type Expect = (typeof EXPECTS)[number];

const ARTICLE_MESSAGE = 'Pick a published article.';
const HANDOFF_ARTICLE_MESSAGE = 'A hand-off case has no expected article.';
const RUN_ACTIVE_MESSAGE = 'Wait for the run to finish.';

type Fields = Record<string, string>;

const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const idOf = (value: string | undefined) => (value && ID_RE.test(value) && Number(value) <= INT_MAX ? Number(value) : null);
const invalid = (c: Context, fields: Fields) => c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);
const notFound = (c: Context) => c.json(problem('not_found', 'No such test question.'), 404);
const runActive = (c: Context) => c.json(problem('run_active', RUN_ACTIVE_MESSAGE), 409);
const duplicate = (c: Context) =>
  c.json({...problem('duplicate', 'That question is already in the list.'), fields: {question: 'That question is already in the list.'}}, 409);

interface CaseInput {
  question?: string;
  key?: string;
  expect?: Expect;
  /** Undefined: not sent (PATCH keeps it). Null: "Any article". */
  expectedArticleId?: number | null;
}

/** POST (all fields, defaults) and PATCH (only what's sent, at least one) share the rules. */
function readCase(value: unknown, partial: boolean): {out: CaseInput; fields: Fields} {
  const v = objectOf(value);
  const out: CaseInput = {};
  const fields: Fields = {};
  if (!partial || v.question !== undefined) {
    const q = questionOf(v.question);
    if (typeof q === 'string') fields.question = q;
    else Object.assign(out, q);
  }
  if (v.expect !== undefined) {
    if ((EXPECTS as readonly unknown[]).includes(v.expect)) out.expect = v.expect as Expect;
    else fields.expect = 'Choose "Expect an answer" or "Expect a hand-off".';
  } else if (!partial) out.expect = 'answer';
  if (v.expectedArticleId !== undefined) {
    const id = v.expectedArticleId;
    if (id === null) out.expectedArticleId = null;
    else if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= INT_MAX) out.expectedArticleId = id;
    else fields.expectedArticleId = ARTICLE_MESSAGE;
  } else if (!partial) out.expectedArticleId = null;
  // A hand-off case has no expected article (sent together; PATCH vs. the stored case is checked in SQL).
  if (out.expect === 'handoff' && typeof out.expectedArticleId === 'number') fields.expectedArticleId = HANDOFF_ARTICLE_MESSAGE;
  if (partial && !Object.keys(fields).length && out.question === undefined && out.expect === undefined && out.expectedArticleId === undefined) {
    fields.question = QUESTION_MESSAGE;
  }
  return {out, fields};
}

/** What the client sends (the validator's output is the typed client's body): the key is derived in the handler. */
type CaseBody = {question: string; expect: Expect; expectedArticleId: number | null};

const createBody = validator('json', (value, c): CaseBody | Response => {
  const {out, fields} = readCase(value, false);
  if (Object.keys(fields).length) return invalid(c, fields);
  return {question: out.question!, expect: out.expect ?? 'answer', expectedArticleId: out.expectedArticleId ?? null};
});

const patchBody = validator('json', (value, c): Partial<CaseBody> | Response => {
  const {out, fields} = readCase(value, true);
  if (Object.keys(fields).length) return invalid(c, fields);
  const body: Partial<CaseBody> = {};
  if (out.question !== undefined) body.question = out.question;
  if (out.expect !== undefined) body.expect = out.expect;
  if (out.expectedArticleId !== undefined) body.expectedArticleId = out.expectedArticleId;
  return body;
});

/** The stored key of a question that passed `questionOf` (validated again: never trusted from the body). */
const keyOf = (question: string) => normalizeQuestion(question).slice(0, TEST_LAB_LIMITS.question);

/**
 * The paste, parsed by the shared `parseImport` (src/lib/test-lab.ts: the screen runs the same
 * code). A bad paste → 422 with `fields.text` (the first problem) and `lines` (every bad line).
 */
function readImport(c: Context, value: unknown): {questions: string[]; keys: string[]} | Response {
  const text = objectOf(value).text;
  if (typeof text !== 'string' || text.length > TEST_LAB_LIMITS.importChars) return invalid(c, {text: IMPORT_TOO_LONG_MESSAGE});
  const {questions, errors} = parseImport(text);
  if (errors.length) {
    return c.json({...problem('invalid_input', errors[0]!.message), fields: {text: errors[0]!.message}, lines: errors}, 422);
  }
  if (!questions.length) return invalid(c, {text: IMPORT_EMPTY_MESSAGE});
  return {questions: questions.map(q => q.question), keys: questions.map(q => q.key)};
}

/** Outputs `{text}` (what the client sends); the handler parses it again (pure, bounded). */
const importBody = validator('json', (value, c): {text: string} | Response => {
  const read = readImport(c, value);
  return read instanceof Response ? read : {text: objectOf(value).text as string};
});

/** `after`: absent or empty → 0; else 0 … 2^31−1, or 422 (never silently the first page). */
const pageQuery = validator('query', (v, c) => {
  const raw = typeof v.after === 'string' ? v.after : '';
  if (!raw) return {after: 0};
  if (!/^(0|[1-9][0-9]{0,9})$/.test(raw) || Number(raw) > INT_MAX) return invalid(c, {after: 'That page link is not valid.'});
  return {after: Number(raw)};
});

/** LIKE/ILIKE wildcards (and the escape itself) taken literally: `100%` finds "100%", not everything. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const articleQuery = validator('query', (v, c) => {
  const q = oneLine(typeof v.q === 'string' ? v.q : '') ?? '';
  if (q.length > ARTICLE_QUERY_MAX) return invalid(c, {q: `Search with up to ${ARTICLE_QUERY_MAX} characters.`});
  if (hasControlChars(q)) return invalid(c, {q: "The search has characters that can't be used."});
  return {q};
});

/* ------------------------------------ output ------------------------------------ */

const caseSelect = {
  id: true,
  question: true,
  expect: true,
  lastAnswer: true,
  lastConfidence: true,
  lastSources: true,
  lastOutcome: true,
  lastPassed: true,
  lastRunAt: true,
  lastRunId: true,
  expectedArticle: {select: {id: true, title: true, status: true}},
} as const;

const runSelect = {
  id: true,
  state: true,
  stopReason: true,
  total: true,
  done: true,
  passed: true,
  cursor: true,
  costMicros: true,
  createdAt: true,
  finishedAt: true,
} as const;

type CaseRow = {
  id: number;
  question: string;
  expect: string;
  lastAnswer: string | null;
  lastConfidence: string | null;
  lastSources: unknown;
  lastOutcome: string | null;
  lastPassed: boolean | null;
  lastRunAt: Date | null;
  lastRunId: number | null;
  expectedArticle: {id: number; title: string; status: string} | null;
};

type RunRow = {
  id: number;
  state: string;
  stopReason: string | null;
  total: number;
  done: number;
  passed: number;
  cursor: number;
  costMicros: bigint;
  createdAt: Date;
  finishedAt: Date | null;
};

/** A run's columns as `RunRow`, for RETURNING. */
const RUN_COLUMNS = Prisma.sql`"id", "state", "stop_reason" AS "stopReason", "total", "done", "passed", "cursor",
  "cost_micros" AS "costMicros", "created_at" AS "createdAt", "finished_at" AS "finishedAt"`;

const CONFIDENCES = new Set(['high', 'medium', 'low', 'none']);
const OUTCOMES = new Set(['pass', 'handoff', 'person', 'no_source', 'wrong_source', 'answered_instead', 'cap', 'error']);

/** The stored snapshot, shape-checked (it is JSON): at most 3 `{id, title, url}`. */
function sourcesOf(value: unknown): TestCaseRow['lastSources'] {
  if (!Array.isArray(value)) return [];
  const out: TestCaseRow['lastSources'] = [];
  for (const item of value.slice(0, 3)) {
    const s = objectOf(item);
    if (typeof s.title !== 'string' || typeof s.url !== 'string') continue;
    out.push({id: typeof s.id === 'number' && Number.isSafeInteger(s.id) ? s.id : null, title: s.title, url: s.url});
  }
  return out;
}

function toCase(row: CaseRow): TestCaseRow {
  return {
    id: row.id,
    question: row.question,
    expect: row.expect === 'handoff' ? 'handoff' : 'answer',
    expectedArticle: row.expectedArticle
      ? {id: row.expectedArticle.id, title: row.expectedArticle.title, status: row.expectedArticle.status}
      : null,
    lastAnswer: row.lastAnswer,
    lastConfidence: row.lastConfidence && CONFIDENCES.has(row.lastConfidence) ? (row.lastConfidence as TestCaseRow['lastConfidence']) : null,
    lastSources: sourcesOf(row.lastSources),
    lastOutcome: row.lastOutcome && OUTCOMES.has(row.lastOutcome) ? (row.lastOutcome as TestOutcome) : null,
    lastPassed: row.lastPassed,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastRunId: row.lastRunId,
  };
}

export function toRunView(row: RunRow): TestRunView {
  return {
    id: row.id,
    state: row.state as TestRunView['state'],
    stopReason: row.stopReason as TestRunView['stopReason'],
    total: row.total,
    done: row.done,
    passed: row.passed,
    cursor: row.cursor,
    // Round up: a started cent shows.
    costCents: Math.ceil(Number(row.costMicros) / MICROS_PER_CENT),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

const latestRun = (db: PrismaClient) => db.testRun.findFirst({select: runSelect, orderBy: {id: 'desc'}});
const readCase1 = (db: PrismaClient, id: number) => db.testCase.findUnique({where: {id}, select: caseSelect});

/**
 * Why a case write wrote nothing (1 round trip, only on that path). In this order: a run is
 * running, the case is gone, the question is taken, the article isn't published, a hand-off case
 * was given an article, the list is full.
 */
async function whyNot(
  db: PrismaClient,
  o: {id: number | null; key: string | null; articleId: number | null; expect: Expect | null}
): Promise<'run_active' | 'not_found' | 'duplicate' | 'article' | 'handoff_article' | 'limit'> {
  const rows = await db.$queryRaw<{running: boolean; exists: boolean; taken: boolean; published: boolean; expect: string | null; count: number}[]>`
    SELECT
      EXISTS (SELECT 1 FROM "test_runs" WHERE "state" = 'running') AS "running",
      (${o.id}::int IS NULL OR EXISTS (SELECT 1 FROM "test_cases" WHERE "id" = ${o.id}::int)) AS "exists",
      (${o.key}::varchar IS NOT NULL AND EXISTS (
        SELECT 1 FROM "test_cases" WHERE "question_key" = ${o.key}::varchar AND "id" IS DISTINCT FROM ${o.id}::int)) AS "taken",
      (${o.articleId}::int IS NULL OR EXISTS (
        SELECT 1 FROM "kb_articles" WHERE "id" = ${o.articleId}::int AND "status" = 'published')) AS "published",
      (SELECT "expect" FROM "test_cases" WHERE "id" = ${o.id}::int) AS "expect",
      (SELECT count(*) FROM "test_cases")::int AS "count"`;
  const r = rows[0]!;
  if (r.running) return 'run_active';
  if (!r.exists) return 'not_found';
  if (r.taken) return 'duplicate';
  if (!r.published) return 'article';
  if (o.articleId !== null && (o.expect ?? r.expect) === 'handoff') return 'handoff_article';
  return 'limit';
}

function refusal(c: Context, why: Awaited<ReturnType<typeof whyNot>>) {
  switch (why) {
    case 'run_active':
      return runActive(c);
    case 'not_found':
      return notFound(c);
    case 'duplicate':
      return duplicate(c);
    case 'article':
      return invalid(c, {expectedArticleId: ARTICLE_MESSAGE});
    case 'handoff_article':
      return invalid(c, {expectedArticleId: HANDOFF_ARTICLE_MESSAGE});
    default:
      return c.json(problem('limit', `The list is full: up to ${TEST_LAB_LIMITS.cases} questions. Delete some first.`), 409);
  }
}

/** A unique violation raised by a raw statement (two saves of the same question at once). */
const isUniqueViolation = (error: unknown) => {
  const e = error as {code?: unknown; meta?: {code?: unknown}} | null;
  return e?.code === 'P2002' || e?.meta?.code === '23505' || /23505|unique constraint/i.test(String((error as Error)?.message ?? ''));
};

/* ------------------------------------ routes ------------------------------------ */

export const testLabRoutes = new Hono()
  .get('/cases', pageQuery, withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const {after} = c.req.valid('query');
    // One round trip. The count is bounded: the table holds at most 500 rows.
    const [rows, total, run, scored] = await Promise.all([
      db.testCase.findMany({where: {id: {gt: after}}, select: caseSelect, orderBy: {id: 'asc'}, take: PAGE + 1}),
      db.testCase.count(),
      latestRun(db),
      // The score comes from the latest run that is running or scored something (a run that never
      // started doesn't wipe the last score).
      db.testRun.findFirst({where: {OR: [{state: 'running'}, {done: {gt: 0}}]}, select: runSelect, orderBy: {id: 'desc'}}),
    ]);
    const items = rows.slice(0, PAGE).map(toCase);
    const body: TestCasesPage = {
      items,
      next: rows.length > PAGE ? items[items.length - 1]!.id : null,
      total,
      run: run ? toRunView(run) : null,
      score: launchScore(scored ? toRunView(scored) : null, total),
    };
    return c.json(body);
  })

  .post('/cases', createBody, withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const me = c.var.viewer.id!;
    const key = keyOf(input.question);
    const articleId = input.expectedArticleId ?? null;
    // ONE statement: the 500 limit, no running run, a published article, the unique key.
    let rows: {id: number}[];
    try {
      rows = await db.$queryRaw<{id: number}[]>`
        INSERT INTO "test_cases" ("question", "question_key", "expect", "expected_article_id", "created_by", "created_at", "updated_at")
        SELECT ${input.question}, ${key}, ${input.expect}, ${articleId}::int, ${me}, now(), now()
        WHERE (SELECT count(*) FROM "test_cases") < ${TEST_LAB_LIMITS.cases}
          AND NOT EXISTS (SELECT 1 FROM "test_runs" WHERE "state" = 'running')
          AND (${articleId}::int IS NULL OR EXISTS (
            SELECT 1 FROM "kb_articles" WHERE "id" = ${articleId}::int AND "status" = 'published'))
        ON CONFLICT ("question_key") DO NOTHING
        RETURNING "id"`;
    } catch (error) {
      if (isUniqueViolation(error)) return duplicate(c);
      throw error;
    }
    if (!rows.length) return refusal(c, await whyNot(db, {id: null, key, articleId, expect: input.expect}));
    const row = await readCase1(db, rows[0]!.id);
    if (!row) return notFound(c);
    return c.json({case: toCase(row)}, 201);
  })

  .post('/cases/import', importBody, withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const parsed = readImport(c, c.req.valid('json'));
    if (parsed instanceof Response) return parsed;
    const {questions, keys} = parsed;
    const me = c.var.viewer.id!;
    // ONE statement: new keys only, in the order pasted, as many as fit under 500, none while a
    // run is running. `blocked` = new to this snapshot but past the room left (the cap). What was
    // tried and didn't go in was already there or saved by another import at the same moment
    // (ON CONFLICT): a duplicate either way, never "over the limit".
    const rows = await db.$queryRaw<{busy: boolean; added: number; blocked: number}[]>`
      WITH busy AS (
        SELECT EXISTS (SELECT 1 FROM "test_runs" WHERE "state" = 'running') AS "busy"
      ), input AS (
        SELECT q, k, ord FROM unnest(${questions}::text[], ${keys}::text[]) WITH ORDINALITY AS i(q, k, ord)
      ), fresh AS (
        SELECT q, k, ord FROM input
        WHERE NOT EXISTS (SELECT 1 FROM "test_cases" t WHERE t."question_key" = input.k)
        ORDER BY ord
        LIMIT GREATEST(0, ${TEST_LAB_LIMITS.cases} - (SELECT count(*) FROM "test_cases"))
      ), ins AS (
        INSERT INTO "test_cases" ("question", "question_key", "expect", "created_by", "created_at", "updated_at")
        SELECT q, k, 'answer', ${me}, now(), now() FROM fresh
        WHERE NOT (SELECT "busy" FROM busy)
        ORDER BY ord
        ON CONFLICT ("question_key") DO NOTHING
        RETURNING "id"
      )
      SELECT (SELECT "busy" FROM busy) AS "busy",
        (SELECT count(*) FROM ins)::int AS "added",
        ((SELECT count(*) FROM input WHERE NOT EXISTS (SELECT 1 FROM "test_cases" t WHERE t."question_key" = input.k))
          - (SELECT count(*) FROM fresh))::int AS "blocked"`;
    const r = rows[0]!;
    if (r.busy) return runActive(c);
    const overLimit = Math.max(0, r.blocked);
    const duplicates = Math.max(0, questions.length - r.added - overLimit);
    if (r.added) await audit(db, {actorUserId: me, action: 'test_lab_cases_imported', meta: {added: r.added}});
    return c.json({added: r.added, duplicates, overLimit});
  })

  .patch('/cases/:id', patchBody, withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    const input = c.req.valid('json');
    const question = input.question ?? null;
    const key = question === null ? null : keyOf(question);
    const expect = input.expect ?? null;
    const setArticle = input.expectedArticleId !== undefined;
    const articleId = input.expectedArticleId ?? null;
    // ONE conditional statement. A hand-off case drops its article; an article on a hand-off case
    // (the stored or the new expect) is refused. The old result is cleared: it was for another case.
    let rows: {id: number}[];
    try {
      rows = await db.$queryRaw<{id: number}[]>`
        WITH n AS (
          SELECT t."id",
            COALESCE(${expect}::varchar, t."expect") AS "expect",
            CASE WHEN ${setArticle}::boolean THEN ${articleId}::int
                 WHEN ${expect}::varchar = 'handoff' THEN NULL
                 ELSE t."expected_article_id" END AS "article"
          FROM "test_cases" t WHERE t."id" = ${id}
        )
        UPDATE "test_cases" t
        SET "question" = COALESCE(${question}::varchar, t."question"),
            "question_key" = COALESCE(${key}::varchar, t."question_key"),
            "expect" = n."expect",
            "expected_article_id" = n."article",
            "last_answer" = NULL, "last_confidence" = NULL, "last_sources" = NULL, "last_outcome" = NULL,
            "last_passed" = NULL, "last_run_at" = NULL, "last_run_id" = NULL,
            "updated_at" = now()
        FROM n
        WHERE t."id" = n."id"
          AND NOT EXISTS (SELECT 1 FROM "test_runs" WHERE "state" = 'running')
          AND NOT (n."expect" = 'handoff' AND n."article" IS NOT NULL)
          AND (NOT ${setArticle}::boolean OR ${articleId}::int IS NULL OR EXISTS (
            SELECT 1 FROM "kb_articles" WHERE "id" = ${articleId}::int AND "status" = 'published'))
          AND (${key}::varchar IS NULL OR NOT EXISTS (
            SELECT 1 FROM "test_cases" o WHERE o."question_key" = ${key}::varchar AND o."id" <> ${id}))
        RETURNING t."id"`;
    } catch (error) {
      if (isUniqueViolation(error)) return duplicate(c);
      throw error;
    }
    if (!rows.length) {
      return refusal(c, await whyNot(db, {id, key, articleId: setArticle ? articleId : null, expect}));
    }
    const row = await readCase1(db, id);
    if (!row) return notFound(c);
    return c.json({case: toCase(row)});
  })

  .delete('/cases/:id', withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    const rows = await db.$queryRaw<{id: number}[]>`
      DELETE FROM "test_cases"
      WHERE "id" = ${id} AND NOT EXISTS (SELECT 1 FROM "test_runs" WHERE "state" = 'running')
      RETURNING "id"`;
    if (!rows.length) return refusal(c, await whyNot(db, {id, key: null, articleId: null, expect: null}));
    await audit(db, {actorUserId: c.var.viewer.id, action: 'test_lab_case_deleted', target: ['test_case', id]});
    return c.json({ok: true as const});
  })

  .get('/articles', articleQuery, withViewer, requireAuth, canManage, withDb, async c => {
    const {q} = c.req.valid('query');
    const items = await c.var.db.kbArticle.findMany({
      where: {status: 'published', ...(q ? {title: {contains: likeEscape(q), mode: 'insensitive' as const}} : {})},
      select: {id: true, title: true},
      orderBy: [{title: 'asc'}, {id: 'asc'}],
      take: ARTICLES,
    });
    return c.json({items});
  })

  .post('/runs', withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    // The cap from the DATABASE (money: never the cache).
    const settings = await db.helpdeskSettings.findUnique({where: {id: 1}, select: {monthlyCapCents: true}});
    if (!config.ownerSecret(AI_SECRET_NAMES.anthropic) || (settings?.monthlyCapCents ?? 2000) <= 0) {
      return c.json(problem('ai_off', 'Add your Anthropic API key and a monthly spending cap in Assistant to run tests.'), 409);
    }
    // ONE statement: a run over every case there is now, unless one is already running (the
    // partial unique index refuses the second) or there are no cases (HAVING).
    const created = await db.$queryRaw<RunRow[]>`
      INSERT INTO "test_runs" ("state", "total", "max_case_id", "started_by", "created_at", "updated_at")
      SELECT 'running', count(*)::int, max("id"), ${me}, now(), now() FROM "test_cases" HAVING count(*) > 0
      ON CONFLICT DO NOTHING
      RETURNING ${RUN_COLUMNS}`;
    if (!created.length) {
      const running = await db.testRun.findFirst({where: {state: 'running'}, select: runSelect});
      if (running) return c.json({...problem('run_active', 'A run is already going.'), run: toRunView(running)}, 409);
      return c.json(problem('no_cases', 'Add a question to test first.'), 422);
    }
    const run = created[0]!;
    const {id, total} = run;
    // Locally (the Preview) the whole run happens inside this send.
    let sent = true;
    try {
      await sendJob(c.req.url, TEST_LAB_LIST, {runId: id, after: 0}, {key: testLabJobKey(id, 0), label: testLabJobLabel(id)});
    } catch {
      sent = false;
    }
    if (!sent) {
      await db.$executeRaw`
        UPDATE "test_runs" SET "state" = 'failed', "stop_reason" = 'not_started', "finished_at" = now(), "updated_at" = now()
        WHERE "id" = ${id} AND "state" = 'running'`;
      return c.json(problem('not_started', "The run couldn't start. Try again in a minute."), 503);
    }
    // The columns came back from the INSERT: no re-read. The job may already have moved it on
    // (locally it runs inside the send); the screen polls /runs/current.
    await audit(db, {actorUserId: me, action: 'test_lab_run_started', target: ['test_run', id], meta: {total}});
    return c.json({run: toRunView(run)}, 202);
  })

  .get('/runs/current', withViewer, requireAuth, canManage, withDb, async c => {
    const run = await latestRun(c.var.db);
    return c.json({run: run ? toRunView(run) : null});
  })

  .post('/runs/:id/cancel', withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return c.json(problem('not_found', 'No such run.'), 404);
    // Conditional: only a running run. Questions already being asked still finish (their results
    // are kept); the next batch sees the state and stops.
    const rows = await db.$queryRaw<RunRow[]>`
      UPDATE "test_runs" SET "state" = 'cancelled', "finished_at" = now(), "updated_at" = now()
      WHERE "id" = ${id} AND "state" = 'running'
      RETURNING ${RUN_COLUMNS}`;
    if (!rows.length) {
      const run = await db.testRun.findUnique({where: {id}, select: runSelect});
      if (!run) return c.json(problem('not_found', 'No such run.'), 404);
      return c.json({...problem('changed', 'This run has already finished.'), run: toRunView(run)}, 409);
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'test_lab_run_cancelled', target: ['test_run', id]});
    return c.json({run: toRunView(rows[0]!)});
  });
