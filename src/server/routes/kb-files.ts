import {type Context, Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {AI_SECRET_NAMES} from '../../lib/ai-models';
import {
  KB_FILE_LIMITS,
  KB_FILE_MESSAGES,
  KB_FILE_NOT_REMOVED_MESSAGE,
  KB_FILE_TYPES,
  type KbFileDeleted,
  type KbFileDetail,
  type KbFileDraft,
  type KbFileKind,
  kbFileKindOf,
  type KbFileRow,
  type KbFilesPage,
  type KbFileState,
  type KbFilesUsage,
  type KbFileUploadStart,
  type KbStorageState,
  kbFileNameProblem,
  kbFileSizeProblem,
} from '../../lib/kb-file-types';
import {SiteKeyMissing} from '../../platform/api';
import {audit} from '../../platform/auth';
import {config} from '../../platform/config';
import {completeUpload, createUpload, deleteFile, fileUrl, storageUsage} from '../../platform/files';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {capMicrosOf, MICROS_PER_CENT} from '../ai/spend';
import {kbFilesDayCounter, queueKbExtractLater} from '../kb/sources/pipeline';
import {PERMISSIONS} from '../permissions';

/**
 * Knowledge files, for the knowledge base's editors (`site:kb:edit`). Mounted at
 * `/site-api/kb/files` (src/server/app.ts), BEFORE `/kb/manage` and the public `/kb`.
 *
 *   GET    /usage            KbFilesUsage: storage space left, whether PDFs can be read
 *   GET    /?before=<id>     KbFilesPage: 20 files, newest first
 *   GET    /:id              {file: KbFileDetail}: the file and the drafts made from it
 *   POST   /                 {name, size, categoryId} → 201 {file: {id}, upload}: the browser PUTs
 *                            the bytes straight to storage (putFile), never through here
 *   POST   /:id/complete     the uploader confirms the PUT → {file}; the reading starts after the
 *                            answer (`waitUntil`, src/server/kb/sources/pipeline.ts)
 *   POST   /:id/retry        {categoryId?: number | null} a failed or stopped file again (a new
 *                            round) → {file}; 409 already_started, 429 rate_limited
 *   POST   /:id/cancel       stop reading → {file}; 409 already_finished / not_started (uploading)
 *   GET    /:id/view         302 to a 5-minute private link (?download=1 to save it)
 *   DELETE /:id              the file (its drafts stay in Articles) → {ok, fileDeleted, message}
 *
 * The content type sent to storage is derived from the file's extension, never taken from the
 * body. Limits: ≤ 20 uploads + retries per editor per UTC day and ≤ 5 files being read at once, both inside
 * the INSERT's own WHERE (one statement); PDFs need the assistant's key and a monthly cap.
 * Retries count against the same limits. Per editor, uploads + retries per UTC day ≤ 20: a
 * `helpdesk_counters` row `kb-files:<user>:<day>` moved by a conditional upsert inside the upload's
 * INSERT / the retry's UPDATE statement (the row lock makes it hold under many requests at once).
 * No cache: an edit screen (every answer `no-store`, a validator's 422 too). Audited:
 * kb_file_uploaded, kb_file_retried, kb_file_cancelled, kb_file_viewed, kb_file_deleted (and from
 * the job: kb_file_drafted, kb_file_failed). Never a file name in an audit row.
 */

const canEdit = requirePermission(PERMISSIONS.KB_EDIT);

const PAGE = 20;
const ID_RE = /^[1-9][0-9]{0,9}$/;
const INT_MAX = 2147483647;
/** `round` is a SMALLINT. */
const ROUND_MAX = 32767;
const FORMER = 'Former team member';
const DAILY_LIMIT_MESSAGE = `You uploaded or retried ${KB_FILE_LIMITS.uploadsPerDay} files today. Try again tomorrow.`;
const ACTIVE_LIMIT_MESSAGE = 'Five files are being read. Wait for one to finish.';

/** Every answer here, a validator's 422 too, is never cached. */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

type Fields = Record<string, string>;

const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const idOf = (value: string | undefined) => (value && ID_RE.test(value) && Number(value) <= INT_MAX ? Number(value) : null);
const positiveInt = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= INT_MAX ? value : null);
const invalid = (c: Context, fields: Fields) => c.json({...problem('fields', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);
const notFound = (c: Context) => c.json(problem('not_found', 'No such file.'), 404);
const storageUnavailable = (c: Context) => c.json(problem('storage_unavailable', "File storage isn't available here."), 503);

/* ---------------------------------- validators ---------------------------------- */

const idParam = validator('param', (value, c) => {
  const id = idOf(value.id);
  if (id === null) return notFound(c);
  return {id};
});

const pageQuery = validator('query', value => ({
  // A string here: the typed client sends query values as strings.
  before: typeof value.before === 'string' ? value.before : '',
}));

const viewQuery = validator('query', value => ({download: value.download === '1' ? ('1' as const) : ('' as const)}));

const uploadBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const fields: Fields = {};
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const nameProblem = kbFileNameProblem(name);
  if (nameProblem) fields.name = nameProblem;
  const kind: KbFileKind | null = nameProblem ? null : kbFileKindOf(name);
  const size = typeof v.size === 'number' && Number.isSafeInteger(v.size) ? v.size : null;
  // Without a kind only the size's own shape is checked (the per-kind cap needs the kind).
  const sizeProblem = kbFileSizeProblem(kind ?? 'txt', v.size);
  if (sizeProblem && (kind || sizeProblem === KB_FILE_MESSAGES.size || sizeProblem === KB_FILE_MESSAGES.empty)) fields.size = sizeProblem;
  const categoryId = positiveInt(v.categoryId);
  if (categoryId === null) fields.categoryId = KB_FILE_MESSAGES.category;
  if (Object.keys(fields).length || !kind || size === null || categoryId === null) return invalid(c, fields);
  return {name, size, categoryId};
});

