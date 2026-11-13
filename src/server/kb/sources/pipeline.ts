import type {Context} from 'hono';

import {Prisma, type PrismaClient} from '../../../generated/prisma/client';
import {AI_SECRET_NAMES, EXTRACT_MODEL} from '../../../lib/ai-models';
import {KB_FILE_LIMITS, KB_FILE_MESSAGES, KB_FILE_TYPES, type KbFileKind} from '../../../lib/kb-file-types';
import {KB_LIMITS, slugify} from '../../../lib/kb-types';
import {audit} from '../../../platform/auth';
import {DontRetry, type JobInfo, JobRejected, sendJob} from '../../../platform/background';
import {config} from '../../../platform/config';
import {callAnthropic, countTokens, type ProviderResult} from '../../ai/provider';
import {capMicrosOf, costOf, settleWith, takeWindowAndReserve} from '../../ai/spend';
import {monthKey} from '../../ai/usage';
import {articleSlugsLike, excerptOf, freeSlug} from '../articles';
import {docxToMarkdown} from './docx';
import {
  AI_EXTRACT_BUCKET,
  AI_EXTRACT_PER_MINUTE,
  PDF_MAX_TOKENS,
  PDF_SCHEMA,
  PDF_SYSTEM,
  pageRange,
  parseTranscript,
  pdfHold,
  pdfMessages,
  storedInputTokens,
  toBase64,
  tooLongMessage,
  unreadablePageNote,
} from './pdf';
import {readStoredFile} from './read';
import {splitIntoDrafts} from './split';
import {decodeText, FileReadError} from './text';

/**
 * Knowledge files → DRAFT articles (p5 design §5.2 as amended). One job list, `kb-extract`,
 * `{sourceId, round, step}`, keyed `kb-extract-<id>-<round>-<step>[-p<pages per call>]`; the handler is registered in
 * src/server/background.ts and calls `runKbExtractJob`. The `kb-sources-sweep` schedule calls
 * `sweepKbSources`.
 *
 *   txt / md   read the file → decodeText (text.ts) → finalize
 *   docx       read the file → docxToMarkdown (docx.ts) → finalize
 *   pdf        read the file → step 0: count_tokens (refuse > 90K) → ≤ 2 calls per run to the
 *              fixed Claude Haiku 5.5, a few pages each, appended to `kb_sources.text` → the next
 *              step as a new job → … → finalize
 *   finalize   splitIntoDrafts (split.ts) → ≤ 30 DRAFT articles (no chunks: nothing public
 *              changes) and the row `drafted`, in ONE transaction
 *
 * Safe to repeat (at-least-once delivery): every write is conditional on `(id, round, step, state)`;
 * a stale delivery re-sends the row's current step under its own key and returns; finalize writes
 * the drafts and moves the row in one transaction, so a second finalize writes nothing.
 *
 * Keys never repeat within a round (the platform dedupes a key for 24 h after it was sent, so a
 * repeated key would silently drop the next step): every run makes at least one call, and every call
 * either moves the step on or halves the pages per call, so `(step, pagesPerCall)` is new at every
 * chained send — the key carries `-p<n>` whenever pagesPerCall is under 4. A full minute's window
 * adds `-w<minute>`, the sweep's re-send `-s<15-minute slot>`.
 *
 * Never stuck, never paid twice:
 * - ANY failure to read the stored file fails the file with "couldn't read" (no throw, no retry).
 * - A timed-out AI call keeps its hold as its cost and is never repeated at one page.
 * - An HTTP/network failure throws (the platform retries); the last try fails the file first.
 * - The sweep re-sends rows idle for 15 minutes (it repairs refused sends) and fails rows idle
 *   for 2 hours.
 *
 * Time: one run stays inside 60 s: its own budget is 55 s, the file read (the link AND the
 * download, under one deadline) ≤ 15 s, count_tokens
 * ≤ 10 s, each call ≤ min(40 s, what is left − 10 s), and a call starts only with ≥ 15 s left after
 * that 10 s tail (the tail covers the write after the call and the next step's send).
 * Memory: ≤ 8 MB of bytes, dropped once its base64 is built (once per run, in aligned slices: no
 * 8 MB binary string); the list runs one at a time.
 *
 * Money: every call is under the shared monthly cap (spend.ts), and PDF reading as a whole may use
 * only `KB_FILE_LIMITS.pdfCapShare` (25 %) of it per month, so it can't starve the customer
 * assistant. PDF spend is ONE exact counter per month, `kb-pdf-spent:<month>` in
 * `helpdesk_counters`, moved by the very statement that settles each call's money (`withMoney`),
 * on the month the call was held in. It is read once per run, in the statement that reads the cap
 * (the list runs one at a time), and each call's hold is checked against what is left.
 *
 * A zero-call run (the file read and count_tokens used the time) chains under its own step's key
 * + `-t<run start>`: a key no earlier run used.
 */

export const KB_EXTRACT_LIST = 'kb-extract';
/** The step's job key; `-p<n>` when the pages per call were halved (see the header). */
export const kbExtractKey = (id: number, round: number, step: number, perCall: number = KB_FILE_LIMITS.pagesPerCall) =>
  `kb-extract-${id}-${round}-${step}${perCall === KB_FILE_LIMITS.pagesPerCall ? '' : `-p${perCall}`}`;

