import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  type CountTokensRequest,
  type ProviderRequest,
  type ProviderResult,
  requestBody,
  setAiProviderForTests,
  setCountTokensForTests,
} from '../../src/server/ai/provider';
import {monthKey} from '../../src/server/ai/usage';
import {KB_EXTRACT_WORDS, kbExtractKey, kbPdfSpentCounter, runKbExtractJob, sweepKbSources} from '../../src/server/kb/sources/pipeline';
import {setStoredFileReaderForTests} from '../../src/server/kb/sources/read';
import {KB_FILE_MESSAGES} from '../../src/lib/kb-file-types';
import {env} from './support/cloudflare-workers';
import {configureEnv, DATABASE_URL, db, resetDatabase, resetHelpdeskSettings, setRateWindow} from './support/harness';

/** Jobs the pipeline sends are captured, never run inline (locally `sendJob` would run them at once). */
const sent = vi.hoisted(() => [] as {list: string; data: unknown; options: Record<string, unknown>}[]);
/**
 * The platform's side, when a test turns it on: `dedupe` drops a send whose key was seen (as the
 * platform does for 24 h) and keeps the others in `accepted`; `reject` refuses every send with that code.
 */
const platformJobs = vi.hoisted(() => ({
  dedupe: false,
  keys: new Set<string>(),
  accepted: [] as {data: {sourceId: number; round: number; step: number}; key: string}[],
  reject: null as string | null,
  tries: 0,
}));
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options: Record<string, unknown> = {}) => {
      platformJobs.tries++;
      if (platformJobs.reject) throw new real.JobRejected('No.', platformJobs.reject, 429);
      sent.push({list, data, options});
      const key = String(options.key ?? '');
      const deduplicated = platformJobs.dedupe && platformJobs.keys.has(key);
      if (platformJobs.dedupe && !deduplicated) {
        platformJobs.keys.add(key);
        platformJobs.accepted.push({data: data as {sourceId: number; round: number; step: number}, key});
      }
      return {id: `job_t${sent.length}`, list, runAt: new Date().toISOString(), deduplicated, local: false};
    },
  };
});

/**
 * Knowledge files → draft articles (`kb-extract`, src/server/kb/sources/pipeline.ts) against a
 * real Postgres, with a fake provider, a fake count_tokens, and the stored file read either through
 * `setStoredFileReaderForTests` or through the REAL reader over a stubbed platform + storage
 * (`fetch`, wrapping the harness's): every way the read can fail ends as "couldn't read", never a
 * thrown job.
 */
const KEY = 'fake-anthropic-key-for-tests-0123456789';
const PLATFORM = 'https://platform.example.test';
const STORAGE = 'https://storage.example.test';
const FILE_ID = 'file_0123456789abcdefghijklmnop';
const UPLOADER = 4242;
const JOB = {attempt: 1, maxAttempts: 4};
const LAST = {attempt: 4, maxAttempts: 4};

vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

const utf8 = new TextEncoder();

