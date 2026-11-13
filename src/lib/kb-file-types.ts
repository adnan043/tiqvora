/**
 * Knowledge files (Phase 5): files an editor uploads to become DRAFT articles. The JSON shapes of
 * `/site-api/kb/files` (src/server/routes/kb-files.ts) and the rules the Files screen checks
 * before any request (src/portal/screens/files.tsx). Browser-safe: types and constants only.
 *
 * The file's bytes never pass through the Site API: the browser PUTs them straight to storage
 * (`putFile`), and the `kb-extract` job reads them back through a short private link
 * (src/server/kb/sources/). Lists are keyset-paged: `next` is the cursor (`?before=<next>`).
 */
import type {UploadGrant} from '../platform/files-browser';
import {EXTRACT_MODEL} from './ai-models';

export type KbFileKind = 'pdf' | 'docx' | 'txt' | 'md';
export type KbFileState = 'uploading' | 'queued' | 'extracting' | 'drafted' | 'failed' | 'cancelled';

export const KB_FILE_KINDS: readonly KbFileKind[] = ['pdf', 'docx', 'txt', 'md'];
export const KB_FILE_STATES: readonly KbFileState[] = ['uploading', 'queued', 'extracting', 'drafted', 'failed', 'cancelled'];
/** Still being read: the screen polls while any row is in one of these. */
export const KB_FILE_ACTIVE_STATES: readonly KbFileState[] = ['queued', 'extracting'];

const MB = 1024 * 1024;

export const KB_FILE_LIMITS = {
  pdfBytes: 8 * MB,
  docxBytes: 8 * MB,
  textBytes: 1 * MB,
  nameChars: 200,
  /** Drafts made from one file; the rest is left out with a note. */
  maxDrafts: 30,
  /** Markdown read from one file, in characters. */
  maxTextChars: 200_000,
  /** A PDF's whole request (system + document + instruction) stays under this many input tokens. */
  pdfMaxInputTokens: 90_000,
  pagesPerCall: 4,
  /** AI calls per file per round (≈ 80 pages at 4 a call). */
  pdfMaxCalls: 20,
  /** Uploads + retries per editor per UTC day. */
  uploadsPerDay: 20,
  /** Files being read at once, site-wide. */
  activeAtOnce: 5,
  /** AI money one file may use over all its rounds: $0.50. */
  fileBudgetMicros: 500_000,
  /**
   * The part of the owner's monthly AI cap PDF reading may use (all files together, this month):
   * the rest stays for the customer assistant.
   */
  pdfCapShare: 0.25,
  docxMaxUncompressed: 10 * MB,
  docxMaxRatio: 100,
  /** The fixed model that reads PDFs (not a setting). */
  extractModel: EXTRACT_MODEL,
  /** One job run's time for its own work (the platform gives 60 s). */
  callBudgetMs: 55_000,
  /** One AI call at most. */
  callMaxMs: 40_000,
  /** A call starts only while this much of the run's budget is left. */
  minCallMs: 15_000,
  /** Reading the stored file at most. */
  fetchMs: 15_000,
} as const;

/**
 * Extension → kind → the MIME sent to storage. `.md` / `.markdown` go as `text/plain` (storage has
 * no Markdown type). The content type is ALWAYS derived from the kind on the server.
 */
export const KB_FILE_TYPES: Record<KbFileKind, {extensions: readonly string[]; contentType: string; maxBytes: number; label: string}> = {
  pdf: {extensions: ['.pdf'], contentType: 'application/pdf', maxBytes: KB_FILE_LIMITS.pdfBytes, label: 'PDF'},
  docx: {
    extensions: ['.docx'],
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    maxBytes: KB_FILE_LIMITS.docxBytes,
    label: 'Word',
  },
  txt: {extensions: ['.txt'], contentType: 'text/plain', maxBytes: KB_FILE_LIMITS.textBytes, label: 'Text'},
  md: {extensions: ['.md', '.markdown'], contentType: 'text/plain', maxBytes: KB_FILE_LIMITS.textBytes, label: 'Markdown'},
};

/** For `<input type="file" accept>`. */
export const KB_FILE_ACCEPT = KB_FILE_KINDS.flatMap(kind => KB_FILE_TYPES[kind].extensions).join(',');

/** The file's kind by its extension (lower-cased), or null. Browser and server. */
export function kbFileKindOf(name: string): KbFileKind | null {
  if (typeof name !== 'string') return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return KB_FILE_KINDS.find(kind => KB_FILE_TYPES[kind].extensions.includes(ext)) ?? null;
}

/* ------------------------------ messages (shared) ------------------------------ */

/** Format characters (bidi controls U+202A–202E / U+2066–2069, zero-width U+200B–200F, U+2060, U+FEFF, …). */
export const INVISIBLE_RE = /\p{Cf}/u;
/** Control characters (C0, DEL, C1) and the line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** A UTF-16 surrogate without its pair. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_SAFE_SIZE = 2147483647;

export const KB_FILE_MESSAGES = {
  kind: 'Pick a PDF, Word (.docx), text (.txt) or Markdown (.md) file.',
  name: `Rename the file to ${KB_FILE_LIMITS.nameChars} characters or fewer and pick it again.`,
  category: 'Pick a category for the drafts.',
  /** Hidden, control or broken characters in the name (they can disguise its real extension). */
  nameChars: 'The file name has hidden or broken characters. Rename the file and try again.',
  /** Only an extension (".txt"). */
  nameBase: 'Give the file a name before its extension, like guide.pdf.',
  empty: 'This file is empty.',
  /** Not a whole number of bytes (or absurdly large). */
  size: "Enter the file's size in bytes.",
  pdfNeedsAi: "Reading PDFs needs the assistant's AI key. Word, text and Markdown files work without it.",
  /** The one failure the screen labels "Couldn't read" (a storage or fetch failure). */
  couldNotRead: "We couldn't read this file from storage. Try again later, or upload it again.",
} as const;