/** `helpdesk_counters` row: one editor's uploads + retries on one UTC day (≤ 32 characters). */
export const kbFilesDayCounter = (userId: number, now: Date = new Date()) => `kb-files:${userId}:${now.toISOString().slice(0, 10)}`;
/** `helpdesk_counters` row: what PDF reading spent (micro-dollars) in `month` (`monthKey()`). */
export const kbPdfSpentCounter = (month: string) => `kb-pdf-spent:${month}`;
const kbExtractLabel = (id: number) => `Read knowledge file #${id}`;

export interface KbExtractData {
  sourceId: number;
  round: number;
  step: number;
}

type ExtractJob = Pick<JobInfo, 'attempt' | 'maxAttempts'> & Partial<Pick<JobInfo, 'local'>>;

/** No retry will follow this run (the Preview has only one). */
const isLastTry = (job: ExtractJob) => job.local === true || job.attempt >= job.maxAttempts;

const INT_MAX = 2147483647;
const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= INT_MAX;

/** Words on the file (≤ 300 characters: the column). The screen shows them as they are. */
export const KB_EXTRACT_WORDS = {
  couldNotRead: KB_FILE_MESSAGES.couldNotRead,
  pdfNeedsAi: "Reading PDFs needs the assistant's AI key and a monthly budget (Help desk › Assistant). Add them, then try again.",
  pdfShare: "PDF reading has used its share of this month's AI budget. Try again next month or raise the cap.",
  cap: "This month's AI budget is used up. Try again next month, or raise the budget in Help desk › Assistant.",
  budget: 'This file needs more AI reading than one file may use. Split it into smaller files.',
  busyLocal: 'Too many files are being read at once. Try again in a minute.',
  refused: 'The assistant would not read this file.',
  timedOut: "The assistant didn't answer in time. Try again later.",
  noAnswer: "The assistant didn't answer. Try again later.",
  unreadablePdf: "The assistant couldn't read this PDF. Check that it opens, or save it again and upload it.",
  stopped: 'Reading stopped. Try again.',
  error: 'Reading stopped because of an error. Try again.',
  categoryGone: 'Its category was deleted. Pick a category and try again.',
  noText: 'We found no text in this file to make drafts from.',
  longPdf: (pages: number) => `Only the first ${pages} pages were read: the file is very long.`,
  dropped: (made: number, left: number) =>
    `${made} drafts made; ${left} more ${left === 1 ? 'section was' : 'sections were'} left out. Split the file to import the rest.`,
  cutText: 'Only the first part of the file was read: it is very long.',
} as const;

const DISABLED = {type: 'disabled'} as const;
/** The most pages one round reads (`pdfMaxCalls` calls of `pagesPerCall` pages). */
const MAX_PAGES_READ = KB_FILE_LIMITS.pdfMaxCalls * KB_FILE_LIMITS.pagesPerCall;
/** count_tokens at most. */
const COUNT_MS = 10_000;
/** AI calls per run at most. */
const CALLS_PER_RUN = 2;
/** Kept free at the end of a run: the write after a call (≤ 5 s) and the next step's send (≤ 8 s, mostly less). */
const TAIL_MS = 10_000;
/** The sweep's re-send slot (a new key every 15 minutes). */
const RESEND_SLOT_MS = 15 * 60_000;
const ERROR_CHARS = 300;

/* ----------------------------------- sending ----------------------------------- */

/** The next step could not be sent YET (the minute's job limit, the platform not answering). */
class SendLater extends Error {}
/** Try the job again; on the last try the file fails with these words. */
class RetryLater extends Error {}
/** Finalize found the row already moved on (a duplicate delivery): roll the drafts back. */
class Stale extends Error {}

const TRANSIENT_SEND_CODES = new Set(['E_JOBS_RATE_LIMITED', 'E_JOBS_UNREACHABLE']);

/**
 * Sends one step. True = accepted (or deduped). False = refused for good (the sweep sends it
 * again after 15 minutes). Throws `SendLater` when trying the job again will help.
 */
async function sendStep(
  siteUrl: string,
  id: number,
  round: number,
  step: number,
  perCall: number,
  extra: {delay?: number; keySuffix?: string} = {}
): Promise<boolean> {
  try {
    await sendJob(
      siteUrl,
      KB_EXTRACT_LIST,
      {sourceId: id, round, step} satisfies KbExtractData,
      {key: kbExtractKey(id, round, step, perCall) + (extra.keySuffix ?? ''), label: kbExtractLabel(id), ...(extra.delay ? {delay: extra.delay} : {})}
    );
    return true;
  } catch (error) {
    // A code only: never the data.
    const code = error instanceof JobRejected ? error.code : 'error';
    console.warn(`[kb-files] step not sent: ${code}`);
    if (TRANSIENT_SEND_CODES.has(code)) throw new SendLater(code);
    return false;
  }
}

