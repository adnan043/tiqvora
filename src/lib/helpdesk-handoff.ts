/**
 * The chat widget's memory for the "Talk to a person" hand-off (BROWSER-SAFE, pure:
 * every function takes a Storage-like object, so tests use a Map-backed fake).
 *
 * `sessionStorage`, this tab only, cleared on sign-out (Base.astro, the dashboard, through
 * `./helpdesk-storage.ts`, re-exported here):
 * - `hd:transcript`: the chat lines (role, text, the answer's help-center links).
 * - `hd:handoff`: `{step, at, key}` while a hand-off is under way. `key` is the
 *   idempotency key of POST /site-api/helpdesk/conversations, REUSED on every retry,
 *   reload and after sign-in, so one hand-off never makes two tickets. 30 minutes.
 * - `hd:ticket`: the number of the request this tab already sent.
 *
 * Storage that throws (private mode, blocked site data) never throws here: reads
 * give nothing, writes are dropped, and a hand-off still gets a key in memory.
 */
import {HD_KEYS, type StorageLike} from './helpdesk-storage';
import {TICKET_LIMITS} from './helpdesk-tickets';
import type {AskCitation, AskRole} from './helpdesk-types';

export {clearHelpdeskStorage, HD_KEYS, type StorageLike} from './helpdesk-storage';

export type Line = {role: AskRole; text: string; citations?: AskCitation[]};
export type HandoffStep = 'signin' | 'confirm';
export interface Handoff {
  step: HandoffStep;
  at: number;
  key: string;
}

export const HANDOFF_TTL_MS = 30 * 60 * 1000;
/** The server's limits for the hand-off body (data doc §5.1, `TICKET_LIMITS`). */
export const HANDOFF_LIMITS = {lines: 50, text: 4000, chars: 12000, bytes: 40000, citations: 5, title: 200, note: TICKET_LIMITS.note} as const;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ARTICLE_RE = /^\/help\/articles\/[a-z0-9-]{1,160}\/$/;

function get(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage blocked or full: kept in memory only.
  }
}

function drop(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** C0 control characters (tab and line feed too: a title is one line). */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Only links into the help center, at most 5, each with a title the server takes (one
 * line, whitespace collapsed, 1–200 characters, no control characters): what the server
 * sent or what storage holds. A link the server would refuse is dropped here, so a 422
 * on it can never trap the hand-off.
 */
export function safeCitations(list: unknown): AskCitation[] {
  if (!Array.isArray(list)) return [];
  const out: AskCitation[] = [];
  for (const c of list as unknown[]) {
    if (out.length >= HANDOFF_LIMITS.citations) break;
    const {title, url} = (c && typeof c === 'object' ? c : {}) as {title?: unknown; url?: unknown};
    if (typeof url !== 'string' || !ARTICLE_RE.test(url) || typeof title !== 'string') continue;
    if (CONTROL_RE.test(title)) continue;
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, HANDOFF_LIMITS.title).trim();
    if (clean) out.push({title: clean, url});
  }
  return out;
}

