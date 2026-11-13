import {SiteKeyMissing} from '../../../platform/api';
import {config} from '../../../platform/config';
import {fileUrl} from '../../../platform/files';

/**
 * Reads a PRIVATE stored file's bytes from a background job (p5 owner decision 3).
 *
 * The only documented way: ask the platform for a short-lived link (`fileUrl`, with the Site Key,
 * 5 minutes) and `fetch` it with a timeout and a byte cap. The link is a signed storage URL; it is
 * never saved and never logged (docs/agent/files.md). This site's own hostname is never fetched
 * (docs/agent/site-api.md): a link on it is refused, and at most ONE redirect to another https
 * host is followed.
 *
 * Never throws: every failure is a reason code, which the pipeline turns into "couldn't read"
 * (state `failed`), never a crash or a retry loop. Only the code is logged.
 *
 * Live checks still to do on a deployed site: README › "Knowledge files: live checks".
 */

export type ReadFailure =
  | 'no_key'
  | 'not_ready'
  | 'storage_off'
  | 'needs_pack'
  | 'link'
  | 'own_host'
  | 'http'
  | 'timeout'
  | 'too_big'
  | 'network';

export type ReadResult = {ok: true; bytes: Uint8Array} | {ok: false; reason: ReadFailure};

type ReaderForTests = (fileId: string) => Promise<Uint8Array | null>;
let readerForTests: ReaderForTests | null = null;

/** TESTS ONLY: replace the whole read (null bytes = an `http` failure); null restores the real one. */
export function setStoredFileReaderForTests(fn: ReaderForTests | null): void {
  readerForTests = fn;
}

/** Link expiry asked of the platform, in seconds (the platform's minimum is 60). */
const LINK_SECONDS = 300;

const fail = (reason: ReadFailure): ReadResult => {
  // A code only: never the link, the file id or the bytes.
  console.warn(`[kb-files] read failed: ${reason}`);
  return {ok: false, reason};
};

/** Hostnames that are this site (never fetched from server code). */
function ownHosts(siteUrl: string): Set<string> {
  const hosts = new Set<string>();
  for (const url of [siteUrl, config.siteUrl]) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // Not a URL: nothing to add.
    }
  }
  return hosts;
}

/** The link as a URL when it is https, without credentials and not on this site; else why not. */
function safeLink(raw: string, base: string | undefined, own: Set<string>): URL | 'link' | 'own_host' {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return 'link';
  }
  if (url.protocol !== 'https:' || url.username || url.password) return 'link';
  if (own.has(url.hostname.toLowerCase())) return 'own_host';
  return url;
}

const LATE = Symbol('late');

/** `promise`, or LATE once `ms` have passed (the promise is left to settle on its own). */
function before<T>(promise: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>(resolve => {
    timer = setTimeout(() => resolve(LATE), Math.max(1, ms));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const isTimeout = (error: unknown) => {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
};

/** The body, at most `maxBytes` (a running cap: never more than maxBytes + one chunk in memory). */
async function readCapped(res: Response, maxBytes: number): Promise<ReadResult> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return fail('too_big');
  }
  if (!res.body) return {ok: true, bytes: new Uint8Array(0)};
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return fail('too_big');
    }
    parts.push(value);
  }
  if (parts.length === 1) return {ok: true, bytes: parts[0]!};
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return {ok: true, bytes};
}

/**
 * The stored file `fileId`'s bytes (≤ `maxBytes`), within `timeoutMs` for the WHOLE read: the link
 * request and the download share one deadline (the caller's time budget relies on it).
 * `siteUrl` = `config.siteUrl` (where the platform answers).
 */
export async function readStoredFile(siteUrl: string, fileId: string, maxBytes: number, timeoutMs: number): Promise<ReadResult> {
  if (readerForTests) {
    try {
      const bytes = await readerForTests(fileId);
      if (!bytes) return fail('http');
      return bytes.byteLength > maxBytes ? fail('too_big') : {ok: true, bytes};
    } catch {
      return fail('network');
    }
  }

  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));

  // 1. The short link (within the same deadline).
  let link: string;
  try {
    const res = await before(fileUrl(siteUrl, fileId, {expiresIn: LINK_SECONDS}), deadline - Date.now());
    if (res === LATE) return fail('timeout');
    if (!res.ok) {
      if (res.code === 'E_FILE_NOT_READY') return fail('not_ready');
      if (res.code === 'E_STORAGE_OFF') return fail('storage_off');
      if (res.code === 'E_STORAGE_NEEDS_PACK') return fail('needs_pack');
      return fail('link');
    }
    link = res.data.url;
  } catch (error) {
    return fail(error instanceof SiteKeyMissing ? 'no_key' : 'link');
  }
  if (typeof link !== 'string') return fail('link');

  // 2. Never this site's own hostname; https only.
  const own = ownHosts(siteUrl);
  const first = safeLink(link, undefined, own);
  if (!(first instanceof URL)) return fail(first);

  // 3. The download (what is left of the deadline, the body included), ≤ 1 redirect.
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try {
    let res = await fetch(first, {redirect: 'manual', signal});
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return fail('http');
      const next = safeLink(location, first.href, own);
      if (!(next instanceof URL)) return fail(next);
      // A second redirect is not followed: its 3xx fails below as `http`.
      res = await fetch(next, {redirect: 'manual', signal});
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return fail('http');
    }
    return await readCapped(res, maxBytes);
  } catch (error) {
    return fail(isTimeout(error) ? 'timeout' : 'network');
  }
}