/** Sends a file's first step (round `round`, step 0). Never throws; true = accepted. */
export async function queueKbExtract(requestUrl: string | URL, sourceId: number, round: number): Promise<boolean> {
  try {
    await sendJob(requestUrl, KB_EXTRACT_LIST, {sourceId, round, step: 0} satisfies KbExtractData, {
      key: kbExtractKey(sourceId, round, 0),
      label: kbExtractLabel(sourceId),
    });
    return true;
  } catch (error) {
    console.warn(`[kb-files] first step not sent: ${error instanceof JobRejected ? error.code : 'error'}`);
    return false;
  }
}

/**
 * `queueKbExtract` after the answer is sent (`waitUntil`, as `queueArticleDraftLater`): the route
 * never waits on the send, and in the Preview (where jobs run inline) the reading runs after the
 * response. Never throws. A refused send leaves the row `queued`: the sweep sends it.
 */
export function queueKbExtractLater(c: Context, sourceId: number, round: number): void {
  const work = queueKbExtract(c.req.url, sourceId, round).catch(() => false);
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context: it runs on by itself.
  }
}

/* ----------------------------------- writes ----------------------------------- */

interface Source {
  id: number;
  round: number;
  kind: KbFileKind;
  createdBy: number;
}

interface Money {
  cost: number;
  hold: number;
  month: string;
}

/** Whole micro-dollars, ≥ 0. */
const micros = (value: number) => Math.max(0, Math.ceil(value));

/** The month's PDF counter moved by `cost` (a CTE; `prefix` = the settle's `WITH …` or empty). */
function pdfSpentCte(prefix: Prisma.Sql, money: Money): Prisma.Sql {
  const cost = micros(money.cost);
  if (!cost) return prefix;
  const cte = Prisma.sql`pdf_spent AS (
      INSERT INTO "helpdesk_counters" ("name", "value", "updated_at")
      VALUES (${kbPdfSpentCounter(money.month)}, LEAST(${cost}::bigint, ${INT_MAX})::int, now())
      ON CONFLICT ("name") DO UPDATE
        SET "value" = LEAST("helpdesk_counters"."value"::bigint + EXCLUDED."value", ${INT_MAX})::int, "updated_at" = now()
      RETURNING 1
    )`;
  return prefix.sql.trim() === '' ? Prisma.sql`WITH ${cte}` : Prisma.sql`${prefix}, ${cte}`;
}

/**
 * The caller's write behind the money's settle AND the month's PDF counter (one statement), or
 * alone when there is no money. A statement the database refused before committing settled
 * nothing: `settleWith` then settles the month alone, and the counter is moved alone here.
 */
async function withMoney<T>(db: PrismaClient, money: Money | null, write: (settle: Prisma.Sql) => Promise<T>): Promise<T> {
  if (!money) return write(Prisma.empty);
  try {
    return await settleWith(db, money.cost, money.hold, money.month, settle => write(pdfSpentCte(settle, money)));
  } catch (error) {
    const rejectedBeforeCommit = error instanceof Prisma.PrismaClientKnownRequestError && /^P20\d\d$/.test(error.code);
    if (rejectedBeforeCommit && micros(money.cost) > 0) {
      await db.$executeRaw`${pdfSpentCte(Prisma.empty, money)} SELECT 1`.catch(() => undefined);
    }
    throw error;
  }
}

async function auditFile(db: PrismaClient, source: Source, action: 'kb_file_failed' | 'kb_file_drafted', drafts?: number): Promise<void> {
  // Never the file's name: its kind (and the draft count).
  await audit(db, {
    actorUserId: source.createdBy,
    action,
    target: ['kb_source', source.id],
    meta: drafts === undefined ? {kind: source.kind} : {kind: source.kind, drafts},
  });
}

/**
 * The file fails with words (conditionally: only this round, only while queued/extracting), with
 * the call's money settled in the same statement. True when it moved.
 */
async function failSource(db: PrismaClient, source: Source, words: string, money: Money | null = null): Promise<boolean> {
  const spent = micros(money?.cost ?? 0);
  const error = words.slice(0, ERROR_CHARS);
  const moved = await withMoney(
    db,
    money,
    settle => db.$executeRaw`
      ${settle}
      UPDATE "kb_sources"
      SET "state" = 'failed', "error" = ${error}, "text" = '', "spent_micros" = "spent_micros" + ${spent}::int, "updated_at" = now()
      WHERE "id" = ${source.id} AND "round" = ${source.round} AND "state" IN ('queued', 'extracting')`
  );
  if (moved) await auditFile(db, source, 'kb_file_failed');
  else if (money) await chargeRow(db, source, money.cost);
  return moved > 0;
}

/**
 * A call's cost on the file's own row when the write that carried it did not match (cancelled or
 * moved on meanwhile): the month was settled in that statement (a CTE runs either way), so only
 * the row's `spent_micros` is added, and the file's cost stays equal to what it really spent.
 */
async function chargeRow(db: PrismaClient, source: Source, cost: number): Promise<void> {
  const spent = micros(cost);
  if (!spent) return;
  await db.$executeRaw`
    UPDATE "kb_sources" SET "spent_micros" = "spent_micros" + ${spent}::int
    WHERE "id" = ${source.id} AND "round" = ${source.round}`;
}