/** The saved chat: customer/assistant lines with text, newest 50, text capped. Anything else → []. */
export function restoreTranscript(storage: StorageLike | null): Line[] {
  let data: unknown;
  try {
    data = JSON.parse(get(storage, HD_KEYS.transcript) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (l): l is Line =>
        !!l && (l.role === 'customer' || l.role === 'assistant') && typeof l.text === 'string' && l.text.trim().length > 0
    )
    .slice(-HANDOFF_LIMITS.lines)
    .map(l => {
      const text = l.text.slice(0, HANDOFF_LIMITS.text);
      const citations = l.role === 'assistant' ? safeCitations(l.citations) : [];
      return citations.length ? {role: l.role, text, citations} : {role: l.role, text};
    });
}

export function saveTranscript(storage: StorageLike | null, lines: Line[]): void {
  set(storage, HD_KEYS.transcript, JSON.stringify(lines.slice(-HANDOFF_LIMITS.lines)));
}

/** 24 random bytes, base64url (32 characters): an IDEMPOTENCY_KEY. */
export function newRequestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The hand-off under way, or null. Expired (> 30 min), from the future or the wrong shape → removed. */
export function pendingHandoff(storage: StorageLike | null, now = Date.now()): Handoff | null {
  const raw = get(storage, HD_KEYS.handoff);
  if (raw === null) return null;
  let h: Partial<Handoff> | null = null;
  try {
    h = JSON.parse(raw) as Partial<Handoff> | null;
  } catch {
    // Unreadable: dropped below.
  }
  if (
    h &&
    (h.step === 'signin' || h.step === 'confirm') &&
    typeof h.at === 'number' &&
    typeof h.key === 'string' &&
    KEY_RE.test(h.key) &&
    h.at <= now &&
    now - h.at < HANDOFF_TTL_MS
  ) {
    return {step: h.step, at: h.at, key: h.key};
  }
  drop(storage, HD_KEYS.handoff);
  return null;
}

/**
 * Starts (or continues) a hand-off at `step`: the SAME key as the one under way, a new
 * one only when there is none (or `fresh`, "Start a new request"). `at` is kept, so
 * the 30 minutes run from the first click.
 */
export function beginHandoff(
  storage: StorageLike | null,
  step: HandoffStep,
  now = Date.now(),
  fresh = false,
  /** The one in memory, for storage that keeps nothing. */
  memory: Handoff | null = null
): Handoff {
  const kept = memory && now - memory.at < HANDOFF_TTL_MS && memory.at <= now ? memory : null;
  const current = fresh ? null : (pendingHandoff(storage, now) ?? kept);
  const h: Handoff = {step, at: current?.at ?? now, key: current?.key ?? newRequestKey()};
  set(storage, HD_KEYS.handoff, JSON.stringify(h));
  return h;
}

export function forgetHandoff(storage: StorageLike | null): void {
  drop(storage, HD_KEYS.handoff);
}

/** The request this tab already sent (#1042), or null. */
export function sentTicket(storage: StorageLike | null): number | null {
  const n = Number(get(storage, HD_KEYS.ticket));
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
}

/** Sent: the chat and the hand-off are done, the number is kept for "View your request". */
export function handoffSent(storage: StorageLike | null, number: number): void {
  drop(storage, HD_KEYS.transcript);
  drop(storage, HD_KEYS.handoff);
  set(storage, HD_KEYS.ticket, String(number));
}

/** A same-site PATH for `?next=` (mirrors `nextPath` / `safeNext`), else `/`. */
export function safeNextPath(value: string): string {
  if (!value || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  return value;
}

/** `/account/login/?next=…` or `/account/register/?next=…` back to `path`. */
export function accountUrl(kind: 'login' | 'register', path: string): string {
  return `/account/${kind}/?next=${encodeURIComponent(safeNextPath(path))}`;
}


/**
 * The transcript as the create route takes it: at most 50 lines, 4,000 characters a
 * line, 12,000 characters and 40,000 UTF-8 bytes in all, NEWEST kept; roles and text
 * and help-center links only (never ids or tokens).
 */
export function transcriptForHandoff(lines: Line[]): Line[] {
  const encoder = new TextEncoder();
  const bytes = (text: string) => encoder.encode(text).length;
  const out: Line[] = [];
  let chars = 0;
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < HANDOFF_LIMITS.lines; i--) {
    const l = lines[i];
    // The server refuses control characters but tab and line feed.
    const text = l.text
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .trim()
      .slice(0, HANDOFF_LIMITS.text);
    if (!text || (l.role !== 'customer' && l.role !== 'assistant')) continue;
    const citations = l.role === 'assistant' ? safeCitations(l.citations) : [];
    const line: Line = citations.length ? {role: l.role, text, citations} : {role: l.role, text};
    const b = bytes(JSON.stringify(line));
    if (chars + text.length > HANDOFF_LIMITS.chars || size + b > HANDOFF_LIMITS.bytes) break;
    chars += text.length;
    size += b;
    out.unshift(line);
  }
  return out;
}

/** The body of POST /site-api/helpdesk/conversations (CreateConversationInput). */
export function handoffBody(key: string, lines: Line[], note: string, page: string) {
  const trimmed = note.trim().slice(0, HANDOFF_LIMITS.note);
  return {
    key,
    transcript: transcriptForHandoff(lines),
    ...(trimmed ? {note: trimmed} : {}),
    page: safeNextPath(page.split('?')[0]).slice(0, 300),
  };
}

/**
 * What an answer means for the hand-off:
 * - `sent`: 2xx with a ticket number → `handoffSent`.
 * - `signin`: 401 → back to the sign-in step, key kept.
 * - `retry`: network, 5xx, 422, 429 → error in the box, key and transcript kept (the same key on retry).
 * - `stop`: 403 (the email address isn't confirmed yet) and other 4xx → error in the box, key dropped
 *   (nothing was made), transcript kept.
 */
export type HandoffOutcome = 'sent' | 'signin' | 'retry' | 'stop';
export function handoffOutcome(status: number | null): HandoffOutcome {
  if (status === null || status >= 500 || status === 422 || status === 429) return 'retry';
  if (status >= 200 && status < 300) return 'sent';
  if (status === 401) return 'signin';
  return 'stop';
}

/** The ticket number from a CreateConversationResult, or null. */
export function ticketNumberOf(data: unknown): number | null {
  const n = (data as {ticket?: {number?: unknown}} | null)?.ticket?.number;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}
