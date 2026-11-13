import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {KB_FILE_MESSAGES, KB_FILE_NOT_REMOVED_MESSAGE, type KbFileRow} from '../../src/lib/kb-file-types';
import {app} from '../../src/server/app';
import {monthKey} from '../../src/server/ai/usage';
import {kbExtractKey, kbFilesDayCounter, kbPdfSpentCounter} from '../../src/server/kb/sources/pipeline';
import {env} from './support/cloudflare-workers';
import {configureEnv, DATABASE_URL, db, type HelpdeskCast, helpdeskCast, resetDatabase, resetHelpdeskSettings} from './support/harness';

/** Jobs the routes send are captured, never run inline (`waitUntil` is drained by the harness). */
const sent = vi.hoisted(() => [] as {list: string; data: unknown; options: Record<string, unknown>}[]);
vi.mock('../../src/platform/background', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/platform/background')>();
  return {
    ...real,
    sendJob: async (_url: unknown, list: string, data?: unknown, options: Record<string, unknown> = {}) => {
      sent.push({list, data, options});
      return {id: `job_t${sent.length}`, list, runAt: new Date().toISOString(), deduplicated: false, local: false};
    },
  };
});

/**
 * `/site-api/kb/files` (src/server/routes/kb-files.ts) against a real Postgres, with the platform's
 * file endpoints faked by a `fetch` stub that hands everything else to the harness's fetch.
 */
const KEY = 'fake-anthropic-key-for-tests-0123456789';
const PLATFORM = 'https://platform.example.test';
const STORAGE = 'https://storage.example.test';

vi.setConfig({hookTimeout: 60_000, testTimeout: 90_000});

type PlatformCall = {path: string; body: Record<string, unknown>};
const platform = {
  calls: [] as PlatformCall[],
  seq: 0,
  /** Refuse POST /uploads with this {status, code, message}. */
  uploadError: null as null | {status: number; code: string; message: string},
  usage: {ok: true, code: ''} as {ok: boolean; code: string},
  deleteOk: true,
  /** The code a refused delete answers with. */
  deleteCode: 'E_PLATFORM',
  /** Refuse POST /files/<id>/url with this code. */
  urlError: null as string | null,
};
const fileIdOf = (n: number) => `file_${String(n).padStart(26, '0')}`;