/** Only the money (and the file's spend), when nothing else is written. */
async function settleSpend(db: PrismaClient, source: Source, money: Money): Promise<void> {
  await withMoney(
    db,
    money,
    settle => db.$executeRaw`
      ${settle}
      UPDATE "kb_sources" SET "spent_micros" = "spent_micros" + ${micros(money.cost)}::int
      WHERE "id" = ${source.id} AND "round" = ${source.round}`
  );
}

/** A foreign key violation (23503), however the driver adapter reports it. */
function isForeignKeyError(error: unknown): boolean {
  const e = error as {code?: unknown; meta?: {code?: unknown; driverAdapterError?: {cause?: {kind?: unknown; originalCode?: unknown}}}} | null;
  if (e?.code === 'P2003' || e?.code === '23503') return true;
  const cause = e?.meta?.driverAdapterError?.cause;
  return e?.meta?.code === '23503' || cause?.kind === 'ForeignKeyConstraintViolation' || cause?.originalCode === '23503';
}

/** A unique violation (two finalizes racing on a slug). */
function isUniqueError(error: unknown): boolean {
  const e = error as {code?: unknown; meta?: {code?: unknown; driverAdapterError?: {cause?: {kind?: unknown; originalCode?: unknown}}}} | null;
  if (e?.code === 'P2002' || e?.code === '23505') return true;
  const cause = e?.meta?.driverAdapterError?.cause;
  return e?.meta?.code === '23505' || cause?.kind === 'UniqueConstraintViolation' || cause?.originalCode === '23505';
}

/**
 * The Markdown → ≤ 30 DRAFT articles and the row `drafted`, in ONE transaction (the move is
 * conditional on `extracting` + this round: a duplicate finalize rolls its drafts back). Drafts
 * have no chunks and don't count in their category: nothing public changes.
 */
async function finalize(db: PrismaClient, source: Source, markdown: string, notes: string[], extraSpent = 0): Promise<void> {
  const fresh = await db.kbSource.findUnique({where: {id: source.id}, select: {categoryId: true, name: true, state: true, round: true}});
  if (!fresh || fresh.state !== 'extracting' || fresh.round !== source.round) {
    if (fresh) await chargeRow(db, source, extraSpent);
    return;
  }
  if (fresh.categoryId === null) {
    await failSource(db, source, KB_EXTRACT_WORDS.categoryGone);
    await chargeRow(db, source, extraSpent);
    return;
  }
  const {drafts, dropped} = splitIntoDrafts(markdown, fresh.name);
  if (!drafts.length) {
    await failSource(db, source, KB_EXTRACT_WORDS.noText);
    await chargeRow(db, source, extraSpent);
    return;
  }
  if (dropped > 0) notes.push(KB_EXTRACT_WORDS.dropped(drafts.length, dropped));
  const note = notes.join(' ').slice(0, ERROR_CHARS);

  const max = KB_LIMITS.articleSlug;
  const bases = drafts.map(draft => slugify(draft.title, max) || 'article');
  const used = await articleSlugsLike(db, [...new Set(bases)]);
  const now = new Date();
  const categoryId = fresh.categoryId;
  const rows = drafts.map((draft, i) => ({
    categoryId,
    title: draft.title,
    slug: freeSlug(bases[i]!, used, max),
    body: draft.body,
    excerpt: excerptOf(draft.body),
    status: 'draft',
    createdBy: source.createdBy,
    updatedBy: source.createdBy,
    lastReviewedAt: now,
    sourceId: source.id,
  }));

  try {
    await db.$transaction(async tx => {
      await tx.kbArticle.createMany({data: rows});
      const moved = await tx.kbSource.updateMany({
        where: {id: source.id, round: source.round, state: 'extracting'},
        data: {
          state: 'drafted',
          draftsCreated: rows.length,
          text: '',
          error: note,
          completedAt: now,
          ...(extraSpent > 0 ? {spentMicros: {increment: micros(extraSpent)}} : {}),
        },
      });
      if (moved.count !== 1) throw new Stale();
    });
  } catch (error) {
    if (error instanceof Stale) {
      await chargeRow(db, source, extraSpent);
      return;
    }
    // The category went meanwhile.
    if (isForeignKeyError(error)) {
      await failSource(db, source, KB_EXTRACT_WORDS.categoryGone);
      await chargeRow(db, source, extraSpent);
      return;
    }
    // A slug taken meanwhile: the next try picks free ones.
    if (isUniqueError(error)) {
      // The call that ended the reading was paid: keep it on the row before trying again.
      await chargeRow(db, source, extraSpent);
      throw new RetryLater(KB_EXTRACT_WORDS.error);
    }
    throw error;
  }
  await auditFile(db, source, 'kb_file_drafted', rows.length);
}

/* ------------------------------------ job ------------------------------------ */

/**
 * The `kb-extract` job for one step of one file. `siteUrl` = `config.siteUrl` (where the
 * platform answers: the file link and the next step's send); null → the file can't be read.
 * Returns when done (the file drafted, failed, or its next step sent); throws to be tried again;
 * `DontRetry` for bad data.
 */