const retryBody = validator('json', (value, c) => {
  const v = objectOf(value);
  if (v.categoryId === undefined || v.categoryId === null) return {categoryId: null as number | null};
  const categoryId = positiveInt(v.categoryId);
  if (categoryId === null) return invalid(c, {categoryId: KB_FILE_MESSAGES.category});
  return {categoryId: categoryId as number | null};
});

/* ------------------------------------ reads ------------------------------------ */

interface RowData {
  id: number;
  name: string;
  kind: string;
  size: number;
  state: string;
  step: number;
  pagesTotal: number | null;
  draftsCreated: number;
  error: string;
  spentMicros: number;
  categoryId: number | null;
  categoryName: string | null;
  uploader: string | null;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

/** One file or a page of files, with its category and its uploader's name, in ONE statement. */
function readRows(db: PrismaClient, where: {id: number} | {before: number | null}) {
  const id = 'id' in where ? where.id : null;
  const before = 'before' in where ? where.before : null;
  return db.$queryRaw<RowData[]>`
    SELECT s."id", s."name", s."kind", s."size", s."state", s."step", s."pages_total" AS "pagesTotal",
      s."drafts_created" AS "draftsCreated", s."error", s."spent_micros" AS "spentMicros",
      s."category_id" AS "categoryId", k."name" AS "categoryName", u."name" AS "uploader",
      s."created_at" AS "createdAt", s."completed_at" AS "completedAt", s."updated_at" AS "updatedAt"
    FROM "kb_sources" s
    LEFT JOIN "kb_categories" k ON k."id" = s."category_id"
    LEFT JOIN "users" u ON u."id" = s."created_by"
    WHERE (${id}::int IS NULL OR s."id" = ${id}::int)
      AND (${before}::int IS NULL OR s."id" < ${before}::int)
    ORDER BY s."id" DESC
    LIMIT ${id === null ? PAGE + 1 : 1}`;
}

function toRow(r: RowData): KbFileRow {
  const kind = r.kind as KbFileKind;
  const state = r.state as KbFileState;
  return {
    id: r.id,
    name: r.name,
    kind,
    size: r.size,
    state,
    pagesDone: kind === 'pdf' ? Math.max(0, r.step - 1) : 0,
    pagesTotal: r.pagesTotal,
    draftsCreated: r.draftsCreated,
    error: r.error,
    couldNotRead: state === 'failed' && r.error === KB_FILE_MESSAGES.couldNotRead,
    costCents: Math.ceil(r.spentMicros / MICROS_PER_CENT),
    category: r.categoryId !== null && r.categoryName !== null ? {id: r.categoryId, name: r.categoryName} : null,
    uploadedBy: r.uploader ?? FORMER,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function readOne(db: PrismaClient, id: number): Promise<KbFileRow | null> {
  const rows = await readRows(db, {id});
  return rows[0] ? toRow(rows[0]) : null;
}

/** The owner's key is set and the monthly cap is above 0 (the settings row from the DATABASE). */
async function pdfReady(db: PrismaClient): Promise<boolean> {
  if (!config.ownerSecret(AI_SECRET_NAMES.anthropic)) return false;
  const settings = await db.helpdeskSettings.findUnique({where: {id: 1}, select: {monthlyCapCents: true}});
  return capMicrosOf(settings?.monthlyCapCents ?? 2000) > 0;
}

const pdfNeedsAi = (c: Context) => c.json(problem('pdf_needs_ai', KB_FILE_MESSAGES.pdfNeedsAi), 409);

/** A platform storage call: its answer, or 'no_key' when this machine has no Site Key, or 'error'. */
async function storage<T>(call: () => Promise<T>): Promise<T | 'no_key' | 'error'> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SiteKeyMissing) return 'no_key';
    // A bad id or anything else: a code only.
    console.warn('[kb-files] storage call failed');
    return 'error';
  }
}