/** How a message names each kind ("A PDF…", "A Word file…", "A text file…", "A Markdown file…"). */
const KIND_IN_WORDS: Record<KbFileKind, string> = {pdf: 'PDF', docx: 'Word file', txt: 'text file', md: 'Markdown file'};

/** "A PDF can be at most 8 MB." */
export function kbFileTooBigMessage(kind: KbFileKind): string {
  return `A ${KIND_IN_WORDS[kind]} can be at most ${Math.round(KB_FILE_TYPES[kind].maxBytes / MB)} MB.`;
}

/**
 * The name's rules (the server trims it first): null when fine, else words. 1–200 characters; no
 * control, format (bidi, zero-width) or lone-surrogate characters; a known extension with a name
 * before it.
 */
export function kbFileNameProblem(name: string): string | null {
  if (!name || name.length > KB_FILE_LIMITS.nameChars) return KB_FILE_MESSAGES.name;
  if (CONTROL_RE.test(name) || INVISIBLE_RE.test(name) || LONE_SURROGATE_RE.test(name)) return KB_FILE_MESSAGES.nameChars;
  const kind = kbFileKindOf(name);
  if (!kind) return KB_FILE_MESSAGES.kind;
  if (!name.slice(0, name.lastIndexOf('.')).trim()) return KB_FILE_MESSAGES.nameBase;
  return null;
}

/** The size's rules for a kind: null when fine, else words. */
export function kbFileSizeProblem(kind: KbFileKind, size: unknown): string | null {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_SAFE_SIZE) return KB_FILE_MESSAGES.size;
  if (size === 0) return KB_FILE_MESSAGES.empty;
  if (size > KB_FILE_TYPES[kind].maxBytes) return kbFileTooBigMessage(kind);
  return null;
}

/** The client-side check, the same rules as `POST /site-api/kb/files`: null when fine, else words. */
export function kbFileProblem(name: string, size: number): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const nameProblem = kbFileNameProblem(trimmed);
  if (nameProblem) return nameProblem;
  return kbFileSizeProblem(kbFileKindOf(trimmed)!, size);
}

/* ----------------------------------- shapes ----------------------------------- */

export interface KbFileRow {
  id: number;
  name: string;
  kind: KbFileKind;
  /** Bytes. */
  size: number;
  state: KbFileState;
  /** PDF pages read so far (0 for other kinds). */
  pagesDone: number;
  pagesTotal: number | null;
  draftsCreated: number;
  /** '' or words for people (why it failed, or a note on a partial read). */
  error: string;
  /** True when a `failed` file could not be read from storage: the screen says "Couldn't read". */
  couldNotRead: boolean;
  /** AI money spent reading it (PDFs, over all its rounds), in whole cents, rounded up. */
  costCents: number;
  category: {id: number; name: string} | null;
  /** A name only ("Former team member" when the account is gone). */
  uploadedBy: string;
  createdAt: string;
  completedAt: string | null;
  /** The row's last change (ISO): a `queued`/`extracting` row unchanged for ~15 min can stop being polled. */
  updatedAt: string;
}

export interface KbFilesPage {
  items: KbFileRow[];
  /** The next page's `?before=` (send it as `String(next)`), null on the last page. */
  next: number | null;
}

export interface KbFileDraft {
  id: number;
  title: string;
  status: 'draft' | 'published' | 'archived';
}

export interface KbFileDetail extends KbFileRow {
  /** The articles made from this file (≤ 30, oldest first). */
  drafts: KbFileDraft[];
}

export type KbStorageState = 'ok' | 'needs_pack' | 'off' | 'unavailable' | 'unreachable';

export interface KbFilesUsage {
  storage: KbStorageState;
  usedBytes: number | null;
  /** null = no limit (or unknown when `storage` is not 'ok'). */
  limitBytes: number | null;
  /** The largest file this screen takes (8 MB). */
  maxFileBytes: number;
  /** ANTHROPIC_API_KEY present and the monthly cap > 0: PDFs can be read. */
  pdfReady: boolean;
}

/** `POST /site-api/kb/files` body. The content type is never sent: the server derives it. */
export interface KbFileUploadInput {
  name: string;
  size: number;
  categoryId: number;
}

/** `POST /site-api/kb/files` → 201. Give `upload` to `putFile`, then POST `/:id/complete`. */
export interface KbFileUploadStart {
  file: {id: number};
  upload: UploadGrant['upload'];
}

/** `POST /:id/retry` body (optional new category; null or absent = keep its category). */
export interface KbFileRetryInput {
  categoryId?: number | null;
}

/**
 * `DELETE /:id` → 200. The row is always gone (its drafts stay). `fileDeleted` false: the stored
 * copy could not be removed now and is left in storage (it still uses space); `message` says so in
 * plain words for the screen to show. `message` is null when `fileDeleted` is true.
 */
export interface KbFileDeleted {
  ok: true;
  fileDeleted: boolean;
  message: string | null;
}

/** `KbFileDeleted.message` when the stored copy stayed. */
export const KB_FILE_NOT_REMOVED_MESSAGE =
  "The file was removed from this list, but its stored copy couldn't be deleted right now. It still uses storage space.";

/** Problem codes the Files screen branches on (`ApiError.code`). 422 `fields` carries `fields: {name|size|categoryId}`. */
export type KbFileProblemCode =
  | 'fields'
  | 'pdf_needs_ai'
  | 'rate_limited'
  | 'storage_unavailable'
  | 'storage'
  | 'already_started'
  | 'already_finished'
  | 'not_started'
  | 'not_found';