export async function runKbExtractJob(db: PrismaClient, data: KbExtractData, job: ExtractJob, siteUrl: string | null): Promise<void> {
  const started = Date.now();
  if (!isInt(data?.sourceId, 1) || !isInt(data?.round, 0) || !isInt(data?.step, 0)) throw new DontRetry('Bad file job.');

  const state: {source: Source | null; healing: boolean} = {source: null, healing: false};
  try {
    await extract(db, data, job, siteUrl, started, state);
  } catch (error) {
    if (error instanceof DontRetry) throw error;
    // A send refused for a moment: the row is fine where it is (its step is saved). The retry heals
    // it (the stale-delivery path re-sends), and the sweep catches what the retries can't.
    if (error instanceof SendLater) throw new Error('The next step of a knowledge file could not be sent yet. It will be tried again.');
    const words = error instanceof RetryLater ? error.message : KB_EXTRACT_WORDS.error;
    if (isLastTry(job) && state.source && !state.healing) await failSource(db, state.source, words).catch(() => undefined);
    if (!(error instanceof RetryLater)) {
      const code = (error as {code?: unknown} | null)?.code;
      console.warn(`[kb-files] step failed${typeof code === 'string' ? ` (${code})` : ''}`);
    }
    // Words for the owner's Jobs tab: never the database's own message.
    throw new Error(words);
  }
}

async function extract(
  db: PrismaClient,
  data: KbExtractData,
  job: ExtractJob,
  siteUrl: string | null,
  started: number,
  state: {source: Source | null; healing: boolean}
): Promise<void> {
  const remaining = () => KB_FILE_LIMITS.callBudgetMs - (Date.now() - started);

  // 1. One round trip: the row (not its text), the cap and this month's PDF spend (money: the
  // DATABASE, never the cache). The month is taken once: the holds and settles land on it.
  const month = monthKey();
  const [row, money] = await Promise.all([
    db.kbSource.findUnique({
      where: {id: data.sourceId},
      select: {
        id: true,
        state: true,
        kind: true,
        fileId: true,
        round: true,
        step: true,
        pagesPerCall: true,
        pagesTotal: true,
        inputTokens: true,
        spentMicros: true,
        createdBy: true,
      },
    }),
    db.$queryRaw<{capCents: number | null; pdfSpent: bigint | number}[]>`
      SELECT (SELECT "monthly_cap_cents" FROM "helpdesk_settings" WHERE "id" = 1) AS "capCents",
        COALESCE((SELECT "value" FROM "helpdesk_counters" WHERE "name" = ${kbPdfSpentCounter(month)}), 0)::bigint AS "pdfSpent"`,
  ]);

  // 2. Gone, finished, cancelled, or another round: nothing to do.
  if (!row || (row.state !== 'queued' && row.state !== 'extracting') || row.round !== data.round) return;
  const source: Source = {id: row.id, round: row.round, kind: row.kind as KbFileKind, createdBy: row.createdBy};
  if (row.step !== data.step) {
    // An old delivery, or the retry of a run whose next send failed: make sure the row's current
    // step is on its way (the key it was chained under: a no-op if it is).
    if (row.step > data.step && siteUrl) {
      state.healing = true;
      await sendStep(siteUrl, row.id, row.round, row.step, row.pagesPerCall);
    }
    return;
  }
  state.source = source;

  if (!siteUrl) {
    console.warn("[kb-files] the site's address is not set; the file can't be read");
    await failSource(db, source, KB_EXTRACT_WORDS.couldNotRead);
    return;
  }

  // 3. A PDF needs the key and a cap before anything is read.
  const kind = source.kind;
  const key = kind === 'pdf' ? config.ownerSecret(AI_SECRET_NAMES.anthropic) : null;
  const capMicros = capMicrosOf(money[0]?.capCents ?? 2000);
  if (kind === 'pdf' && (!key || capMicros <= 0)) {
    await failSource(db, source, KB_EXTRACT_WORDS.pdfNeedsAi);
    return;
  }
  // PDF reading's share of the month: used up → no read, no call.
  const pdfShare = Math.floor(capMicros * KB_FILE_LIMITS.pdfCapShare);
  const pdfSpent = Number(money[0]?.pdfSpent ?? 0);
  if (kind === 'pdf' && pdfSpent >= pdfShare) {
    await failSource(db, source, KB_EXTRACT_WORDS.pdfShare);
    return;
  }

  // 4. Text and Word files: started, read, converted, drafted, in this run.
  if (kind !== 'pdf' && row.state === 'queued') {
    const moved = await db.$executeRaw`
      UPDATE "kb_sources" SET "state" = 'extracting', "updated_at" = now()
      WHERE "id" = ${row.id} AND "round" = ${row.round} AND "step" = ${row.step} AND "state" = 'queued'`;
    if (!moved) return;
  }

  // 5. The bytes (any failure: "couldn't read", no retry).
  let bytes: Uint8Array | null = await readStoredFile(
    siteUrl,
    row.fileId,
    KB_FILE_TYPES[kind].maxBytes,
    Math.max(1, Math.min(KB_FILE_LIMITS.fetchMs, remaining()))
  ).then(read => (read.ok ? read.bytes : null));
  if (!bytes) {
    await failSource(db, source, KB_EXTRACT_WORDS.couldNotRead);
    return;
  }

  if (kind !== 'pdf') {
    let markdown: string;
    const notes: string[] = [];
    try {
      if (kind === 'docx') {
        const out = await docxToMarkdown(bytes, {
          docxMaxUncompressed: KB_FILE_LIMITS.docxMaxUncompressed,
          docxMaxRatio: KB_FILE_LIMITS.docxMaxRatio,
          maxTextChars: KB_FILE_LIMITS.maxTextChars,
        });
        markdown = out.markdown;
        notes.push(...out.warnings);
      } else {
        markdown = decodeText(bytes);
      }
    } catch (error) {
      if (error instanceof FileReadError) {
        await failSource(db, source, error.message);
        return;
      }
      throw error;
    }
    if (markdown.length > KB_FILE_LIMITS.maxTextChars) {
      markdown = markdown.slice(0, KB_FILE_LIMITS.maxTextChars);
      notes.push(KB_EXTRACT_WORDS.cutText);
    }
    await finalize(db, source, markdown, notes);
    return;
  }

  // The base64 is all a PDF run needs: the raw bytes go now (memory: one copy, not two).
  const base64 = toBase64(bytes);
  bytes = null;
  await readPdf(db, {row, source, key: key!, capMicros, pdfShare, pdfSpent, month, base64, siteUrl, job, remaining, started});
}