/* ------------------------------- a tiny .docx ------------------------------- */

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A ZIP of stored (uncompressed) entries. */
function zip(entries: Record<string, string>): Uint8Array {
  const locals: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  let count = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = utf8.encode(text);
    const nameBytes = utf8.encode(name);
    const crc = crc32(data);
    const offset = locals.length;
    const common = [...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length)];
    locals.push(...u32(0x04034b50), ...common, ...u16(0), ...nameBytes, ...data);
    central.push(...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
    count++;
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(central.length), ...u32(locals.length), ...u16(0)];
  return new Uint8Array([...locals, ...central, ...end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml':
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>` +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Returns</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Send it back within 30 days.</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Shipping</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>We ship in 2 days.</w:t></w:r></w:p>' +
    '</w:body></w:document>',
});

/* ------------------------------ fake platform ------------------------------ */

type Storage = {
  /** The platform's answer to POST /files/<id>/url: a code to refuse with, or the link to hand out. */
  urlError: string | null;
  link: string;
  /** Redirects the storage host answers first (each a 302 to the next Location), then `status`. */
  redirects: string[];
  /** The storage host never answers (until the request's signal aborts). */
  hang: boolean;
  /** What the storage host answers. */
  status: number;
  location: string | null;
  body: Uint8Array;
  contentLength: string | null;
  linkCalls: number;
  storageCalls: number;
};
const storage: Storage = {urlError: null, link: '', redirects: [], hang: false, status: 200, location: null, body: new Uint8Array(), contentLength: null, linkCalls: 0, storageCalls: 0};

/* --------------------------------- fakes --------------------------------- */

type Call = {key: string; req: ProviderRequest};
let calls: Call[] = [];
let counts: CountTokensRequest[] = [];
let countAnswer: () => Promise<{ok: true; inputTokens: number} | {ok: false; reason: 'timeout' | 'http' | 'shape' | 'network'}>;
let answer: (call: Call, n: number) => Promise<ProviderResult>;

const ok = (text: string, stopReason = 'end_turn'): ProviderResult => ({
  ok: true,
  text,
  inputTokens: 20_000,
  outputTokens: 1000,
  attempts: [{model: 'claude-haiku-5-5', inputTokens: 20_000, outputTokens: 1000}],
  stopReason,
  refused: stopReason === 'refusal',
});
/** A transcript of pages from..to of a `total`-page PDF. */
const pages = (from: number, to: number, total: number) =>
  ok(JSON.stringify({pageCount: total, lastPage: Math.min(to, total), markdown: Array.from({length: Math.min(to, total) - from + 1}, (_, i) => `## Page ${from + i}\n\nText of page ${from + i}.`).join('\n\n')}));
/** The pages the call asked for (from the server's instruction). */
const askedRange = (call: Call): [number, number] => {
  const content = call.req.messages[0]!.content;
  const text = Array.isArray(content) ? content.find(b => b.type === 'text') : null;
  const m = text && 'text' in text ? /pages? (\d+)(?: to (\d+))?/.exec(text.text) : null;
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : [0, 0];
};

describe.skipIf(!DATABASE_URL)('knowledge files: extraction (integration, real Postgres, fake provider + storage)', () => {
  let categoryId: number;
  let file: Uint8Array;
  let realFetch: typeof fetch;

  async function source(kind: 'pdf' | 'docx' | 'txt' | 'md', over: Record<string, unknown> = {}) {
    return db.kbSource.create({
      data: {fileId: FILE_ID, name: `guide.${kind}`, kind, size: 1000, state: 'queued', categoryId, createdBy: UPLOADER, ...over},
      select: {id: true},
    });
  }
  const rowOf = (id: number) => db.kbSource.findUniqueOrThrow({where: {id}});
  const draftsOf = (id: number) => db.kbArticle.findMany({where: {sourceId: id}, orderBy: {id: 'asc'}});
  const job = (id: number, round = 0, step = 0) => ({sourceId: id, round, step});
  const extractSends = () => sent.filter(s => s.list === 'kb-extract');
  const usage = async () => (await db.aiUsage.findFirst({select: {spentMicros: true}}))?.spentMicros ?? 0n;
  /** The money invariant: the month's spend = what the files say they spent (every hold settled, nothing twice). */
  /** This month's PDF counter. */
  const pdfSpent = async () => (await db.helpdeskCounter.findUnique({where: {name: kbPdfSpentCounter(monthKey())}}))?.value ?? 0;
  const expectMoneyBalanced = async (expected?: number) => {
    const total = (await db.kbSource.aggregate({_sum: {spentMicros: true}}))._sum.spentMicros ?? 0;
    expect(await usage()).toBe(BigInt(total));
    // PDF reading's own month counter moved by exactly the same money.
    expect(BigInt(await pdfSpent())).toBe(await usage());
    if (expected !== undefined) expect(total).toBe(expected);
  };
  /** A PDF already started at `step` (counted, 10 pages). */
  const started = (step: number, over: Record<string, unknown> = {}) =>
    source('pdf', {state: 'extracting', step, inputTokens: 21_000, pagesTotal: 10, text: '## Start\n\nFirst pages.\n\n', ...over});
  /** Runs every accepted job (as the platform would, one at a time) until none is left. */
  const drain = async (limit = 20) => {
    for (let i = 0; i < limit && platformJobs.accepted.length; i++) {
      const next = platformJobs.accepted.shift()!;
      await runKbExtractJob(db, next.data, JOB, PLATFORM);
    }
  };

  beforeAll(() => {
    configureEnv();
    realFetch = globalThis.fetch;
    // The platform's file link and the storage host; everything else goes to the harness's fetch.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${PLATFORM}/api/site/v1/files/`) && url.endsWith('/url')) {
        storage.linkCalls++;
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${env.SITE_KEY}`) throw new Error('file link without the Site Key');
        if (storage.urlError) return new Response(JSON.stringify({errors: [{code: storage.urlError, message: 'No.'}]}), {status: 409});
        return new Response(JSON.stringify({data: {url: storage.link, expiresAt: new Date(Date.now() + 300_000).toISOString()}}), {status: 200});
      }
      if (url.startsWith(STORAGE) || url.startsWith(PLATFORM)) {
        storage.storageCalls++;
        if (url.startsWith(PLATFORM)) throw new Error('fetched the site itself');
        expect(init?.redirect).toBe('manual');
        if (storage.hang) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          });
        }
        const hop = storage.redirects.shift();
        if (hop) return new Response(null, {status: 302, headers: {location: hop}});
        const headers = new Headers();
        if (storage.location) headers.set('location', storage.location);
        if (storage.contentLength) headers.set('content-length', storage.contentLength);
        return new Response(storage.status === 200 ? (storage.body as Uint8Array<ArrayBuffer>) : null, {status: storage.status, headers});
      }
      return realFetch(input, init);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    delete env.ANTHROPIC_API_KEY;
    setAiProviderForTests(null);
    setCountTokensForTests(null);
    setStoredFileReaderForTests(null);
    await db.$disconnect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetHelpdeskSettings();
    env.ANTHROPIC_API_KEY = KEY;
    env.SITE_KEY = 'stk_test_stub';
    sent.length = 0;
    calls = [];
    counts = [];
    Object.assign(platformJobs, {dedupe: false, keys: new Set<string>(), accepted: [], reject: null, tries: 0});
    Object.assign(storage, {urlError: null, link: `${STORAGE}/get/${FILE_ID}?sig=abc`, redirects: [], hang: false, status: 200, location: null, body: new Uint8Array(), contentLength: null, linkCalls: 0, storageCalls: 0});
    file = utf8.encode('# Returns\n\nSend it back within 30 days.\n\n# Shipping\n\nWe ship in 2 days.');
    setStoredFileReaderForTests(async () => file);
    countAnswer = async () => ({ok: true, inputTokens: 20_000});
    setCountTokensForTests(async (_key, req) => {
      counts.push(req);
      return countAnswer();
    });
    answer = async () => pages(1, 4, 4);
    setAiProviderForTests(async (key, req) => {
      const call = {key, req};
      calls.push(call);
      return answer(call, calls.length);
    });
    categoryId = (await db.kbCategory.create({data: {name: 'Help', slug: 'help'}, select: {id: true}})).id;
  });

  it('a Markdown file becomes DRAFT articles: no chunks, the category count unchanged, the row drafted and audited', async () => {
    const {id} = await source('md');
    await runKbExtractJob(db, job(id), JOB, PLATFORM);

    const row = await rowOf(id);
    expect(row).toMatchObject({state: 'drafted', draftsCreated: 2, text: '', error: '', spentMicros: 0});
    expect(row.completedAt).not.toBeNull();
    const drafts = await draftsOf(id);
    expect(drafts.map(d => [d.title, d.status, d.categoryId, d.createdBy, d.updatedBy])).toEqual([
      ['Returns', 'draft', categoryId, UPLOADER, UPLOADER],
      ['Shipping', 'draft', categoryId, UPLOADER, UPLOADER],
    ]);
    expect(drafts[0]!.slug).toBe('returns');
    expect(drafts[0]!.excerpt).toBe('Send it back within 30 days.');
    expect(await db.kbChunk.count()).toBe(0);
    expect((await db.kbCategory.findUniqueOrThrow({where: {id: categoryId}})).articleCount).toBe(0);
    const audits = await db.auditEvent.findMany({where: {action: 'kb_file_drafted'}});
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({actorUserId: UPLOADER, targetType: 'kb_source', targetId: String(id), meta: {kind: 'md', drafts: 2}});
    expect(JSON.stringify(audits.map(a => a.meta))).not.toContain('guide');
    // No AI for text.
    expect(calls).toHaveLength(0);
    expect(counts).toHaveLength(0);

    // A second delivery of the same step writes nothing twice.
    await runKbExtractJob(db, job(id), JOB, PLATFORM);
    expect(await draftsOf(id)).toHaveLength(2);
  });

  it('slugs never collide with existing articles; a text file without headings is one draft titled from its name', async () => {
    await db.kbArticle.create({data: {categoryId, title: 'Guide', slug: 'guide', body: 'x', createdBy: 0, updatedBy: 0}});
    file = utf8.encode('Plain words.\r\nMore words.');
    const {id} = await source('txt');
    await runKbExtractJob(db, job(id), JOB, PLATFORM);
    const drafts = await draftsOf(id);
    expect(drafts.map(d => [d.title, d.slug, d.body])).toEqual([['guide', 'guide-2', 'Plain words.\nMore words.']]);
  });

  it('a Word file becomes drafts; a file that is not text fails with words', async () => {
    file = docx;
    const {id} = await source('docx');
    await runKbExtractJob(db, job(id), JOB, PLATFORM);
    expect((await rowOf(id)).state).toBe('drafted');
    expect((await draftsOf(id)).map(d => d.title)).toEqual(['Returns', 'Shipping']);

    file = new Uint8Array([0x50, 0, 0x51]);
    const bad = await source('txt', {fileId: 'file_0123456789abcdefghijklmnoq'});
    await runKbExtractJob(db, job(bad.id), JOB, PLATFORM);
    expect(await rowOf(bad.id)).toMatchObject({state: 'failed', error: "This doesn't look like a text file. Save it as UTF-8 text and try again."});
  });

  it('a deleted category fails the file with words; a cancelled or deleted file is left alone', async () => {
    const {id} = await source('md');
    await db.kbCategory.delete({where: {id: categoryId}});
    await runKbExtractJob(db, job(id), JOB, PLATFORM);
    expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.categoryGone});
    expect(await db.kbArticle.count()).toBe(0);

    const cat = await db.kbCategory.create({data: {name: 'Two', slug: 'two'}, select: {id: true}});
    const cancelled = await source('pdf', {state: 'cancelled', categoryId: cat.id, fileId: 'file_0123456789abcdefghijklmnoq'});
    await runKbExtractJob(db, job(cancelled.id), JOB, PLATFORM);
    expect((await rowOf(cancelled.id)).state).toBe('cancelled');
    await runKbExtractJob(db, job(999_999), JOB, PLATFORM);
    expect(calls).toHaveLength(0);
    expect(counts).toHaveLength(0);
  });

  it('bad job data is DontRetry', async () => {
    await expect(runKbExtractJob(db, {sourceId: 0, round: 0, step: 0}, JOB, PLATFORM)).rejects.toThrow('Bad file job.');
    await expect(runKbExtractJob(db, {sourceId: 1, round: -1, step: 0}, JOB, PLATFORM)).rejects.toThrow('Bad file job.');
  });

  describe('reading the stored file (the real reader)', () => {
    beforeEach(() => {
      setStoredFileReaderForTests(null);
      storage.body = utf8.encode('# One\n\nBody.');
    });

    it('reads through a 5-minute link on the storage host', async () => {
      const {id} = await source('md');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect((await rowOf(id)).state).toBe('drafted');
      expect(storage.linkCalls).toBe(1);
      expect(storage.storageCalls).toBe(1);
    });

    it('a redirect to another https host is followed once', async () => {
      storage.redirects = [`${STORAGE}/elsewhere/${FILE_ID}`];
      const {id} = await source('md');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect((await rowOf(id)).state).toBe('drafted');
      expect(storage.storageCalls).toBe(2);
      expect(storage.redirects).toEqual([]);
    });

    it('a download that never answers times out within the run\'s time → "couldn\'t read"', async () => {
      storage.hang = true;
      const {id} = await source('md');
      // 54.8 s of the 55 s budget gone at once: the download gets 200 ms.
      let first = true;
      vi.spyOn(Date, 'now').mockImplementation(() => (first ? ((first = false), 1_000_000) : 1_054_800));
      await expect(runKbExtractJob(db, job(id), JOB, PLATFORM)).resolves.toBeUndefined();
      vi.restoreAllMocks();
      expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_FILE_MESSAGES.couldNotRead});
    });

    const failures: [string, () => void | Promise<void>][] = [
      ['E_FILE_NOT_READY', () => void (storage.urlError = 'E_FILE_NOT_READY')],
      ['E_STORAGE_OFF', () => void (storage.urlError = 'E_STORAGE_OFF')],
      ['E_STORAGE_NEEDS_PACK', () => void (storage.urlError = 'E_STORAGE_NEEDS_PACK')],
      ['no Site Key (SiteKeyMissing)', () => void (env.SITE_KEY = '')],
      ["a link on the site's own host", () => void (storage.link = `${PLATFORM}/__platform/files/${FILE_ID}/guide.md`)],
      ['a plain-http link', () => void (storage.link = `http://storage.example.test/get/${FILE_ID}`)],
      ['a link with a user:password', () => void (storage.link = `https://user:pass@storage.example.test/get/${FILE_ID}`)],
      ['a redirect to the site itself', () => void (storage.redirects = [`${PLATFORM}/x`])],
      ['a redirect to plain http', () => void (storage.redirects = [`http://storage.example.test/get/${FILE_ID}`])],
      ['a second redirect', () => void (storage.redirects = [`${STORAGE}/one`, `${STORAGE}/two`])],
      ['a redirect without a Location', () => void (storage.status = 302)],
      ['storage answers 403', () => void (storage.status = 403)],
      ['a body over the cap (declared)', () => void (storage.contentLength = String(9 * 1024 * 1024))],
      ['a body over the cap (streamed)', () => void (storage.body = new Uint8Array(8 * 1024 * 1024 + 1).fill(65))],
    ];
    for (const [name, arrange] of failures) {
      it(`${name} → "couldn't read", never a thrown job, no AI`, async () => {
        const md = await source('md');
        const pdf = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnoq'});
        await arrange();
        await expect(runKbExtractJob(db, job(md.id), JOB, PLATFORM)).resolves.toBeUndefined();
        // Redirects are used up by a read: the same story again for the PDF.
        await arrange();
        await expect(runKbExtractJob(db, job(pdf.id), JOB, PLATFORM)).resolves.toBeUndefined();
        for (const id of [md.id, pdf.id]) {
          expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_FILE_MESSAGES.couldNotRead, text: ''});
        }
        expect(calls).toHaveLength(0);
        expect(counts).toHaveLength(0);
        expect(await db.auditEvent.count({where: {action: 'kb_file_failed'}})).toBe(2);
      });
    }

    it('no site address: "couldn\'t read"', async () => {
      const {id} = await source('md');
      await runKbExtractJob(db, job(id), JOB, null);
      expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_FILE_MESSAGES.couldNotRead});
    });
  });

  describe('PDF', () => {
    beforeEach(() => {
      file = utf8.encode('%PDF-1.7 fake');
    });

    it('10 pages at 4 a call: 3 calls over 2 runs, text in order, the fixed Haiku with thinking disabled and no fallbacks', async () => {
      answer = async call => {
        const [from, to] = askedRange(call);
        return pages(from, to, 10);
      };
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);

      // Step 0: counted once (document + instruction, thinking disabled); 2 calls this run.
      expect(counts).toHaveLength(1);
      expect(counts[0]).toMatchObject({model: 'claude-haiku-5-5', thinking: {type: 'disabled'}});
      expect(calls.map(askedRange)).toEqual([
        [1, 4],
        [5, 8],
      ]);
      for (const call of calls) {
        expect(call.req).toMatchObject({model: 'claude-haiku-5-5', serverFallback: false, thinking: {type: 'disabled'}, maxTokens: 5000});
        expect(call.req.timeoutMs).toBeLessThanOrEqual(40_000);
        const body = requestBody(call.req);
        expect(body).not.toHaveProperty('fallbacks');
        expect(body.thinking).toEqual({type: 'disabled'});
        const content = call.req.messages[0]!.content;
        expect(Array.isArray(content) && content[0]!.type).toBe('document');
      }
      let row = await rowOf(id);
      expect(row).toMatchObject({state: 'extracting', step: 9, pagesTotal: 10, inputTokens: 21_000});
      expect(extractSends()).toEqual([
        {list: 'kb-extract', data: {sourceId: id, round: 0, step: 9}, options: expect.objectContaining({key: kbExtractKey(id, 0, 9)})},
      ]);

      // A duplicate of the old step: re-sends the row's step (same key), no call, nothing appended.
      sent.length = 0;
      await runKbExtractJob(db, job(id, 0, 0), JOB, PLATFORM);
      expect(calls).toHaveLength(2);
      expect(extractSends()).toEqual([expect.objectContaining({data: {sourceId: id, round: 0, step: 9}, options: expect.objectContaining({key: kbExtractKey(id, 0, 9)})})]);
      expect((await rowOf(id)).text).toBe(row.text);

      await runKbExtractJob(db, job(id, 0, 9), JOB, PLATFORM);
      expect(calls.map(askedRange)[2]).toEqual([9, 12]);
      row = await rowOf(id);
      expect(row).toMatchObject({state: 'drafted', text: '', pagesTotal: 10});
      expect(counts).toHaveLength(1);
      const drafts = await draftsOf(id);
      // "## Page n" twice or more → one draft per page, in order.
      expect(drafts.map(d => d.title)).toEqual(Array.from({length: 10}, (_, i) => `Page ${i + 1}`));
      // Money: 3 calls at 20K in / 1K out on Haiku = 3 × 2,500 micro-dollars; the holds released.
      expect(row.spentMicros).toBe(7500);
      expect(await usage()).toBe(7500n);
    });

    it('over 90K input tokens: failed with words before any billed call', async () => {
      countAnswer = async () => ({ok: true, inputTokens: 95_000});
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      const row = await rowOf(id);
      expect(row.state).toBe('failed');
      expect(row.error).toMatch(/^This PDF is too long to read in one go \(about \d+ pages\)\. Split it into smaller files\.$/);
      expect(calls).toHaveLength(0);
      expect(await usage()).toBe(0n);
    });

    it('no AI key, the file budget, and the monthly cap each fail with words and no call', async () => {
      delete env.ANTHROPIC_API_KEY;
      const a = await source('pdf');
      await runKbExtractJob(db, job(a.id), JOB, PLATFORM);
      expect(await rowOf(a.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.pdfNeedsAi});
      env.ANTHROPIC_API_KEY = KEY;

      const b = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnoq', spentMicros: 499_000});
      await runKbExtractJob(db, job(b.id), JOB, PLATFORM);
      expect(await rowOf(b.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.budget});

      // $3 cap, all spent (PDF reading's share, $0.75, has room past b's $0.499: the cap itself says no).
      await resetHelpdeskSettings('claude-opus-5-5', 300);
      await db.aiUsage.create({data: {month: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)), spentMicros: 3_000_000n, requests: 1}});
      const c = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnor'});
      await runKbExtractJob(db, job(c.id), JOB, PLATFORM);
      expect(await rowOf(c.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.cap});
      expect(calls).toHaveLength(0);
    });

    it('max_tokens halves the pages per call 4 → 2 → 1; a page that still fails alone becomes a note', async () => {
      answer = async call => {
        const [from, to] = askedRange(call);
        if (from === 5) return ok('{"pageCount": 6, "lastPage"', 'max_tokens');
        return pages(from, to, 6);
      };
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect(await rowOf(id)).toMatchObject({step: 5, pagesPerCall: 2, state: 'extracting'});
      await runKbExtractJob(db, job(id, 0, 5), JOB, PLATFORM);
      expect(await rowOf(id)).toMatchObject({step: 6, pagesPerCall: 1});
      expect((await rowOf(id)).text).toContain('> [Page 5 could not be read.]');
      await runKbExtractJob(db, job(id, 0, 6), JOB, PLATFORM);
      expect(calls.map(askedRange)).toEqual([
        [1, 4],
        [5, 8],
        [5, 6],
        [5, 5],
        [6, 6],
      ]);
      expect((await rowOf(id)).state).toBe('drafted');
      expect((await draftsOf(id)).some(d => d.body.includes('Page 5 could not be read'))).toBe(true);
      // 5 calls at 2,500 micro-dollars, every hold settled.
      await expectMoneyBalanced(12_500);
    });

    it('a timeout halves too; at one page it fails ("didn\'t answer in time"), the hold kept as its cost', async () => {
      answer = async () => ({ok: false, reason: 'timeout'});
      const {id} = await source('pdf', {pagesPerCall: 2});
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      const row = await rowOf(id);
      expect(row).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.timedOut, pagesPerCall: 1});
      expect(calls).toHaveLength(2);
      expect(row.spentMicros).toBeGreaterThan(0);
      expect(await usage()).toBe(BigInt(row.spentMicros));
    });

    it('a refusal is final; a network error retries, and the last try fails the file', async () => {
      answer = async () => ok('{}', 'refusal');
      const a = await source('pdf');
      await runKbExtractJob(db, job(a.id), JOB, PLATFORM);
      expect(await rowOf(a.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.refused});

      answer = async () => ({ok: false, reason: 'network'});
      const b = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnoq'});
      await expect(runKbExtractJob(db, job(b.id), JOB, PLATFORM)).rejects.toThrow(KB_EXTRACT_WORDS.noAnswer);
      expect((await rowOf(b.id)).state).toBe('extracting');
      await expect(runKbExtractJob(db, job(b.id), LAST, PLATFORM)).rejects.toThrow(KB_EXTRACT_WORDS.noAnswer);
      expect(await rowOf(b.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.noAnswer});
      // count_tokens ran once: the stored count is reused on the retry.
      expect(counts).toHaveLength(2);
    });

    it('a full window re-sends the same step in a minute under a -w key; in the Preview it fails with words', async () => {
      await setRateWindow('ai-extract', 10, 'minute');
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect(calls).toHaveLength(0);
      const [send] = extractSends();
      expect(send?.data).toEqual({sourceId: id, round: 0, step: 0});
      expect(send?.options).toMatchObject({delay: 60, key: expect.stringMatching(new RegExp(`^${kbExtractKey(id, 0, 0)}-w\\d+$`))});
      expect((await rowOf(id)).state).toBe('extracting');

      await runKbExtractJob(db, job(id), {...JOB, local: true}, PLATFORM);
      expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.busyLocal});
      await expectMoneyBalanced(0);
    });

    it('time: each call gets min(40 s, 55 s − elapsed), and no call starts with under 15 s left', async () => {
      let clock = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      answer = async call => {
        clock += 30_000;
        const [from, to] = askedRange(call);
        return pages(from, to, 20);
      };
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      // 1st call at 0 s elapsed: 40 s; 2nd at 30 s: 25 s left − the 10 s tail = 15 s.
      expect(calls.map(c => c.req.timeoutMs)).toEqual([40_000, 15_000]);

      calls = [];
      sent.length = 0;
      answer = async call => {
        clock += 41_000;
        const [from, to] = askedRange(call);
        return pages(from, to, 20);
      };
      await runKbExtractJob(db, job(id, 0, 9), JOB, PLATFORM);
      // After 41 s only 14 s are left (4 s after the tail): no 2nd call, the next step is sent instead.
      expect(calls).toHaveLength(1);
      expect(extractSends()).toEqual([expect.objectContaining({data: {sourceId: id, round: 0, step: 13}})]);
    });

    it('cancelled meanwhile: the write is refused, nothing appended, no drafts', async () => {
      const {id} = await source('pdf');
      answer = async call => {
        await db.kbSource.update({where: {id}, data: {state: 'cancelled', text: ''}});
        const [from, to] = askedRange(call);
        return pages(from, to, 10);
      };
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect(calls).toHaveLength(1);
      expect(await rowOf(id)).toMatchObject({state: 'cancelled', text: ''});
      expect(await db.kbArticle.count()).toBe(0);
      // The call was billed: the month and the file both show it, once.
      await expectMoneyBalanced(2500);
    });

    it('a run that ends without moving the step chains under a NEW key (the platform dedupes keys): the chain goes on', async () => {
      platformJobs.dedupe = true;
      answer = async call => {
        const [from, to] = askedRange(call);
        // Pages 5.. come back cut off unless asked one at a time.
        if (from === 5 && to > 5) return ok('{"pageCount": 10', 'max_tokens');
        return pages(from, to, 10);
      };
      const {id} = await started(5);
      // This run was delivered under the step's own key.
      platformJobs.keys.add(kbExtractKey(id, 0, 5));
      await runKbExtractJob(db, job(id, 0, 5), JOB, PLATFORM);
      // 4 → 2 → 1 pages per call, both cut off: the step is still 5, and the next run is on its way.
      expect(await rowOf(id)).toMatchObject({step: 5, pagesPerCall: 1, state: 'extracting'});
      expect(platformJobs.accepted).toEqual([{data: {sourceId: id, round: 0, step: 5}, key: kbExtractKey(id, 0, 5, 1)}]);
      expect(kbExtractKey(id, 0, 5, 1)).not.toBe(kbExtractKey(id, 0, 5));

      await drain();
      const row = await rowOf(id);
      expect(row.state).toBe('drafted');
      expect(calls.map(askedRange).slice(2)).toEqual([5, 6, 7, 8, 9, 10].map(p => [p, p]));
      // Every key the chain used was new.
      expect(sent.filter(x => x.list === 'kb-extract').length).toBe(platformJobs.keys.size - 1);
      await expectMoneyBalanced(8 * 2500);
    });

    it('page 1 unreadable even alone: the PDF fails ("couldn\'t read this PDF"), its cost kept', async () => {
      answer = async () => ok('not json at all');
      const {id} = await source('pdf', {pagesPerCall: 1});
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.unreadablePdf, text: ''});
      expect(calls).toHaveLength(1);
      await expectMoneyBalanced(2500);
    });

    it('an unreadable reply (not cut off) halves the pages per call too', async () => {
      answer = async call => (askedRange(call)[1] - askedRange(call)[0] >= 3 ? ok('{"pageCount": "ten"}') : pages(...askedRange(call), 2));
      const {id} = await source('pdf');
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      expect(calls.map(askedRange)).toEqual([
        [1, 4],
        [1, 2],
      ]);
      expect(await rowOf(id)).toMatchObject({state: 'drafted', pagesPerCall: 2});
      await expectMoneyBalanced(5000);
    });

    it('the text cap: a chunk that would pass 200,000 characters is not written; drafts from what was read, with a note', async () => {
      const {id} = await started(5, {text: `## Start\n\n${'x'.repeat(199_950)}`});
      answer = async call => pages(...askedRange(call), 10);
      await runKbExtractJob(db, job(id, 0, 5), JOB, PLATFORM);
      const row = await rowOf(id);
      expect(row).toMatchObject({state: 'drafted', error: KB_EXTRACT_WORDS.longPdf(4)});
      expect(calls).toHaveLength(1);
      await expectMoneyBalanced(2500);
    });

    it('the 80-page cap: a run past page 80 drafts what was read with a note, and makes no call', async () => {
      const {id} = await started(81, {pagesTotal: 200});
      await runKbExtractJob(db, job(id, 0, 81), JOB, PLATFORM);
      expect(await rowOf(id)).toMatchObject({state: 'drafted', error: KB_EXTRACT_WORDS.longPdf(80)});
      expect(calls).toHaveLength(0);
      expect(counts).toHaveLength(0);
    });

    it('count_tokens failing: retried, and the last try fails the file', async () => {
      countAnswer = async () => ({ok: false, reason: 'http'});
      const {id} = await source('pdf');
      await expect(runKbExtractJob(db, job(id), JOB, PLATFORM)).rejects.toThrow(KB_EXTRACT_WORDS.noAnswer);
      expect(await rowOf(id)).toMatchObject({state: 'queued', inputTokens: null});
      await expect(runKbExtractJob(db, job(id), LAST, PLATFORM)).rejects.toThrow(KB_EXTRACT_WORDS.noAnswer);
      expect(await rowOf(id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.noAnswer});
      expect(calls).toHaveLength(0);
      await expectMoneyBalanced(0);
    });

    it('a delivery of another round does nothing', async () => {
      const {id} = await started(5, {round: 2});
      await runKbExtractJob(db, job(id, 1, 5), JOB, PLATFORM);
      await runKbExtractJob(db, job(id, 1, 0), LAST, PLATFORM);
      expect(calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(await rowOf(id)).toMatchObject({state: 'extracting', step: 5, round: 2});
    });

    it('a stale delivery that cannot re-send yet (last try) throws but never fails the row', async () => {
      const {id} = await started(9);
      platformJobs.reject = 'E_JOBS_RATE_LIMITED';
      await expect(runKbExtractJob(db, job(id, 0, 5), LAST, PLATFORM)).rejects.toThrow();
      expect(await rowOf(id)).toMatchObject({state: 'extracting', step: 9, error: ''});
      expect(calls).toHaveLength(0);
    });

    it("PDF reading's share of the month (25 % of the cap): ONE exact counter; reached → failed with words, no call", async () => {
      const month = monthKey();
      // The cap is $20 (2000 cents): the share is $5 = 5,000,000 micro-dollars.
      await db.helpdeskCounter.create({data: {name: kbPdfSpentCounter(month), value: 4_998_000}});
      const a = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnoq'});
      await runKbExtractJob(db, job(a.id), JOB, PLATFORM);
      // $4.998 spent + one call's hold ($0.00462) would pass $5.
      expect(await rowOf(a.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.pdfShare});
      expect(calls).toHaveLength(0);
      expect(KB_EXTRACT_WORDS.pdfShare).toBe("PDF reading has used its share of this month's AI budget. Try again next month or raise the cap.");

      // Reached exactly: refused before the file is even read or counted.
      await db.helpdeskCounter.update({where: {name: kbPdfSpentCounter(month)}, data: {value: 5_000_000}});
      const c = await source('pdf', {fileId: 'file_0123456789abcdefghijklmnos'});
      await runKbExtractJob(db, job(c.id), JOB, PLATFORM);
      expect(await rowOf(c.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.pdfShare});
      expect(counts).toHaveLength(1);
      // A Word or text file is never held back.
      file = utf8.encode('# Fine\n\nWords.');
      const d = await source('md', {fileId: 'file_0123456789abcdefghijklmnot'});
      await runKbExtractJob(db, job(d.id), JOB, PLATFORM);
      expect((await rowOf(d.id)).state).toBe('drafted');
    });

    it("a file retried in a new month: last month's spend (its lifetime spent_micros, last month's counter) doesn't count", async () => {
      const lastMonth = monthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)));
      await db.helpdeskCounter.create({data: {name: kbPdfSpentCounter(lastMonth), value: 5_000_000}});
      // Read last month for $0.40, failed, retried now (round 1): its row still says 400,000.
      const {id} = await source('pdf', {round: 1, spentMicros: 400_000});
      await runKbExtractJob(db, job(id, 1), JOB, PLATFORM);
      const row = await rowOf(id);
      expect(row.state).toBe('drafted');
      expect(row.spentMicros).toBe(402_500);
      // This month's counter has this call only, the same as the month's AI spend.
      expect(await pdfSpent()).toBe(2500);
      expect(await usage()).toBe(2500n);
      expect((await db.helpdeskCounter.findUniqueOrThrow({where: {name: kbPdfSpentCounter(lastMonth)}})).value).toBe(5_000_000);
    });

    it('a run whose file read and count used its time makes no call and chains under a run-unique key (never its own)', async () => {
      platformJobs.dedupe = true;
      let clock = 2_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      setStoredFileReaderForTests(async () => {
        clock += 23_000;
        return file;
      });
      countAnswer = async () => {
        clock += 10_000;
        return {ok: true, inputTokens: 20_000};
      };
      const {id} = await source('pdf');
      platformJobs.keys.add(kbExtractKey(id, 0, 0));
      await runKbExtractJob(db, job(id), JOB, PLATFORM);
      // 55 − 23 − 10 = 22 s left, 12 s after the tail: no call.
      expect(calls).toHaveLength(0);
      expect(await rowOf(id)).toMatchObject({state: 'extracting', step: 0, inputTokens: 21_000});
      expect(platformJobs.accepted).toEqual([{data: {sourceId: id, round: 0, step: 0}, key: `${kbExtractKey(id, 0, 0)}-t2000000`}]);

      // The next run (no count now, a quicker read) goes on.
      setStoredFileReaderForTests(async () => file);
      answer = async call => pages(...askedRange(call), 4);
      await drain();
      expect((await rowOf(id)).state).toBe('drafted');
    });
  });

  it('the sweep: re-sends rows idle 15 min, fails rows idle 2 h, deletes uploads older than 2 h', async () => {
    const idle = await source('pdf', {state: 'extracting', step: 5, round: 2});
    const stuck = await source('md', {fileId: 'file_0123456789abcdefghijklmnoq'});
    const upload = await source('txt', {state: 'uploading', fileId: 'file_0123456789abcdefghijklmnor'});
    const fresh = await source('txt', {fileId: 'file_0123456789abcdefghijklmnos'});
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '20 minutes' WHERE "id" = ${idle.id}`;
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '3 hours' WHERE "id" IN (${stuck.id}, ${upload.id})`;

    await sweepKbSources(db, PLATFORM);
    // Never the step's own key (deduped for 24 h): the key + the 15-minute slot.
    expect(extractSends()).toEqual([
      {list: 'kb-extract', data: {sourceId: idle.id, round: 2, step: 5}, options: expect.objectContaining({key: expect.stringMatching(new RegExp(`^${kbExtractKey(idle.id, 2, 5)}-s\\d+$`))})},
    ]);
    expect(await rowOf(stuck.id)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.stopped});
    expect(await db.kbSource.findUnique({where: {id: upload.id}})).toBeNull();
    expect((await rowOf(fresh.id)).state).toBe('queued');
    expect(await db.auditEvent.count({where: {action: 'kb_file_failed', targetId: String(stuck.id)}})).toBe(1);

    // maxSends 0: housekeeping only.
    sent.length = 0;
    await sweepKbSources(db, PLATFORM, {maxSends: 0});
    expect(sent).toHaveLength(0);
  });

  it('the sweep re-sends a step whose chained job was accepted and then died (its own key is deduped)', async () => {
    platformJobs.dedupe = true;
    const {id} = await source('pdf', {state: 'extracting', step: 5, pagesPerCall: 2, inputTokens: 21_000, pagesTotal: 6});
    platformJobs.keys.add(kbExtractKey(id, 0, 5, 2));
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '20 minutes' WHERE "id" = ${id}`;
    await sweepKbSources(db, PLATFORM);
    expect(platformJobs.accepted).toEqual([{data: {sourceId: id, round: 0, step: 5}, key: expect.stringMatching(/-p2-s\d+$/)}]);
    file = utf8.encode('%PDF-1.7 fake');
    answer = async call => pages(...askedRange(call), 6);
    await drain();
    expect((await rowOf(id)).state).toBe('drafted');
  });

  it('the sweep: at most 3 sends by default, stops at the first refused send, and without a site address only tidies up', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await source('md', {fileId: `file_0123456789abcdefghijklm${String(i).padStart(3, '0')}`})).id);
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '20 minutes'`;
    await sweepKbSources(db, PLATFORM);
    expect(extractSends()).toHaveLength(3);

    sent.length = 0;
    platformJobs.tries = 0;
    platformJobs.reject = 'E_JOBS_BAD_LIST';
    await sweepKbSources(db, PLATFORM);
    // Refused for good: the first refusal stops the sweep.
    expect(platformJobs.tries).toBe(1);
    expect(sent).toHaveLength(0);

    // A stuck row is still failed with no site address; nothing is sent.
    platformJobs.reject = null;
    await db.$executeRaw`UPDATE "kb_sources" SET "updated_at" = now() - interval '3 hours' WHERE "id" = ${ids[0]}`;
    await db.$executeRaw`INSERT INTO "helpdesk_counters" ("name", "value", "updated_at") VALUES ('kb-files:1:2020-01-01', 3, '2020-01-02')`;
    await sweepKbSources(db, null);
    expect(sent).toHaveLength(0);
    expect(await rowOf(ids[0]!)).toMatchObject({state: 'failed', error: KB_EXTRACT_WORDS.stopped});
    expect(await db.helpdeskCounter.findUnique({where: {name: 'kb-files:1:2020-01-01'}})).toBeNull();
  });

  it('two deliveries finishing the same file at once make its drafts once', async () => {
    const {id} = await source('md', {state: 'extracting'});
    const results = await Promise.allSettled([runKbExtractJob(db, job(id), JOB, PLATFORM), runKbExtractJob(db, job(id), JOB, PLATFORM)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(await draftsOf(id)).toHaveLength(2);
    expect((await rowOf(id)).state).toBe('drafted');
    expect(await db.auditEvent.count({where: {action: 'kb_file_drafted'}})).toBe(1);
  });

  it('draft titles lose hidden bidi and zero-width characters', async () => {
    file = utf8.encode('# Re\u202Efunds\u200B policy\uFEFF\n\nBody.');
    const {id} = await source('md');
    await runKbExtractJob(db, job(id), JOB, PLATFORM);
    expect((await draftsOf(id)).map(d => d.title)).toEqual(['Refunds policy']);
  });
});
