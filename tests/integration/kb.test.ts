import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {
  KbArticle,
  KbArticlesPage,
  KbCategoryPage,
  KbHome,
  KbImportResult,
  KbManageArticle,
  KbManageArticlesPage,
  KbManageCategory,
  KbSearchResult,
  KbSnippet,
  KbSnippetsPage,
} from '../../src/lib/kb-types';
import {setCacheModeForTests} from '../../src/platform/cache';
import {ensurePermissions} from '../../src/platform/permission-sync';
import {app} from '../../src/server/app';
import {CATALOGUE, PERMISSIONS} from '../../src/server/permissions';
import {deleteOldRateWindows, takeRateWindow} from '../../src/server/rate-window';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/**
 * The knowledge base against a real Postgres: who may manage it, what the public
 * help center shows (published only), the counters and chunks the manage routes
 * keep, search, feedback and the per-minute rate windows.
 * Everything is created through the manage API, so chunks and counts come from the real code.
 */
const EDITOR_ROLE = 'kbtest-editor';

/** Exactly these roles, whatever sign-up gave (the first account may have become owner). */
async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

const BODY = (word: string) =>
  `Everything about ${word}.\n\n## Before you start\n\nCheck your order number and the message we sent you about ${word}.\n\n## Step by step\n\n1. Open the page.\n2. Follow the link.\n\n## Still stuck\n\nWrite to us and we will help.`;