/* ------------------------------------ PDF ------------------------------------ */

interface PdfRun {
  row: {id: number; round: number; step: number; state: string; pagesPerCall: number; pagesTotal: number | null; inputTokens: number | null; spentMicros: number};
  source: Source;
  key: string;
  capMicros: number;
  /** PDF reading's share of this month's cap, and what PDFs spent this month before this run. */
  pdfShare: number;
  pdfSpent: number;
  month: string;
  base64: string;
  siteUrl: string;
  job: ExtractJob;
  remaining: () => number;
  /** When this run started (ms): a zero-call run's chain key carries it. */
  started: number;
}

async function finalizePdf(db: PrismaClient, source: Source, notes: string[], extraSpent = 0): Promise<void> {
  const stored = await db.kbSource.findUnique({where: {id: source.id}, select: {text: true}});
  if (!stored) return;
  await finalize(db, source, stored.text.trim(), notes, extraSpent);
}

async function readPdf(db: PrismaClient, run: PdfRun): Promise<void> {
  const {row, source, key, capMicros, siteUrl, job, remaining, base64, month} = run;

  // Step 0: count the request (free), refuse a PDF over the cap before any billed call, and
  // store the count in the statement that starts the file.
  let inputTokens = row.inputTokens;
  if (inputTokens === null) {
    const {from, to} = pageRange(row.step, row.pagesPerCall);
    const counted = await countTokens(key, {
      model: EXTRACT_MODEL,
      system: PDF_SYSTEM,
      messages: pdfMessages(base64, from, to),
      thinking: DISABLED,
      timeoutMs: Math.max(1, Math.min(COUNT_MS, remaining())),
    });
    if (!counted.ok) throw new RetryLater(KB_EXTRACT_WORDS.noAnswer);
    inputTokens = storedInputTokens(counted.inputTokens);
    const tooLong = tooLongMessage(inputTokens);
    if (tooLong) {
      await failSource(db, source, tooLong);
      return;
    }
    const moved = await db.$executeRaw`
      UPDATE "kb_sources" SET "input_tokens" = ${inputTokens}::int, "state" = 'extracting', "updated_at" = now()
      WHERE "id" = ${row.id} AND "round" = ${row.round} AND "step" = ${row.step}
        AND "state" IN ('queued', 'extracting') AND "input_tokens" IS NULL`;
    if (!moved) return;
  }

  const hold = pdfHold(inputTokens);
  const s = {step: row.step, perCall: row.pagesPerCall, total: row.pagesTotal, spent: row.spentMicros};
  let calls = 0;

  for (;;) {
    const {from, to} = pageRange(s.step, s.perCall);
    if (from > MAX_PAGES_READ) {
      await finalizePdf(db, source, [KB_EXTRACT_WORDS.longPdf(from - 1)]);
      return;
    }

    // Time and calls for this run (a 10 s tail kept free): else the step goes on as the next job,
    // under a key that differs from this run's (the step moved on, or the pages per call halved).
    const left = remaining() - TAIL_MS;
    if (calls >= CALLS_PER_RUN || left < KB_FILE_LIMITS.minCallMs) {
      // No call this run: nothing moved, so this run's own key would come back. A run-unique suffix.
      await sendStep(siteUrl, row.id, row.round, s.step, s.perCall, calls === 0 ? {keySuffix: `-t${run.started}`} : {});
      return;
    }

    // The file's own budget, PDF reading's share of the month, then the window + the monthly
    // reserve in ONE statement.
    if (s.spent + hold > KB_FILE_LIMITS.fileBudgetMicros) {
      await failSource(db, source, KB_EXTRACT_WORDS.budget);
      return;
    }
    if (run.pdfSpent + (s.spent - row.spentMicros) + hold > run.pdfShare) {
      await failSource(db, source, KB_EXTRACT_WORDS.pdfShare);
      return;
    }
    const taken = await takeWindowAndReserve(db, {bucket: AI_EXTRACT_BUCKET, perMinute: AI_EXTRACT_PER_MINUTE, capMicros, holdMicros: hold, month});
    if (taken === 'cap') {
      await failSource(db, source, KB_EXTRACT_WORDS.cap);
      return;
    }
    if (taken === 'busy') {
      if (job.local) {
        // Locally a send runs at once, in this process: it would only find the window full again.
        await failSource(db, source, KB_EXTRACT_WORDS.busyLocal);
        return;
      }
      const minute = Math.floor(Date.now() / 60_000);
      await sendStep(siteUrl, row.id, row.round, s.step, s.perCall, {delay: 60, keySuffix: `-w${minute}`});
      return;
    }

    // From here on the hold is ALWAYS settled.
    calls++;
    const result: ProviderResult = await callAnthropic(key, {
      model: EXTRACT_MODEL,
      serverFallback: false,
      thinking: DISABLED,
      system: PDF_SYSTEM,
      schema: PDF_SCHEMA,
      maxTokens: PDF_MAX_TOKENS,
      timeoutMs: Math.min(KB_FILE_LIMITS.callMaxMs, left),
      messages: pdfMessages(base64, from, to),
    }).catch((): ProviderResult => ({ok: false, reason: 'network'}));
    const money: Money = {cost: costOf(result, hold), hold, month};

    if (!result.ok && (result.reason === 'http' || result.reason === 'network')) {
      await settleSpend(db, source, money);
      throw new RetryLater(KB_EXTRACT_WORDS.noAnswer);
    }
    if (result.ok && result.refused) {
      // Claude Haiku 5.5 has no fallback: final.
      await failSource(db, source, KB_EXTRACT_WORDS.refused, money);
      return;
    }
    const timedOut = !result.ok && result.reason === 'timeout';
    const parsed = result.ok && result.stopReason !== 'max_tokens' ? parseTranscript(result.text, from, to) : null;

    if (!parsed) {
      // Cut off, unreadable or too slow: fewer pages per call.
      if (s.perCall > 1) {
        const half = Math.max(1, Math.floor(s.perCall / 2));
        const moved = await withMoney(
          db,
          money,
          settle => db.$executeRaw`
            ${settle}
            UPDATE "kb_sources"
            SET "pages_per_call" = ${half}::int, "spent_micros" = "spent_micros" + ${micros(money.cost)}::int, "updated_at" = now()
            WHERE "id" = ${row.id} AND "round" = ${row.round} AND "step" = ${s.step} AND "state" = 'extracting'
              AND "pages_per_call" = ${s.perCall}::int`
        );
        if (!moved) {
          await chargeRow(db, source, money.cost);
          return;
        }
        s.perCall = half;
        s.spent += micros(money.cost);
        continue;
      }
      // One page, still no answer in time: final (never paid twice).
      if (timedOut) {
        await failSource(db, source, KB_EXTRACT_WORDS.timedOut, money);
        return;
      }
      // One page that can't be read: a note in its place, and on. Not even one page known yet:
      // the PDF itself can't be read.
      if (s.total === null) {
        await failSource(db, source, KB_EXTRACT_WORDS.unreadablePdf, money);
        return;
      }
      const wrote = await appendPages(db, row, s, money, `${unreadablePageNote(from)}\n\n`, from + 1, s.total);
      if (!wrote) {
        await notWritten(db, row, source, s.step, money.cost);
        return;
      }
      if (from >= s.total) {
        await finalizePdf(db, source, []);
        return;
      }
      continue;
    }

    const chunk = parsed.markdown ? `${parsed.markdown}\n\n` : '';
    const wrote = await appendPages(db, row, s, money, chunk, parsed.lastPage + 1, parsed.pageCount);
    if (!wrote) {
      await notWritten(db, row, source, s.step, money.cost);
      return;
    }
    if (parsed.lastPage >= parsed.pageCount) {
      await finalizePdf(db, source, []);
      return;
    }
  }
}