describe.skipIf(!DATABASE_URL)('knowledge files: routes (integration, real Postgres, fake storage)', () => {
  let cast: HelpdeskCast;
  let categoryId: number;
  let realFetch: typeof fetch;

  const start = (body: Record<string, unknown>, who = cast.kbOnly) => who.post('/site-api/kb/files', body);
  const upload = async (name = 'guide.md', size = 1000, who = cast.kbOnly) => {
    const res = await start({name, size, categoryId}, who);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return (res.json.file as {id: number}).id;
  };
  const seed = (n: number, data: Record<string, unknown>) =>
    db.kbSource.createMany({
      data: Array.from({length: n}, () => ({fileId: fileIdOf(++platform.seq + 5000), name: 'x.md', kind: 'md', size: 10, categoryId, createdBy: cast.ids.kbOnly, ...data})),
    });

  beforeAll(() => {
    configureEnv();
    realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const prefix = `${PLATFORM}/api/site/v1/files`;
      if (!url.startsWith(prefix)) return realFetch(input, init);
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${env.SITE_KEY}`) throw new Error('storage call without the Site Key');
      const path = url.slice(prefix.length);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      platform.calls.push({path, body});
      const data = (d: unknown, status = 200) => new Response(JSON.stringify({data: d}), {status});
      const refuse = (status: number, code: string, message = 'No.') => new Response(JSON.stringify({errors: [{code, message}]}), {status});
      if (path === '/usage') {
        return platform.usage.ok
          ? data({usedBytes: 1000, limitBytes: 5_000_000_000, onExceed: 'block', maxFileBytes: 5 * 1024 ** 3})
          : refuse(402, platform.usage.code);
      }
      if (path === '/uploads') {
        if (platform.uploadError) return refuse(platform.uploadError.status, platform.uploadError.code, platform.uploadError.message);
        const id = fileIdOf(++platform.seq);
        const file = {id, name: body.name, contentType: body.contentType, size: body.size, visibility: 'private', status: 'pending'};
        return data({file, upload: {method: 'PUT', url: `${STORAGE}/put/${id}`, headers: {'content-type': body.contentType}, expiresAt: '2030-01-01T00:00:00Z', direct: true}});
      }
      const m = /^\/(file_[0-9a-z]{26})\/(complete|url|delete)$/.exec(path);
      if (m && m[2] === 'complete') return data({file: {id: m[1], status: 'ready'}});
      if (m && m[2] === 'url') {
        if (platform.urlError) return refuse(409, platform.urlError, 'Storage is off.');
        return data({url: `${STORAGE}/get/${m[1]}?sig=s`, expiresAt: '2030-01-01T00:00:00Z'});
      }
      if (m && m[2] === 'delete') {
        if (platform.deleteOk) return data({deleted: true});
        return platform.deleteCode === 'E_FILE_NOT_FOUND' ? refuse(404, 'E_FILE_NOT_FOUND') : refuse(503, platform.deleteCode);
      }
      return refuse(404, 'E_NOT_FOUND');
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    delete env.ANTHROPIC_API_KEY;
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetHelpdeskSettings();
    env.ANTHROPIC_API_KEY = KEY;
    env.SITE_KEY = 'stk_test_stub';
    sent.length = 0;
    Object.assign(platform, {calls: [], uploadError: null, usage: {ok: true, code: ''}, deleteOk: true, deleteCode: 'E_PLATFORM', urlError: null});
    cast = await helpdeskCast(app, ['alice', 'agentA', 'kbOnly']);
    categoryId = (await db.kbCategory.create({data: {name: 'Help', slug: 'help'}, select: {id: true}})).id;
  });

  it('every route needs site:kb:edit (a customer gets 403, a guest 401)', async () => {
    const id = await upload();
    const paths: [string, string][] = [
      ['GET', '/site-api/kb/files/usage'],
      ['GET', '/site-api/kb/files'],
      ['GET', `/site-api/kb/files/${id}`],
      ['POST', '/site-api/kb/files'],
      ['POST', `/site-api/kb/files/${id}/complete`],
      ['POST', `/site-api/kb/files/${id}/retry`],
      ['POST', `/site-api/kb/files/${id}/cancel`],
      ['GET', `/site-api/kb/files/${id}/view`],
      ['DELETE', `/site-api/kb/files/${id}`],
    ];
    for (const [method, path] of paths) {
      const body = method === 'POST' ? (path.endsWith('/files') ? {name: 'a.md', size: 1, categoryId} : {}) : undefined;
      expect((await cast.alice.request(method, path, body)).status, `${method} ${path}`).toBe(403);
      expect((await cast.guest.request(method, path, body)).status, `${method} ${path}`).toBe(401);
    }
    expect(await db.kbSource.count()).toBe(1);
  });

  it('upload validation: kind, size per kind, name and category, with words on their fields', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{name: 'virus.exe', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.kind],
      [{name: 'notes.txt', size: 2 * 1024 * 1024, categoryId}, 'size', 'A text file can be at most 1 MB.'],
      [{name: 'guide.pdf', size: 9 * 1024 * 1024, categoryId}, 'size', 'A PDF can be at most 8 MB.'],
      [{name: 'w.docx', size: 9 * 1024 * 1024, categoryId}, 'size', 'A Word file can be at most 8 MB.'],
      [{name: 'a.md', size: 2 * 1024 * 1024, categoryId}, 'size', 'A Markdown file can be at most 1 MB.'],
      [{name: `${'a'.repeat(198)}.md`, size: 10, categoryId}, 'name', KB_FILE_MESSAGES.name],
      [{name: 'a\u0007.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      // A bidi override hiding the real extension ("invoice\u202Etxt.pdf" shows as "invoicefdp.txt").
      [{name: 'invoice\u202Etxt.pdf', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'in\u2066voice.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'zero\u200Bwidth.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'joiner\u2060.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'b\uFEFFom.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'half\uD800.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: 'half\uDC00.md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameChars],
      [{name: '.txt', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameBase],
      [{name: '  .md', size: 10, categoryId}, 'name', KB_FILE_MESSAGES.nameBase],
      [{name: 'ok.md', size: 0, categoryId}, 'size', KB_FILE_MESSAGES.empty],
      [{name: 'ok.md', size: 1.5, categoryId}, 'size', KB_FILE_MESSAGES.size],
      [{name: 'ok.md', size: 1e20, categoryId}, 'size', KB_FILE_MESSAGES.size],
      [{name: 'ok.md', size: -1, categoryId}, 'size', KB_FILE_MESSAGES.size],
      [{name: 'ok.md', size: '10', categoryId}, 'size', KB_FILE_MESSAGES.size],
      [{name: 'ok.md', categoryId}, 'size', KB_FILE_MESSAGES.size],
      [{name: 'ok.md', size: 10}, 'categoryId', KB_FILE_MESSAGES.category],
      [{name: 'ok.md', size: 10, categoryId: 999_999}, 'categoryId', KB_FILE_MESSAGES.category],
    ];
    for (const [body, field, message] of cases) {
      const res = await start(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json.error).toBe('fields');
      expect((res.json.fields as Record<string, string>)[field], JSON.stringify(body)).toBe(message);
      // A validator's answer is never cached either.
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
    expect(platform.calls.filter(c => c.path === '/uploads')).toHaveLength(0);
    // A name with an emoji (a proper surrogate pair) is fine.
    expect((await start({name: 'Guide 📘.md', size: 10, categoryId})).status).toBe(201);
  });

  it('the content type comes from the kind, never from the body; .md goes as text/plain; the upload is private', async () => {
    const res = await start({name: 'Guide.MD', size: 1234, categoryId, contentType: 'text/html', visibility: 'public'});
    expect(res.status).toBe(201);
    expect(res.json.upload).toMatchObject({method: 'PUT', direct: true});
    const call = platform.calls.find(c => c.path === '/uploads')!;
    expect(call.body).toMatchObject({name: 'Guide.MD', contentType: 'text/plain', size: 1234, direct: true});
    expect(call.body).not.toHaveProperty('visibility');
    const row = await db.kbSource.findFirstOrThrow();
    expect(row).toMatchObject({kind: 'md', state: 'uploading', createdBy: cast.ids.kbOnly, categoryId});

    await start({name: 'w.docx', size: 10, categoryId});
    expect(platform.calls.filter(c => c.path === '/uploads')[1]!.body.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('limits: 20 uploads a day per editor, 5 files read at once, PDFs need the AI', async () => {
    for (let i = 0; i < 20; i++) await upload(`f${i}.md`);
    let res = await start({name: 'a.md', size: 10, categoryId});
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({error: 'rate_limited', message: 'You uploaded or retried 20 files today. Try again tomorrow.'});
    // Another editor still can.
    expect((await start({name: 'a.md', size: 10, categoryId}, cast.agentA)).status).toBe(201);

    await db.kbSource.deleteMany();
    await db.helpdeskCounter.deleteMany();
    await seed(5, {state: 'queued', createdBy: 1});
    res = await start({name: 'a.md', size: 10, categoryId});
    expect(res.status).toBe(429);
    expect(res.json.message).toBe('Five files are being read. Wait for one to finish.');

    await db.kbSource.deleteMany();
    delete env.ANTHROPIC_API_KEY;
    res = await start({name: 'a.pdf', size: 10, categoryId});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('pdf_needs_ai');
    env.ANTHROPIC_API_KEY = KEY;
    await resetHelpdeskSettings('claude-opus-5-5', 0);
    expect((await start({name: 'a.pdf', size: 10, categoryId})).status).toBe(409);
    expect((await start({name: 'a.docx', size: 10, categoryId})).status).toBe(201);
  });

  it("storage refusals: E_STORAGE_LIMIT → 402 with its words; no Site Key → 503 and usage 'unavailable'", async () => {
    platform.uploadError = {status: 402, code: 'E_STORAGE_LIMIT', message: "This file doesn't fit in the storage left."};
    let res = await start({name: 'a.md', size: 10, categoryId});
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({error: 'storage', message: "This file doesn't fit in the storage left."});
    expect(await db.kbSource.count()).toBe(0);

    platform.uploadError = null;
    platform.usage = {ok: false, code: 'E_STORAGE_NEEDS_PACK'};
    res = await cast.kbOnly.get('/site-api/kb/files/usage');
    expect(res.json).toMatchObject({storage: 'needs_pack', usedBytes: null, pdfReady: true});

    env.SITE_KEY = '';
    res = await start({name: 'a.md', size: 10, categoryId});
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('storage_unavailable');
    res = await cast.kbOnly.get('/site-api/kb/files/usage');
    expect(res.json).toMatchObject({storage: 'unavailable', maxFileBytes: 8 * 1024 * 1024});
  });

  it('many uploads at once never pass the daily limit', async () => {
    await db.helpdeskCounter.create({data: {name: kbFilesDayCounter(cast.ids.kbOnly), value: 17}});
    const results = await Promise.all(Array.from({length: 6}, (_, i) => start({name: `p${i}.md`, size: 10, categoryId})));
    expect(results.filter(r => r.status === 201)).toHaveLength(3);
    expect(results.filter(r => r.status === 429)).toHaveLength(3);
    expect(await db.kbSource.count()).toBe(3);
    expect((await db.helpdeskCounter.findUniqueOrThrow({where: {name: kbFilesDayCounter(cast.ids.kbOnly)}})).value).toBe(20);
  });

  it('usage: space and pdfReady', async () => {
    const res = await cast.kbOnly.get('/site-api/kb/files/usage');
    expect(res.json).toEqual({storage: 'ok', usedBytes: 1000, limitBytes: 5_000_000_000, maxFileBytes: 8 * 1024 * 1024, pdfReady: true});
    delete env.ANTHROPIC_API_KEY;
    expect((await cast.kbOnly.get('/site-api/kb/files/usage')).json.pdfReady).toBe(false);
  });

  it('complete: only the uploader, once; it answers queued and the first job goes out after the answer', async () => {
    const id = await upload();
    expect((await cast.agentA.post(`/site-api/kb/files/${id}/complete`)).status).toBe(404);
    expect(sent).toHaveLength(0);

    const res = await cast.kbOnly.post(`/site-api/kb/files/${id}/complete`);
    expect(res.status).toBe(200);
    expect((res.json.file as KbFileRow).state).toBe('queued');
    expect(sent).toEqual([
      {list: 'kb-extract', data: {sourceId: id, round: 0, step: 0}, options: expect.objectContaining({key: kbExtractKey(id, 0, 0), label: `Read knowledge file #${id}`})},
    ]);
    expect(platform.calls.some(c => c.path.endsWith('/complete'))).toBe(true);
    const audits = await db.auditEvent.findMany({where: {action: 'kb_file_uploaded'}});
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toEqual({kind: 'md'});

    const again = await cast.kbOnly.post(`/site-api/kb/files/${id}/complete`);
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
    expect((await cast.kbOnly.post('/site-api/kb/files/999999/complete')).status).toBe(404);
    expect((await cast.kbOnly.post('/site-api/kb/files/abc/complete')).status).toBe(404);
  });

  it('list and detail: newest first, keyset pages, names not emails, couldNotRead, drafts', async () => {
    await seed(22, {state: 'drafted'});
    const failed = await db.kbSource.create({
      data: {fileId: fileIdOf(9001), name: 'broken.pdf', kind: 'pdf', size: 10, state: 'failed', error: KB_FILE_MESSAGES.couldNotRead, categoryId, createdBy: 987_654, step: 5, spentMicros: 12_345},
      select: {id: true},
    });
    await db.kbArticle.create({data: {categoryId, title: 'From file', slug: 'from-file', body: 'x', createdBy: 1, updatedBy: 1, sourceId: failed.id}});

    const first = await cast.kbOnly.get('/site-api/kb/files');
    const items = first.json.items as KbFileRow[];
    expect(items).toHaveLength(20);
    expect(items[0]).toMatchObject({id: failed.id, couldNotRead: true, uploadedBy: 'Former team member', pagesDone: 4, costCents: 2, category: {id: categoryId, name: 'Help'}});
    expect(items[0]!.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(items[1]).toMatchObject({couldNotRead: false, state: 'drafted'});
    expect(JSON.stringify(first.json)).not.toContain('@');
    const second = await cast.kbOnly.get(`/site-api/kb/files?before=${String(first.json.next)}`);
    expect((second.json.items as KbFileRow[]).length).toBe(3);
    expect(second.json.next).toBeNull();

    const detail = await cast.kbOnly.get(`/site-api/kb/files/${failed.id}`);
    expect(detail.json.file).toMatchObject({costCents: 2, updatedAt: expect.any(String)});
    expect((detail.json.file as {drafts: unknown}).drafts).toEqual([{id: expect.any(Number), title: 'From file', status: 'draft'}]);
    expect((await cast.kbOnly.get('/site-api/kb/files/999999')).status).toBe(404);
  });

  it('retry: a failed file gets a new round (a new job key) and may change category; anything else is 409', async () => {
    const id = await upload('a.md');
    expect((await cast.kbOnly.post(`/site-api/kb/files/${id}/retry`)).status).toBe(409);
    await db.kbSource.update({where: {id}, data: {state: 'failed', error: 'x', text: 'old', step: 3, pagesPerCall: 1}});
    const other = await db.kbCategory.create({data: {name: 'Other', slug: 'other'}, select: {id: true}});
    expect((await cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {categoryId: 999_999})).status).toBe(422);

    const res = await cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {categoryId: other.id});
    expect(res.status).toBe(200);
    expect(res.json.file).toMatchObject({state: 'queued', error: '', category: {id: other.id}});
    expect(await db.kbSource.findUniqueOrThrow({where: {id}})).toMatchObject({round: 1, step: 0, pagesPerCall: 4, text: '', inputTokens: null});
    expect(sent).toEqual([expect.objectContaining({data: {sourceId: id, round: 1, step: 0}, options: expect.objectContaining({key: kbExtractKey(id, 1, 0)})})]);

    // Audited with its kind and round, never its name.
    const audits = await db.auditEvent.findMany({where: {action: 'kb_file_retried'}});
    expect(audits.map(a => [a.actorUserId, a.targetId, a.meta])).toEqual([[cast.ids.kbOnly, String(id), {kind: 'md', round: 1}]]);

    // Its category deleted and none picked (null, as the screen sends it): say so on the field.
    await db.kbSource.update({where: {id}, data: {state: 'failed', categoryId: null}});
    const noCat = await cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {categoryId: null});
    expect(noCat.status).toBe(422);
    expect((noCat.json.fields as Record<string, string>).categoryId).toBe(KB_FILE_MESSAGES.category);
    // null keeps the category it has.
    await db.kbSource.update({where: {id}, data: {categoryId}});
    expect((await cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {categoryId: null})).json.file).toMatchObject({state: 'queued', category: {id: categoryId}});
  });

  it('retry keeps the upload limits: 5 being read at once, 20 uploads + retries a day; a PDF needs the AI; the round has a ceiling', async () => {
    const id = await upload('a.md');
    await db.kbSource.update({where: {id}, data: {state: 'failed'}});
    const retry = () => cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {});

    await seed(5, {state: 'extracting', createdBy: 1});
    let res = await retry();
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({error: 'rate_limited', message: 'Five files are being read. Wait for one to finish.'});
    await db.kbSource.deleteMany({where: {state: 'extracting'}});

    // 1 upload + 19 retries = 20 today: the next retry is refused (and nothing moved).
    await db.helpdeskCounter.update({where: {name: kbFilesDayCounter(cast.ids.kbOnly)}, data: {value: 20}});
    res = await retry();
    expect(res.status).toBe(429);
    expect(res.json.message).toBe('You uploaded or retried 20 files today. Try again tomorrow.');
    expect((await db.kbSource.findUniqueOrThrow({where: {id}})).state).toBe('failed');
    // And uploads count the retries.
    expect((await start({name: 'b.md', size: 10, categoryId})).status).toBe(429);
    await db.helpdeskCounter.update({where: {name: kbFilesDayCounter(cast.ids.kbOnly)}, data: {value: 19}});
    expect((await retry()).status).toBe(200);
    expect((await db.helpdeskCounter.findUniqueOrThrow({where: {name: kbFilesDayCounter(cast.ids.kbOnly)}})).value).toBe(20);
    await db.helpdeskCounter.deleteMany();

    // The round is a SMALLINT: at its ceiling the file can't be tried again.
    await db.kbSource.update({where: {id}, data: {state: 'failed', round: 32767}});
    res = await retry();
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('already_started');

    // A PDF without the AI key.
    await db.kbSource.update({where: {id}, data: {kind: 'pdf', round: 0}});
    delete env.ANTHROPIC_API_KEY;
    res = await retry();
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('pdf_needs_ai');
    expect((await db.kbSource.findUniqueOrThrow({where: {id}})).state).toBe('failed');
  });

  it('cancel: queued/extracting → cancelled (audited); still uploading or finished → 409 with the right words', async () => {
    const id = await upload();
    const early = await cast.kbOnly.post(`/site-api/kb/files/${id}/cancel`);
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({error: 'not_started', message: "This file hasn't finished uploading, so there is nothing to stop. Delete it instead."});
    await db.kbSource.update({where: {id}, data: {state: 'extracting', text: 'partial', round: 3}});
    const res = await cast.kbOnly.post(`/site-api/kb/files/${id}/cancel`);
    expect(res.status).toBe(200);
    expect((res.json.file as KbFileRow).state).toBe('cancelled');
    expect((await db.kbSource.findUniqueOrThrow({where: {id}})).text).toBe('');
    const again = await cast.kbOnly.post(`/site-api/kb/files/${id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({error: 'already_finished', message: 'It already stopped.'});
    await db.kbSource.update({where: {id}, data: {state: 'drafted'}});
    expect((await cast.kbOnly.post(`/site-api/kb/files/${id}/cancel`)).json.message).toBe('It already finished.');
    expect((await cast.kbOnly.post('/site-api/kb/files/999999/cancel')).status).toBe(404);
    const audits = await db.auditEvent.findMany({where: {action: 'kb_file_cancelled'}});
    expect(audits.map(a => a.meta)).toEqual([{kind: 'md', round: 3}]);
  });

  it('view: a 302 to a 5-minute link; text always downloads, a PDF only when asked; never while uploading', async () => {
    const md = await upload('a.md');
    expect((await cast.kbOnly.get(`/site-api/kb/files/${md}/view`)).status).toBe(404);
    await db.kbSource.update({where: {id: md}, data: {state: 'drafted'}});
    const res = await cast.kbOnly.get(`/site-api/kb/files/${md}/view`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(new RegExp(`^${STORAGE}/get/file_`));
    expect(platform.calls.at(-1)!.body).toEqual({expiresIn: 300, download: true});

    const pdf = await upload('a.pdf');
    await db.kbSource.update({where: {id: pdf}, data: {state: 'drafted'}});
    await cast.kbOnly.get(`/site-api/kb/files/${pdf}/view`);
    expect(platform.calls.at(-1)!.body).toEqual({expiresIn: 300, download: false});
    await cast.kbOnly.get(`/site-api/kb/files/${pdf}/view?download=1`);
    expect(platform.calls.at(-1)!.body).toEqual({expiresIn: 300, download: true});
    expect(res.headers.get('cache-control')).toContain('no-store');

    // Audited (its kind, whether it downloaded), never its name.
    const audits = await db.auditEvent.findMany({where: {action: 'kb_file_viewed'}, orderBy: {id: 'asc'}});
    expect(audits.map(a => a.meta)).toEqual([
      {kind: 'md', download: true},
      {kind: 'pdf', download: false},
      {kind: 'pdf', download: true},
    ]);

    // Storage refusing the link → 400 with its words; no Site Key → 503.
    platform.urlError = 'E_STORAGE_OFF';
    const refused = await cast.kbOnly.get(`/site-api/kb/files/${pdf}/view`);
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({error: 'storage', message: 'Storage is off.'});
    platform.urlError = null;
    env.SITE_KEY = '';
    const noKey = await cast.kbOnly.get(`/site-api/kb/files/${pdf}/view`);
    expect(noKey.status).toBe(503);
    expect(noKey.json.error).toBe('storage_unavailable');
    expect(await db.auditEvent.count({where: {action: 'kb_file_viewed'}})).toBe(3);
  });

  it('delete: the row and the stored file go, its drafts stay (source cleared), audited without the name', async () => {
    const id = await upload('secret-plan.md');
    const article = await db.kbArticle.create({data: {categoryId, title: 'D', slug: 'd', body: 'x', createdBy: 1, updatedBy: 1, sourceId: id}, select: {id: true}});
    const res = await cast.kbOnly.delete(`/site-api/kb/files/${id}`);
    expect(res.json).toEqual({ok: true, fileDeleted: true, message: null});
    expect(await db.kbSource.count()).toBe(0);
    expect((await db.kbArticle.findUniqueOrThrow({where: {id: article.id}})).sourceId).toBeNull();
    expect(platform.calls.some(c => c.path.endsWith('/delete'))).toBe(true);
    const audit = await db.auditEvent.findFirstOrThrow({where: {action: 'kb_file_deleted'}});
    expect(JSON.stringify(audit.meta)).not.toContain('secret');
    expect((await cast.kbOnly.delete(`/site-api/kb/files/${id}`)).status).toBe(404);

    // Storage refusing: the row is gone anyway, and the answer says the stored copy stayed.
    platform.deleteOk = false;
    const two = await upload('b.md');
    expect((await cast.kbOnly.delete(`/site-api/kb/files/${two}`)).json).toEqual({ok: true, fileDeleted: false, message: KB_FILE_NOT_REMOVED_MESSAGE});
    expect((await db.auditEvent.findFirstOrThrow({where: {action: 'kb_file_deleted', targetId: String(two)}})).meta).toEqual({kind: 'md', fileDeleted: false});
    // Already gone from storage counts as deleted.
    platform.deleteCode = 'E_FILE_NOT_FOUND';
    const three = await upload('c.md');
    expect((await cast.kbOnly.delete(`/site-api/kb/files/${three}`)).json).toEqual({ok: true, fileDeleted: true, message: null});
  });

  it("delete: PDF reading's month counter is not touched (deleting files frees none of the share)", async () => {
    await db.helpdeskCounter.create({data: {name: kbPdfSpentCounter(monthKey()), value: 40_000}});
    const pdf = await upload('a.pdf');
    await db.kbSource.update({where: {id: pdf}, data: {state: 'drafted', spentMicros: 40_000}});
    expect((await cast.kbOnly.delete(`/site-api/kb/files/${pdf}`)).status).toBe(200);
    expect((await db.helpdeskCounter.findUniqueOrThrow({where: {name: kbPdfSpentCounter(monthKey())}})).value).toBe(40_000);
  });

  it('two retries of the same file at once: one new round, the other 409, counted once', async () => {
    const id = await upload('a.md');
    await db.kbSource.update({where: {id}, data: {state: 'failed'}});
    const results = await Promise.all([0, 1].map(() => cast.kbOnly.post(`/site-api/kb/files/${id}/retry`, {})));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.json.error).toBe('already_started');
    expect((await db.kbSource.findUniqueOrThrow({where: {id}})).round).toBe(1);
    // 1 upload + 1 retry.
    expect((await db.helpdeskCounter.findUniqueOrThrow({where: {name: kbFilesDayCounter(cast.ids.kbOnly)}})).value).toBe(2);
    expect(await db.auditEvent.count({where: {action: 'kb_file_retried'}})).toBe(1);
  });
});