describe.skipIf(!DATABASE_URL)('knowledge base (integration, real Postgres)', () => {
  let editor: Browser;
  let member: Browser;
  let guest: Browser;
  let editorId: number;

  async function category(name: string, extra: Record<string, unknown> = {}): Promise<KbManageCategory> {
    const res = await editor.post('/site-api/kb/manage/categories', {name, description: `All about ${name}.`, ...extra});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.category as KbManageCategory;
  }

  async function article(input: Record<string, unknown>): Promise<KbManageArticle> {
    const res = await editor.post('/site-api/kb/manage/articles', input);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.article as KbManageArticle;
  }

  const patchArticle = (id: number, body: Record<string, unknown>) => editor.request('PATCH', `/site-api/kb/manage/articles/${id}`, body);
  const chunksOf = (articleId: number) =>
    db.kbChunk.findMany({where: {articleId}, select: {heading: true, text: true, position: true}, orderBy: {position: 'asc'}});
  const countOf = async (categoryId: number) =>
    (await db.kbCategory.findUniqueOrThrow({where: {id: categoryId}, select: {articleCount: true}})).articleCount;

  beforeAll(configureEnv);
  afterAll(async () => {
    setCacheModeForTests(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    // Public reads are cached: every test starts with an empty in-memory cache.
    setCacheModeForTests('memory');
    // A role holding site:kb:edit (resetDatabase removes non-system roles, the help desk's `agent` too).
    await ensurePermissions(db, CATALOGUE);
    const role = await db.role.create({data: {slug: EDITOR_ROLE, name: 'KB test editor', description: null}, select: {id: true}});
    const permission = await db.permission.findUniqueOrThrow({where: {codename: PERMISSIONS.KB_EDIT}, select: {id: true}});
    await db.rolePermission.create({data: {roleId: role.id, permissionId: permission.id}});

    editor = await signedIn(app, 'editor@example.test', undefined, '203.0.113.61');
    member = await signedIn(app, 'member@example.test', undefined, '203.0.113.62');
    await setRoles('editor@example.test', 'member', EDITOR_ROLE);
    await setRoles('member@example.test', 'member');
    editorId = await userId('editor@example.test');
    guest = new Browser(app, '203.0.113.63');
  });

  it('every manage route: signed out 401, member 403', async () => {
    // Valid inputs, so the validator lets them through to the guards.
    const routes: [string, string, unknown?][] = [
      ['GET', '/site-api/kb/manage/articles'],
      ['GET', '/site-api/kb/manage/articles?status=draft'],
      ['GET', '/site-api/kb/manage/articles/1'],
      ['POST', '/site-api/kb/manage/articles', {title: 'A title', categoryId: 1, body: BODY('x')}],
      ['PATCH', '/site-api/kb/manage/articles/1', {title: 'Another title'}],
      ['DELETE', '/site-api/kb/manage/articles/1'],
      ['POST', '/site-api/kb/manage/preview', {body: '## Hi\n\nThere.'}],
      ['GET', '/site-api/kb/manage/categories'],
      ['POST', '/site-api/kb/manage/categories', {name: 'Orders'}],
      ['PATCH', '/site-api/kb/manage/categories/1', {name: 'Orders and more'}],
      ['DELETE', '/site-api/kb/manage/categories/1'],
      ['GET', '/site-api/kb/manage/snippets'],
      ['POST', '/site-api/kb/manage/snippets', {question: 'Do you ship abroad?', answer: 'Yes, to the EU.'}],
      ['PATCH', '/site-api/kb/manage/snippets/1', {question: 'Do you ship abroad?', answer: 'Yes, to the EU and the UK.'}],
      ['DELETE', '/site-api/kb/manage/snippets/1'],
      ['POST', '/site-api/kb/manage/import', {rows: [{kind: 'snippet', question: 'Is it fair trade?', answer: 'Yes.'}]}],
    ];
    for (const [method, path, body] of routes) {
      expect((await guest.request(method, path, body)).status, `guest ${method} ${path}`).toBe(401);
      expect((await member.request(method, path, body)).status, `member ${method} ${path}`).toBe(403);
    }
    // Nothing was written by either.
    expect(await db.kbCategory.count()).toBe(0);
    expect(await db.kbSnippet.count()).toBe(0);
  });

  it('an editor manages categories and articles; counters, chunks and audit follow', async () => {
    const orders = await category('Orders & shipping');
    expect(orders.slug).toBe('orders-shipping');
    expect(orders.articleCount).toBe(0);
    const billing = await category('Billing', {slug: 'billing'});

    const list = await editor.get('/site-api/kb/manage/categories');
    expect(list.status).toBe(200);
    expect((list.json.categories as KbManageCategory[]).map(c => c.slug).sort()).toEqual(['billing', 'orders-shipping']);

    // A draft: no chunks, not counted.
    const draft = await article({title: 'Track your order', categoryId: orders.id, body: BODY('tracking')});
    expect(draft.slug).toBe('track-your-order');
    expect(draft.status).toBe('draft');
    expect(await chunksOf(draft.id)).toHaveLength(0);
    expect(await countOf(orders.id)).toBe(0);
    const row = await db.kbArticle.findUniqueOrThrow({where: {id: draft.id}, select: {createdBy: true, updatedBy: true}});
    expect(row).toEqual({createdBy: editorId, updatedBy: editorId});

    // Publish: chunks built, counted, publishedAt set.
    const audits = await db.auditEvent.count();
    const published = await patchArticle(draft.id, {status: 'published'});
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    expect((published.json.article as KbManageArticle).status).toBe('published');
    const chunks = await chunksOf(draft.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some(c => c.heading === 'Track your order — Step by step')).toBe(true);
    expect(await countOf(orders.id)).toBe(1);
    expect((await db.kbArticle.findUniqueOrThrow({where: {id: draft.id}, select: {publishedAt: true}})).publishedAt).not.toBeNull();
    expect(await db.auditEvent.count()).toBeGreaterThan(audits);

    // Reading it back for editing.
    const one = await editor.get(`/site-api/kb/manage/articles/${draft.id}`);
    expect(one.status).toBe(200);
    expect((one.json.article as KbManageArticle).body).toContain('## Step by step');
    const filtered = await editor.get(`/site-api/kb/manage/articles?status=published&category=${orders.id}`);
    expect(filtered.status).toBe(200);
    expect((filtered.json as unknown as KbManageArticlesPage).articles.map(a => a.id)).toEqual([draft.id]);
    expect((await editor.get('/site-api/kb/manage/articles?status=draft')).json.articles).toEqual([]);
    expect(((await editor.get('/site-api/kb/manage/articles?q=your%20order')).json.articles as unknown[]).length).toBe(1);

    // Editing the body of a published article rebuilds its chunks.
    expect((await patchArticle(draft.id, {body: '## Courier\n\nYour parcel travels with a zebracourier.'})).status).toBe(200);
    const rebuilt = await chunksOf(draft.id);
    expect(rebuilt.some(c => c.text.includes('zebracourier'))).toBe(true);
    expect(rebuilt.some(c => c.heading.endsWith('Step by step'))).toBe(false);

    // Moving a published article moves the count.
    expect((await patchArticle(draft.id, {categoryId: billing.id})).status).toBe(200);
    expect(await countOf(orders.id)).toBe(0);
    expect(await countOf(billing.id)).toBe(1);

    // Archiving: chunks gone, not counted.
    expect((await patchArticle(draft.id, {status: 'archived'})).status).toBe(200);
    expect(await chunksOf(draft.id)).toHaveLength(0);
    expect(await countOf(billing.id)).toBe(0);
    const cats = (await editor.get('/site-api/kb/manage/categories')).json.categories as KbManageCategory[];
    expect(cats.find(c => c.id === billing.id)).toMatchObject({articleCount: 0, totalArticles: 1});

    // Created straight as published: counted at once; deleting it uncounts and audits.
    const live = await article({title: 'Change your address', categoryId: orders.id, body: BODY('address'), status: 'published'});
    expect(await countOf(orders.id)).toBe(1);
    expect((await chunksOf(live.id)).length).toBeGreaterThan(0);
    const before = await db.auditEvent.count();
    expect((await editor.delete(`/site-api/kb/manage/articles/${live.id}`)).status).toBe(200);
    expect(await db.auditEvent.count()).toBeGreaterThan(before);
    expect(await countOf(orders.id)).toBe(0);
    expect(await db.kbChunk.count({where: {articleId: live.id}})).toBe(0);
    expect((await editor.get(`/site-api/kb/manage/articles/${live.id}`)).status).toBe(404);
    expect((await editor.delete(`/site-api/kb/manage/articles/${live.id}`)).status).toBe(404);

    // Category edit.
    const renamed = await editor.request('PATCH', `/site-api/kb/manage/categories/${orders.id}`, {name: 'Orders', description: 'Where is my order?'});
    expect(renamed.status).toBe(200);
    expect((renamed.json.category as KbManageCategory).name).toBe('Orders');
  });

  it('preview renders sanitized HTML', async () => {
    const res = await editor.post('/site-api/kb/manage/preview', {body: '## Grind\n\nMedium **grind**.\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))'});
    expect(res.status).toBe(200);
    const html = res.json.html as string;
    expect(html).toMatch(/<h2[^>]*>Grind<\/h2>/);
    expect(html).toContain('<strong>grind</strong>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('snippets: create, list, edit and delete, each with its one chunk', async () => {
    const made = await editor.post('/site-api/kb/manage/snippets', {question: 'Do you ship abroad?', answer: 'Yes, to the EU and the UK.'});
    expect([200, 201]).toContain(made.status);
    const snippet = made.json.snippet as KbSnippet;
    expect(snippet.question).toBe('Do you ship abroad?');
    let chunks = await db.kbChunk.findMany({where: {snippetId: snippet.id}, select: {heading: true, text: true, articleId: true}});
    expect(chunks).toEqual([{heading: 'Do you ship abroad?', text: 'Yes, to the EU and the UK.', articleId: null}]);
    const stored = await db.kbSnippet.findUniqueOrThrow({where: {id: snippet.id}, select: {createdBy: true}});
    expect(stored.createdBy).toBe(editorId);

    const page = await editor.get('/site-api/kb/manage/snippets?q=abroad');
    expect(page.status).toBe(200);
    expect((page.json as unknown as KbSnippetsPage).snippets.map(s => s.id)).toEqual([snippet.id]);

    const edited = await editor.request('PATCH', `/site-api/kb/manage/snippets/${snippet.id}`, {question: 'Do you ship abroad?', answer: 'Yes, worldwide.'});
    expect(edited.status).toBe(200);
    chunks = await db.kbChunk.findMany({where: {snippetId: snippet.id}, select: {heading: true, text: true, articleId: true}});
    expect(chunks).toEqual([{heading: 'Do you ship abroad?', text: 'Yes, worldwide.', articleId: null}]);

    const before = await db.auditEvent.count();
    expect((await editor.delete(`/site-api/kb/manage/snippets/${snippet.id}`)).status).toBe(200);
    expect(await db.auditEvent.count()).toBeGreaterThan(before);
    expect(await db.kbChunk.count()).toBe(0);
    expect((await editor.delete(`/site-api/kb/manage/snippets/${snippet.id}`)).status).toBe(404);
  });

  it('import creates draft articles with free slugs and snippets with their chunk', async () => {
    const orders = await category('Orders');
    await article({title: 'Track your order', categoryId: orders.id, body: BODY('tracking')});
    const res = await editor.post('/site-api/kb/manage/import', {
      rows: [
        {kind: 'article', title: 'Track your order', body: BODY('one'), categoryId: orders.id},
        {kind: 'article', title: 'Track your order', body: BODY('two'), categoryId: orders.id},
        {kind: 'snippet', question: 'Is the coffee fair trade?', answer: 'Yes, all of it.'},
      ],
    });
    expect([200, 201], JSON.stringify(res.json)).toContain(res.status);
    expect(res.json as unknown as KbImportResult).toEqual({created: 3, skipped: []});
    const imported = await db.kbArticle.findMany({where: {slug: {startsWith: 'track-your-order'}}, select: {slug: true, status: true}, orderBy: {id: 'asc'}});
    expect(imported).toEqual([
      {slug: 'track-your-order', status: 'draft'},
      {slug: 'track-your-order-2', status: 'draft'},
      {slug: 'track-your-order-3', status: 'draft'},
    ]);
    expect(await countOf(orders.id)).toBe(0);
    const snippet = await db.kbSnippet.findFirstOrThrow({where: {question: 'Is the coffee fair trade?'}, select: {id: true}});
    expect(await db.kbChunk.count({where: {snippetId: snippet.id}})).toBe(1);

    // More than one batch in a request is refused.
    const tooMany = Array.from({length: 51}, (_, i) => ({kind: 'snippet', question: `Question ${i}?`, answer: 'An answer.'}));
    expect((await editor.post('/site-api/kb/manage/import', {rows: tooMany})).status).toBe(422);
    expect((await editor.post('/site-api/kb/manage/import', {rows: []})).status).toBe(422);
  });

  it('validation answers 422 with field errors; taken slugs 409', async () => {
    const orders = await category('Orders');

    const noName = await editor.post('/site-api/kb/manage/categories', {name: ''});
    expect(noName.status).toBe(422);
    expect(noName.json.error).toBe('invalid_input');
    expect(typeof (noName.json.fields as Record<string, string>).name).toBe('string');

    const bad = await editor.post('/site-api/kb/manage/articles', {title: '', slug: 'Not A Slug!', categoryId: orders.id, body: BODY('x')});
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe('invalid_input');
    const fields = bad.json.fields as Record<string, string>;
    expect(typeof fields.title).toBe('string');
    expect(fields.title!.length).toBeGreaterThan(0);

    const badSlug = await editor.post('/site-api/kb/manage/articles', {title: 'Fine title', slug: 'Not A Slug!', categoryId: orders.id, body: BODY('x')});
    expect(badSlug.status).toBe(422);
    expect(typeof (badSlug.json.fields as Record<string, string>).slug).toBe('string');

    const badStatus = await editor.post('/site-api/kb/manage/articles', {title: 'Fine title', categoryId: orders.id, body: BODY('x'), status: 'live'});
    expect(badStatus.status).toBe(422);

    const tooLong = await editor.post('/site-api/kb/manage/articles', {title: 'T'.repeat(161), categoryId: orders.id, body: BODY('x')});
    expect(tooLong.status).toBe(422);
    expect(typeof (tooLong.json.fields as Record<string, string>).title).toBe('string');

    expect((await editor.post('/site-api/kb/manage/snippets', {question: '', answer: 'x'})).status).toBe(422);
    expect((await editor.post('/site-api/kb/manage/preview', {body: 'x'.repeat(50_001)})).status).toBe(422);
    // Under 50,000 characters but over 60,000 UTF-8 bytes (3 bytes each): refused, on its field.
    const wide = '語'.repeat(20_001);
    for (const res of [
      await editor.post('/site-api/kb/manage/articles', {title: 'Wide', categoryId: orders.id, body: wide}),
      await editor.post('/site-api/kb/manage/preview', {body: wide}),
    ]) {
      expect(res.status).toBe(422);
      expect((res.json.fields as Record<string, string>).body).toBe('This article is too long. Split it into two articles.');
    }
    expect((await editor.post('/site-api/kb/manage/preview', {body: '語'.repeat(20_000)})).status).toBe(200);
    expect(await db.kbArticle.count()).toBe(0);

    // Slug conflicts.
    await article({title: 'Track your order', categoryId: orders.id, body: BODY('x')});
    const dupe = await editor.post('/site-api/kb/manage/articles', {title: 'Track your order', slug: 'track-your-order', categoryId: orders.id, body: BODY('y')});
    expect(dupe.status).toBe(409);
    expect(dupe.json.error).toBe('slug_taken');
    const dupeCat = await editor.post('/site-api/kb/manage/categories', {name: 'Orders again', slug: 'orders'});
    expect(dupeCat.status).toBe(409);
    expect(dupeCat.json.error).toBe('slug_taken');
  });

  it('a category with articles cannot be deleted, an empty one can', async () => {
    const orders = await category('Orders');
    const draft = await article({title: 'Track your order', categoryId: orders.id, body: BODY('x')});

    const refused = await editor.delete(`/site-api/kb/manage/categories/${orders.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('category_not_empty');
    expect(typeof refused.json.message).toBe('string');
    expect(await db.kbCategory.count()).toBe(1);

    expect((await editor.delete(`/site-api/kb/manage/articles/${draft.id}`)).status).toBe(200);
    const before = await db.auditEvent.count();
    expect((await editor.delete(`/site-api/kb/manage/categories/${orders.id}`)).status).toBe(200);
    expect(await db.auditEvent.count()).toBeGreaterThan(before);
    expect(await db.kbCategory.count()).toBe(0);
    expect((await editor.delete(`/site-api/kb/manage/categories/${orders.id}`)).status).toBe(404);
  });

  it('the public help center shows published articles only', async () => {
    const orders = await category('Orders');
    const pub = await article({title: 'Track your order', categoryId: orders.id, body: BODY('tracking'), excerpt: 'Where your parcel is.', status: 'published'});
    const draft = await article({title: 'Secret plans', categoryId: orders.id, body: BODY('secret')});
    const sibling = await article({title: 'Returns and refunds', categoryId: orders.id, body: BODY('returns'), status: 'published'});
    // A category with no published article is not listed and its page is not found.
    const empty = await category('Billing');
    await article({title: 'Draft invoice help', categoryId: empty.id, body: BODY('invoice')});

    // The article page.
    const page = await guest.get(`/site-api/kb/articles/${pub.slug}`);
    expect(page.status).toBe(200);
    const art = page.json as unknown as KbArticle;
    expect(art).toMatchObject({id: pub.id, title: 'Track your order', slug: 'track-your-order', category: {name: 'Orders', slug: 'orders'}});
    expect(art.html).toMatch(/<h2[^>]*>Step by step<\/h2>/);
    expect(art.headings.map(h => h.text)).toEqual(['Before you start', 'Step by step', 'Still stuck']);
    for (const h of art.headings) expect(art.html).toContain(`id="${h.id}"`);
    expect(art.publishedAt).not.toBeNull();
    expect(art.related.map(r => r.slug)).toEqual([sibling.slug]);
    // The side nav: the category's published articles, this one included, A–Z; never a draft.
    expect(art.siblings).toEqual([
      {title: 'Returns and refunds', slug: sibling.slug},
      {title: 'Track your order', slug: 'track-your-order'},
    ]);
    // Nothing internal on a public route.
    const raw = JSON.stringify(page.json);
    for (const field of ['createdBy', 'updatedBy', '"body"', 'helpfulCount', 'viewCount', 'email', '"status"']) expect(raw).not.toContain(field);

    // A draft is not found, wherever it's asked for.
    const hidden = await guest.get(`/site-api/kb/articles/${draft.slug}`);
    expect(hidden.status).toBe(404);
    expect(hidden.json.error).toBe('not_found');
    expect((await guest.get('/site-api/kb/articles/no-such-article')).status).toBe(404);
    expect((await guest.get('/site-api/kb/categories/no-such-category')).status).toBe(404);
    expect((await guest.get(`/site-api/kb/categories/${empty.slug}`)).status).toBe(404);

    const cat = await guest.get('/site-api/kb/categories/orders');
    expect(cat.status).toBe(200);
    const catPage = cat.json as unknown as KbCategoryPage;
    expect(catPage.category).toMatchObject({slug: 'orders', articleCount: 2});
    expect(catPage.articles.map(a => a.slug)).toEqual([sibling.slug, 'track-your-order']);

    const all = await guest.get('/site-api/kb/categories');
    expect(all.status).toBe(200);
    expect(all.json.categories).toEqual([expect.objectContaining({slug: 'orders', articleCount: 2})]);

    const paged = await guest.get('/site-api/kb/articles?category=orders');
    expect(paged.status).toBe(200);
    expect((paged.json as unknown as KbArticlesPage).articles.map(a => a.slug)).toEqual([sibling.slug, 'track-your-order']);
    expect((paged.json as unknown as KbArticlesPage).next).toBeNull();

    const home = await guest.get('/site-api/kb/home');
    expect(home.status).toBe(200);
    const kbHome = home.json as unknown as KbHome;
    expect(typeof kbHome.title).toBe('string');
    expect(typeof kbHome.intro).toBe('string');
    expect(kbHome.categories.map(c => c.slug)).toEqual(['orders']);
    expect(kbHome.popular.map(a => a.slug).sort()).toEqual([sibling.slug, 'track-your-order'].sort());

    const sitemap = await guest.get('/site-api/kb/sitemap');
    expect(sitemap.status).toBe(200);
    expect((sitemap.json.articles as {slug: string}[]).map(a => a.slug)).toEqual([sibling.slug, 'track-your-order']);
    expect((sitemap.json.categories as {slug: string}[]).map(c => c.slug)).toEqual(['orders']);

    // Unpublishing clears the cached public copies at once, and is audited.
    expect((await patchArticle(pub.id, {status: 'draft'})).status).toBe(200);
    expect(await db.auditEvent.count({where: {action: 'kb_article_unpublished', targetId: String(pub.id)}})).toBe(1);
    expect((await guest.get(`/site-api/kb/articles/${pub.slug}`)).status).toBe(404);
    expect(((await guest.get('/site-api/kb/categories/orders')).json as unknown as KbCategoryPage).articles.map(a => a.slug)).toEqual([sibling.slug]);
    expect(((await guest.get('/site-api/kb/home')).json as unknown as KbHome).popular.map(a => a.slug)).toEqual([sibling.slug]);
    // Its last published article gone, the category leaves every public list and its page is not found.
    expect((await patchArticle(sibling.id, {status: 'archived'})).status).toBe(200);
    expect((await guest.get('/site-api/kb/categories/orders')).status).toBe(404);
    expect(((await guest.get('/site-api/kb/home')).json as unknown as KbHome).categories).toEqual([]);
    expect((await guest.get('/site-api/kb/categories')).json.categories).toEqual([]);
    expect((await guest.get('/site-api/kb/sitemap')).json.categories).toEqual([]);
  });

  it('paged public list: 20 a page, keyset, newest first', async () => {
    const orders = await category('Orders');
    for (let i = 0; i < 22; i++) {
      await article({title: `Article number ${i}`, categoryId: orders.id, body: BODY(`n${i}`), status: 'published'});
    }
    const first = (await guest.get('/site-api/kb/articles?category=orders')).json as unknown as KbArticlesPage;
    expect(first.articles).toHaveLength(20);
    expect(first.articles[0]!.slug).toBe('article-number-21');
    expect(first.next).not.toBeNull();
    const second = (await guest.get(`/site-api/kb/articles?category=orders&before=${first.next}`)).json as unknown as KbArticlesPage;
    expect(second.articles.map(a => a.slug)).toEqual(['article-number-1', 'article-number-0']);
    expect(second.next).toBeNull();
  });

  it('feedback and views count on published articles only', async () => {
    const orders = await category('Orders');
    const pub = await article({title: 'Track your order', categoryId: orders.id, body: BODY('x'), status: 'published'});
    const draft = await article({title: 'Secret plans', categoryId: orders.id, body: BODY('y')});

    expect((await guest.post(`/site-api/kb/articles/${pub.id}/feedback`, {helpful: true})).status).toBe(200);
    expect((await guest.post(`/site-api/kb/articles/${pub.id}/feedback`, {helpful: true})).status).toBe(200);
    const no = await member.post(`/site-api/kb/articles/${pub.id}/feedback`, {helpful: false});
    expect(no.status).toBe(200);
    expect(no.json).toEqual({ok: true});
    expect((await guest.post(`/site-api/kb/articles/${pub.id}/feedback`, {helpful: 'yes'})).status).toBe(422);
    expect((await guest.post(`/site-api/kb/articles/${draft.id}/feedback`, {helpful: true})).status).toBe(404);
    expect((await guest.post('/site-api/kb/articles/999999/feedback', {helpful: true})).status).toBe(404);

    expect((await guest.post(`/site-api/kb/articles/${pub.id}/view`)).status).toBe(200);
    expect((await guest.post(`/site-api/kb/articles/${pub.id}/view`)).status).toBe(200);
    await guest.post(`/site-api/kb/articles/${draft.id}/view`);

    const counts = (id: number) =>
      db.kbArticle.findUniqueOrThrow({where: {id}, select: {helpfulCount: true, notHelpfulCount: true, viewCount: true}});
    // The guest's second vote on the same article within the minute is answered but not counted.
    expect(await counts(pub.id)).toEqual({helpfulCount: 1, notHelpfulCount: 1, viewCount: 2});

    // Views: 5 a minute per client, then still 200 but not counted.
    for (let i = 0; i < 6; i++) expect((await member.post(`/site-api/kb/articles/${pub.id}/view`)).status).toBe(200);
    expect((await counts(pub.id)).viewCount).toBe(2 + 5);
    // Feedback: 10 a minute per client, then 429.
    const other = await article({title: 'Other article', categoryId: orders.id, body: BODY('z'), status: 'published'});
    // The member's 2nd to 10th votes this minute (one on pub above), then the 11th is refused.
    for (let i = 0; i < 9; i++) await member.post(`/site-api/kb/articles/${other.id}/feedback`, {helpful: true});
    const voted = await member.post(`/site-api/kb/articles/${other.id}/feedback`, {helpful: true});
    expect(voted.status).toBe(429);
    expect(voted.json.error).toBe('rate_limited');
    expect(await counts(draft.id)).toEqual({helpfulCount: 0, notHelpfulCount: 0, viewCount: 0});
  });

  it('search finds published articles, never drafts or snippets', async () => {
    const orders = await category('Orders');
    const pub = await article({title: 'Descaling your machine', categoryId: orders.id, body: BODY('portafilter'), status: 'published'});
    await article({title: 'Unreleased blend', categoryId: orders.id, body: BODY('zanzibarite')});
    await editor.post('/site-api/kb/manage/snippets', {question: 'What is quuxberry?', answer: 'A quuxberry is a test word.'});

    const found = await guest.get('/site-api/kb/search?q=portafilter');
    expect(found.status).toBe(200);
    const result = found.json as unknown as KbSearchResult;
    expect(result.query).toBe('portafilter');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({title: pub.title, slug: pub.slug, category: {name: 'Orders', slug: 'orders'}});
    expect(result.hits[0]!.snippet).not.toMatch(/[<>«»]/);

    // The title is searchable too, case-insensitively.
    expect(((await guest.get('/site-api/kb/search?q=DESCALING')).json as unknown as KbSearchResult).hits.map(h => h.slug)).toEqual([pub.slug]);
    expect(((await guest.get('/site-api/kb/search?q=zanzibarite')).json as unknown as KbSearchResult).hits).toEqual([]);
    expect(((await guest.get('/site-api/kb/search?q=quuxberry')).json as unknown as KbSearchResult).hits).toEqual([]);
    // Too short: no search at all.
    const short = await guest.get('/site-api/kb/search?q=a');
    expect(short.status).toBe(200);
    expect((short.json as unknown as KbSearchResult).hits).toEqual([]);
    // Odd input is never an error.
    expect((await guest.get(`/site-api/kb/search?q=${encodeURIComponent('"unclosed -or & | ! (')}`)).status).toBe(200);

    // Unpublished: gone from search.
    await patchArticle(pub.id, {status: 'archived'});
    expect(((await guest.get('/site-api/kb/search?q=portafilter')).json as unknown as KbSearchResult).hits).toEqual([]);
  });

  it('rate windows: a limit per minute, then 429 on search', async () => {
    expect(await takeRateWindow(db, 'kbtest-bucket', 3)).toBe(true);
    expect(await takeRateWindow(db, 'kbtest-bucket', 3)).toBe(true);
    expect(await takeRateWindow(db, 'kbtest-bucket', 3)).toBe(true);
    expect(await takeRateWindow(db, 'kbtest-bucket', 3)).toBe(false);
    expect(await takeRateWindow(db, 'kbtest-other', 3)).toBe(true);

    // One client: 30 searches a minute, the 31st is refused (another client still searches).
    let limited = await guest.get('/site-api/kb/search?q=coffee');
    for (let i = 1; i <= 30 && limited.status === 200; i++) limited = await guest.get('/site-api/kb/search?q=coffee');
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect(limited.json.message).toBe('Too many searches right now. Try again in a minute.');
    expect((await member.get('/site-api/kb/search?q=coffee')).status).toBe(200);
    // Per-client buckets hold a hash, never the IP.
    const buckets = (await db.rateWindow.findMany({select: {bucket: true}})).map(row => row.bucket);
    expect(buckets.some(bucket => /^s:[0-9a-f]{16}$/.test(bucket))).toBe(true);
    expect(buckets.join(' ')).not.toContain('203.0.113');
  });

  it('3000 searches a minute site-wide, then 429 for everyone', async () => {
    // Full this minute (and the next, in case the minute turns mid-test).
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count")
      VALUES ('kb-search', date_trunc('minute', now()), 3000), ('kb-search', date_trunc('minute', now()) + interval '1 minute', 3000)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = 3000`;
    expect((await guest.get('/site-api/kb/search?q=coffee')).status).toBe(429);
    expect((await member.get('/site-api/kb/search?q=coffee')).status).toBe(429);
  });

  it('the cleanup job deletes minutes older than an hour, and only those', async () => {
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count")
      SELECT 'kbtest-old-' || g, date_trunc('minute', now()) - interval '2 hours', 1 FROM generate_series(1, 7) g`;
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count")
      VALUES ('kbtest-recent', date_trunc('minute', now()) - interval '30 minutes', 1), ('kbtest-now', date_trunc('minute', now()), 1)`;
    expect(await deleteOldRateWindows(db)).toBe(7);
    expect(await deleteOldRateWindows(db)).toBe(0);
    expect((await db.rateWindow.findMany({select: {bucket: true}, orderBy: {bucket: 'asc'}})).map(row => row.bucket)).toEqual([
      'kbtest-now',
      'kbtest-recent',
    ]);
  });
});