/**
 * A chunk was not written: the text is full (the row is still here at this step → drafts from what
 * was read, with a note), or the row was cancelled / moved on (only the call's cost is added).
 */
async function notWritten(db: PrismaClient, row: {id: number; round: number}, source: Source, step: number, cost: number): Promise<void> {
  const now = await db.kbSource.findUnique({where: {id: row.id}, select: {state: true, round: true, step: true}});
  if (now?.state === 'extracting' && now.round === row.round && now.step === step) {
    await finalizePdf(db, source, [KB_EXTRACT_WORDS.longPdf(Math.max(0, step - 1))], cost);
  } else {
    await chargeRow(db, source, cost);
  }
}

/**
 * Appends a chunk and moves the step, with the money settled, in ONE conditional statement.
 * False when it was not written (the row moved on, or the text would pass 200,000 characters).
 */
async function appendPages(
  db: PrismaClient,
  row: {id: number; round: number},
  s: {step: number; total: number | null; spent: number},
  money: Money,
  chunk: string,
  next: number,
  total: number
): Promise<boolean> {
  const spent = micros(money.cost);
  const moved = await withMoney(
    db,
    money,
    settle => db.$executeRaw`
      ${settle}
      UPDATE "kb_sources"
      SET "text" = "text" || ${chunk}::text, "step" = ${next}::int, "pages_total" = ${total}::int,
          "spent_micros" = "spent_micros" + ${spent}::int, "updated_at" = now()
      WHERE "id" = ${row.id} AND "round" = ${row.round} AND "step" = ${s.step} AND "state" = 'extracting'
        AND char_length("text") + char_length(${chunk}::text) <= ${KB_FILE_LIMITS.maxTextChars}`
  );
  if (!moved) return false;
  s.step = next;
  s.total = total;
  s.spent += spent;
  return true;
}