const STORAGE_STATES: Record<string, KbStorageState> = {
  E_STORAGE_NEEDS_PACK: 'needs_pack',
  E_STORAGE_OFF: 'off',
  E_STORAGE_UNAVAILABLE: 'unavailable',
};

/* ------------------------------------ routes ------------------------------------ */

export const kbFileRoutes = new Hono()
  .use(noStore)
  .get('/usage', withViewer, requireAuth, canEdit, withDb, async c => {
    const [usage, ready] = await Promise.all([storage(() => storageUsage(c.req.url)), pdfReady(c.var.db)]);
    const maxFileBytes = KB_FILE_LIMITS.pdfBytes;
    let body: KbFilesUsage;
    if (usage === 'no_key') body = {storage: 'unavailable', usedBytes: null, limitBytes: null, maxFileBytes, pdfReady: ready};
    else if (usage === 'error') body = {storage: 'unreachable', usedBytes: null, limitBytes: null, maxFileBytes, pdfReady: ready};
    else if (usage.ok) {
      body = {
        storage: 'ok',
        usedBytes: usage.data.usedBytes,
        limitBytes: usage.data.limitBytes,
        maxFileBytes: Math.min(maxFileBytes, usage.data.maxFileBytes || maxFileBytes),
        pdfReady: ready,
      };
    } else body = {storage: STORAGE_STATES[usage.code] ?? 'unreachable', usedBytes: null, limitBytes: null, maxFileBytes, pdfReady: ready};
    return c.json(body);
  })

  .get('/', pageQuery, withViewer, requireAuth, canEdit, withDb, async c => {
    const before = idOf(c.req.valid('query').before);
    const rows = await readRows(c.var.db, {before});
    const items = rows.slice(0, PAGE).map(toRow);
    const body: KbFilesPage = {items, next: rows.length > PAGE ? items[items.length - 1]!.id : null};
    return c.json(body);
  })

  .get('/:id', idParam, withViewer, requireAuth, canEdit, withDb, async c => {
    const {id} = c.req.valid('param');
    const db = c.var.db;
    const [file, drafts] = await Promise.all([
      readOne(db, id),
      db.kbArticle.findMany({
        where: {sourceId: id},
        orderBy: {id: 'asc'},
        take: KB_FILE_LIMITS.maxDrafts,
        select: {id: true, title: true, status: true},
      }),
    ]);
    if (!file) return notFound(c);
    const body: KbFileDetail = {...file, drafts: drafts.map(d => ({id: d.id, title: d.title, status: d.status as KbFileDraft['status']}))};
    return c.json({file: body});
  })

  .post('/', uploadBody, withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {name, size, categoryId} = c.req.valid('json');
    const kind = kbFileKindOf(name)!;

    // 1. One parallel read: the AI for a PDF, today's uploads + retries, files being read, the category.
    const today = kbFilesDayCounter(me);
    const [ready, mine, active, category] = await Promise.all([
      kind === 'pdf' ? pdfReady(db) : Promise.resolve(true),
      db.helpdeskCounter.findUnique({where: {name: today}, select: {value: true}}),
      db.kbSource.findMany({where: {state: {in: ['queued', 'extracting']}}, take: KB_FILE_LIMITS.activeAtOnce, select: {id: true}}),
      db.kbCategory.findUnique({where: {id: categoryId}, select: {id: true}}),
    ]);
    if (!ready) return pdfNeedsAi(c);
    if (!category) return invalid(c, {categoryId: KB_FILE_MESSAGES.category});
    if ((mine?.value ?? 0) >= KB_FILE_LIMITS.uploadsPerDay) return c.json(problem('rate_limited', DAILY_LIMIT_MESSAGE), 429);
    if (active.length >= KB_FILE_LIMITS.activeAtOnce) return c.json(problem('rate_limited', ACTIVE_LIMIT_MESSAGE), 429);

    // 2. The upload grant (private); the type comes from the kind, never from the body.
    const grant = await storage(() => createUpload(c.req.url, {name, contentType: KB_FILE_TYPES[kind].contentType, size}));
    if (grant === 'no_key' || grant === 'error') return storageUnavailable(c);
    if (!grant.ok) return c.json(problem('storage', grant.message), grant.status === 402 ? 402 : 400);

    // 3. The row, with the limits checked again in the same statement: the editor's day counted by
    // a conditional upsert (its row lock: many uploads at once can't pass 20), then the INSERT only
    // when it was counted.
    const rows = await db.$queryRaw<{id: number}[]>`
      WITH counted AS (
        INSERT INTO "helpdesk_counters" ("name", "value", "updated_at")
        SELECT ${today}, 1, now()
        WHERE (SELECT count(*) FROM (
            SELECT 1 FROM "kb_sources" WHERE "state" IN ('queued', 'extracting')
            LIMIT ${KB_FILE_LIMITS.activeAtOnce}) active) < ${KB_FILE_LIMITS.activeAtOnce}
          AND EXISTS (SELECT 1 FROM "kb_categories" WHERE "id" = ${categoryId}::int)
        ON CONFLICT ("name") DO UPDATE SET "value" = "helpdesk_counters"."value" + 1, "updated_at" = now()
        WHERE "helpdesk_counters"."value" < ${KB_FILE_LIMITS.uploadsPerDay}
        RETURNING 1
      )
      INSERT INTO "kb_sources" ("file_id", "name", "kind", "size", "category_id", "created_by", "created_at", "updated_at")
      SELECT ${grant.data.file.id}, ${name}, ${kind}, ${size}::int, ${categoryId}::int, ${me}::int, now(), now()
      WHERE EXISTS (SELECT 1 FROM counted)
      RETURNING "id"`;
    // Refused at the last moment: the pending file is removed by storage within the hour.
    if (!rows[0]) return c.json(problem('rate_limited', 'Too many uploads at once. Try again in a minute.'), 429);
    const body: KbFileUploadStart = {file: {id: rows[0].id}, upload: grant.data.upload};
    return c.json(body, 201);
  })

  .post('/:id/complete', idParam, withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {id} = c.req.valid('param');
    // Only the uploader completes their own upload; anyone else: 404.
    const row = await db.kbSource.findFirst({where: {id, createdBy: me}, select: {fileId: true, kind: true, state: true}});
    if (!row) return notFound(c);
    if (row.state !== 'uploading') return c.json(problem('already_started', 'This upload was already started.'), 409);

    const done = await storage(() => completeUpload(c.req.url, row.fileId));
    if (done === 'no_key' || done === 'error') return storageUnavailable(c);
    if (!done.ok) return c.json(problem('storage', done.message), 400);

    const moved = await db.$executeRaw`
      UPDATE "kb_sources" SET "state" = 'queued', "updated_at" = now()
      WHERE "id" = ${id} AND "created_by" = ${me} AND "state" = 'uploading'`;
    if (!moved) return c.json(problem('already_started', 'This upload was already started.'), 409);

    // The reading starts after this answer (never awaited here). A refused send leaves the row
    // `queued`: the sweep sends it.
    queueKbExtractLater(c, id, 0);
    const [file] = await Promise.all([
      readOne(db, id),
      audit(db, {actorUserId: me, action: 'kb_file_uploaded', target: ['kb_source', id], meta: {kind: row.kind}}),
    ]);
    if (!file) return notFound(c);
    return c.json({file});
  })

  .post('/:id/retry', idParam, retryBody, withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const {id} = c.req.valid('param');
    const {categoryId} = c.req.valid('json');
    // 1. One parallel read: the row, the new category, whether PDFs can be read.
    const [row, category, ready] = await Promise.all([
      db.kbSource.findUnique({where: {id}, select: {kind: true, state: true, categoryId: true}}),
      categoryId === null ? Promise.resolve(null) : db.kbCategory.findUnique({where: {id: categoryId}, select: {id: true}}),
      pdfReady(db),
    ]);
    if (!row) return notFound(c);
    if (categoryId !== null && !category) return invalid(c, {categoryId: KB_FILE_MESSAGES.category});
    if (categoryId === null && row.categoryId === null) return invalid(c, {categoryId: KB_FILE_MESSAGES.category});
    if (row.kind === 'pdf' && !ready) return pdfNeedsAi(c);

    // 2. ONE statement: the limits (≤ 5 being read, the editor's uploads + retries today < 20),
    // the retry counted (a conditional upsert: its row lock holds the daily limit under many
    // requests), and a new round (every job key changes), everything read so far cleared. It
    // answers why when nothing moved.
    const today = kbFilesDayCounter(me);
    const rows = await db.$queryRaw<{state: string; round: number; active: number; mine: number; moved: number | null}[]>`
      WITH cur AS (
        -- Locked: a second retry of the same file at once waits here, then sees it queued (409),
        -- and counts nothing.
        SELECT "state", "round" FROM "kb_sources" WHERE "id" = ${id} FOR UPDATE
      ), lim AS (
        SELECT
          (SELECT count(*) FROM (
            SELECT 1 FROM "kb_sources" WHERE "state" IN ('queued', 'extracting') LIMIT ${KB_FILE_LIMITS.activeAtOnce}) a)::int AS "active",
          COALESCE((SELECT "value" FROM "helpdesk_counters" WHERE "name" = ${today}), 0)::int AS "mine"
      ), go AS (
        SELECT 1 FROM cur, lim
        WHERE cur."state" IN ('failed', 'cancelled') AND cur."round" < ${ROUND_MAX}
          AND lim."active" < ${KB_FILE_LIMITS.activeAtOnce} AND lim."mine" < ${KB_FILE_LIMITS.uploadsPerDay}
      ), counted AS (
        INSERT INTO "helpdesk_counters" ("name", "value", "updated_at")
        SELECT ${today}, 1, now() FROM go
        ON CONFLICT ("name") DO UPDATE SET "value" = "helpdesk_counters"."value" + 1, "updated_at" = now()
        WHERE "helpdesk_counters"."value" < ${KB_FILE_LIMITS.uploadsPerDay}
        RETURNING 1
      ), moved AS (
        UPDATE "kb_sources"
        SET "state" = 'queued', "step" = 0, "round" = "round" + 1, "pages_per_call" = ${KB_FILE_LIMITS.pagesPerCall}::int,
            "pages_total" = NULL, "input_tokens" = NULL, "text" = '', "error" = '', "drafts_created" = 0, "completed_at" = NULL,
            "category_id" = COALESCE(${categoryId}::int, "category_id"), "updated_at" = now()
        WHERE "id" = ${id} AND "state" IN ('failed', 'cancelled') AND "round" < ${ROUND_MAX}
          AND EXISTS (SELECT 1 FROM counted)
        RETURNING "round"::int AS "round"
      )
      SELECT cur."state", cur."round"::int AS "round", lim."active", lim."mine", (SELECT "round" FROM moved) AS "moved"
      FROM cur, lim`;
    const result = rows[0];
    if (!result) return notFound(c);
    if (result.moved === null) {
      if (result.state !== 'failed' && result.state !== 'cancelled') {
        return c.json(problem('already_started', 'Only a file that failed or was stopped can be tried again.'), 409);
      }
      if (result.round >= ROUND_MAX) return c.json(problem('already_started', 'This file was tried too many times. Upload it again.'), 409);
      if (result.active >= KB_FILE_LIMITS.activeAtOnce) return c.json(problem('rate_limited', ACTIVE_LIMIT_MESSAGE), 429);
      return c.json(problem('rate_limited', DAILY_LIMIT_MESSAGE), 429);
    }

    queueKbExtractLater(c, id, result.moved);
    const [file] = await Promise.all([
      readOne(db, id),
      audit(db, {actorUserId: me, action: 'kb_file_retried', target: ['kb_source', id], meta: {kind: row.kind, round: result.moved}}),
    ]);
    if (!file) return notFound(c);
    return c.json({file});
  })

  .post('/:id/cancel', idParam, withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const {id} = c.req.valid('param');
    // A running job finds the row cancelled at its next write and stops.
    const rows = await db.$queryRaw<{state: string; kind: string; round: number; moved: boolean}[]>`
      WITH cur AS (
        SELECT "state", "kind", "round" FROM "kb_sources" WHERE "id" = ${id}
      ), moved AS (
        UPDATE "kb_sources" SET "state" = 'cancelled', "text" = '', "updated_at" = now()
        WHERE "id" = ${id} AND "state" IN ('queued', 'extracting')
        RETURNING 1
      )
      SELECT "state", "kind", "round"::int AS "round", EXISTS (SELECT 1 FROM moved) AS "moved" FROM cur`;
    const result = rows[0];
    if (!result) return notFound(c);
    if (!result.moved) {
      if (result.state === 'uploading') {
        return c.json(problem('not_started', "This file hasn't finished uploading, so there is nothing to stop. Delete it instead."), 409);
      }
      return c.json(problem('already_finished', result.state === 'drafted' ? 'It already finished.' : 'It already stopped.'), 409);
    }
    const [file] = await Promise.all([
      readOne(db, id),
      audit(db, {actorUserId: c.var.viewer.id!, action: 'kb_file_cancelled', target: ['kb_source', id], meta: {kind: result.kind, round: result.round}}),
    ]);
    if (!file) return notFound(c);
    return c.json({file});
  })

  .get('/:id/view', idParam, viewQuery, withViewer, requireAuth, canEdit, withDb, async c => {
    const {id} = c.req.valid('param');
    const {download} = c.req.valid('query');
    const db = c.var.db;
    const row = await db.kbSource.findUnique({where: {id}, select: {fileId: true, kind: true, state: true}});
    if (!row || row.state === 'uploading') return notFound(c);
    // A PDF opens in the browser; Word, text and Markdown always download (never rendered here).
    const asDownload = row.kind !== 'pdf' || download === '1';
    const link = await storage(() => fileUrl(c.req.url, row.fileId, {expiresIn: 300, download: asDownload}));
    if (link === 'no_key' || link === 'error') return storageUnavailable(c);
    if (!link.ok) return c.json(problem('storage', link.message), 400);
    await audit(db, {actorUserId: c.var.viewer.id!, action: 'kb_file_viewed', target: ['kb_source', id], meta: {kind: row.kind, download: asDownload}});
    c.header('Cache-Control', 'private, no-store');
    return c.redirect(link.data.url, 302);
  })

  .delete('/:id', idParam, withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const {id} = c.req.valid('param');
    // Its drafts stay (source_id → NULL). A running job finds no row and returns. PDF spend lives
    // on its own monthly counter (src/server/kb/sources/pipeline.ts): deleting frees none of it.
    const rows = await db.$queryRaw<{fileId: string; kind: string}[]>`
      DELETE FROM "kb_sources" WHERE "id" = ${id} RETURNING "file_id" AS "fileId", "kind"`;
    const gone = rows[0];
    if (!gone) return notFound(c);
    // No state can hold a row "to be deleted from storage" without a schema change, so the row goes
    // either way and a stored copy that could not be removed is reported (fileDeleted false + the
    // words), audited, and logged (a code only).
    const removed = await storage(() => deleteFile(c.req.url, gone.fileId));
    const fileDeleted = removed !== 'no_key' && removed !== 'error' && (removed.ok || removed.code === 'E_FILE_NOT_FOUND');
    if (!fileDeleted) console.warn(`[kb-files] stored file not deleted: ${typeof removed === 'string' ? removed : removed.ok ? 'ok' : removed.code}`);
    await audit(db, {actorUserId: c.var.viewer.id!, action: 'kb_file_deleted', target: ['kb_source', id], meta: {kind: gone.kind, fileDeleted}});
    const body: KbFileDeleted = {ok: true, fileDeleted, message: fileDeleted ? null : KB_FILE_NOT_REMOVED_MESSAGE};
    return c.json(body);
  });