/* ----------------------------------- sweep ----------------------------------- */

/** Rows idle this long are re-sent (repairs refused sends). */
const RESEND_AFTER = '15 minutes';
/** Rows idle this long are failed; uploads never completed this long are deleted. */
const GIVE_UP_AFTER = '2 hours';
const SWEEP_BATCH = 100;

/**
 * The `kb-sources-sweep` schedule (every 15 minutes). ONE housekeeping statement — fail
 * `queued`/`extracting` rows idle for 2 hours, delete `uploading` rows older than 2 hours (≤ 100
 * each), prune old `kb-files:` / `kb-pdf-spent:` counters, and pick ≤ `maxSends` rows idle for
 * 15 minutes — then re-send those, stopping at the first refusal. The re-send's key is the step's
 * key + `-s<15-minute slot>`: never the step's own key, which the platform dedupes for 24 h after
 * it was sent (a re-send under it would do nothing when the chained job was accepted but died). A
 * duplicate delivery is harmless (every write is conditional on the step; a stale one only heals).
 */
export async function sweepKbSources(db: PrismaClient, siteUrl: string | null, o: {maxSends?: number} = {}): Promise<void> {
  const maxSends = Math.max(0, Math.min(10, Math.floor(o.maxSends ?? 3)));
  const words = KB_EXTRACT_WORDS.stopped;
  const rows = await db.$queryRaw<{id: number; round: number; step: number; perCall: number; kind: string; createdBy: number; failed: boolean}[]>`
    WITH stale AS (
      SELECT "id" FROM "kb_sources"
      WHERE "state" IN ('queued', 'extracting') AND "updated_at" < now() - ${GIVE_UP_AFTER}::interval
      ORDER BY "updated_at" LIMIT ${SWEEP_BATCH}
    ), failed AS (
      UPDATE "kb_sources" s
      SET "state" = 'failed', "error" = ${words}, "text" = '', "updated_at" = now()
      FROM stale WHERE s."id" = stale."id" AND s."state" IN ('queued', 'extracting')
      RETURNING s."id", s."round", s."step", s."pages_per_call", s."kind", s."created_by"
    ), pruned AS (
      DELETE FROM "helpdesk_counters" WHERE "name" IN (
        SELECT "name" FROM "helpdesk_counters"
        WHERE ("name" LIKE 'kb-files:%' AND "updated_at" < now() - interval '2 days')
           OR ("name" LIKE 'kb-pdf-spent:%' AND "updated_at" < now() - interval '62 days')
        LIMIT ${SWEEP_BATCH})
      RETURNING 1
    ), gone AS (
      DELETE FROM "kb_sources" WHERE "id" IN (
        SELECT "id" FROM "kb_sources"
        WHERE "state" = 'uploading' AND "updated_at" < now() - ${GIVE_UP_AFTER}::interval
        ORDER BY "updated_at" LIMIT ${SWEEP_BATCH})
      RETURNING "id"
    ), idle AS (
      SELECT "id", "round", "step", "pages_per_call", "kind", "created_by" FROM "kb_sources"
      WHERE "state" IN ('queued', 'extracting') AND "updated_at" < now() - ${RESEND_AFTER}::interval
        AND "id" NOT IN (SELECT "id" FROM stale)
      ORDER BY "updated_at" LIMIT ${maxSends}
    )
    SELECT "id", "round"::int AS "round", "step", "pages_per_call"::int AS "perCall", "kind", "created_by" AS "createdBy", true AS "failed" FROM failed
    UNION ALL
    SELECT "id", "round"::int, "step", "pages_per_call"::int, "kind", "created_by", false FROM idle`;

  const failed = rows.filter(row => row.failed);
  if (failed.length) {
    // One write for every audit row (never the file's name).
    await db.auditEvent
      .createMany({
        data: failed.map(row => ({
          actorUserId: row.createdBy,
          action: 'kb_file_failed',
          targetType: 'kb_source',
          targetId: String(row.id),
          meta: {kind: row.kind, reason: 'stopped'},
        })),
      })
      .catch(error => console.warn(`[kb-files] sweep audit not written: ${(error as {code?: unknown})?.code ?? 'error'}`));
  }

  if (!siteUrl) return;
  const slot = Math.floor(Date.now() / RESEND_SLOT_MS);
  for (const row of rows) {
    if (row.failed) continue;
    try {
      if (!(await sendStep(siteUrl, row.id, row.round, row.step, row.perCall, {keySuffix: `-s${slot}`}))) return;
    } catch {
      // The minute's job limit or the platform: the next sweep tries again.
      return;
    }
  }
}
