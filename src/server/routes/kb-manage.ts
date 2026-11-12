import type {Context} from 'hono';
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  KB_LIMITS,
  type KbImportResult,
  type KbManageArticle,
  type KbManageArticleRow,
  type KbManageArticlesPage,
  type KbManageCategory,
  type KbSnippet,
  type KbSnippetsPage,
  SLUG_RE,
  slugify,
} from '../../lib/kb-types';
import {markdownToText} from '../../lib/markdown';
import {audit} from '../../platform/auth';
import {cache} from '../../platform/cache';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {chunkArticle, chunkSnippet, cut} from '../kb/chunks';
import {KB_CACHE_PREFIX} from '../kb/keys';
import {renderArticleHtml} from '../kb/render';
import {PERMISSIONS} from '../permissions';

/**
 * The knowledge base, for its editors (`site:kb:edit`), from the dashboard.
 * Mounted at `/site-api/kb/manage` (src/server/app.ts), BEFORE the public `/kb`.
 *
 *   GET    /articles?status=&category=&q=&before=   every article, any status (20, id desc)
 *   GET    /articles/:id                            one article, for editing
 *   POST   /articles                                create (draft unless `status` says otherwise)
 *   PATCH  /articles/:id                            edit, publish, unpublish, archive
 *   DELETE /articles/:id                            delete (audited)
 *   POST   /preview {body}                          the Markdown as sanitized HTML
 *   GET    /categories                              every category (≤ 100, position, id)
 *   POST   /categories · PATCH/DELETE /categories/:id
 *   GET    /snippets?q=&before=                     snippets (20, id desc)
 *   POST   /snippets · PATCH/DELETE /snippets/:id
 *   POST   /import {rows}                           1–50 rows: articles (as drafts) and snippets
 *
 * Write rules (one transaction per write): only PUBLISHED articles have chunks
 * (`kb_chunks`, what search reads) and count in their category's
 * `articleCount`. Publishing builds the chunks and adds one to the count;
 * leaving `published` deletes them and takes one away; moving a published
 * article moves the count; editing a published article's title or body
 * rebuilds its chunks. A snippet always has its one chunk. Editing the title
 * or body sets `lastReviewedAt`. Every article write is conditional on the
 * status and category it was read with, so two editors can't count twice.
 * After a write that changes what the public help center shows, the `kb:`
 * cache is cleared (after commit, never inside the transaction), together with
 * its audit row (Promise.all). Audited: kb_article_published / _archived /
 * _unpublished (published → draft) / _deleted, kb_category_updated
 * ({slugChanged}) / _deleted, kb_snippet_deleted, kb_imported.
 *
 * A body is at most KB_LIMITS.articleBody characters AND articleBodyBytes UTF-8
 * bytes (the Site API refuses requests over 64 KB).
 */

const PAGE = 20;
const canEdit = requirePermission(PERMISSIONS.KB_EDIT);

/** `/help/articles/` and `/help/search/` are pages of their own: never a category's slug. */
const RESERVED_CATEGORY_SLUGS = new Set(['articles', 'search']);
/** A name from ICON_NAMES (src/portal/ui/icon.tsx): checked by shape here, the dashboard picks from the list. */
const ICON_RE = /^[a-z][a-z0-9-]{0,29}$/;

type Fields = Record<string, string>;

const idOf = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

const codeOf = (error: unknown) => (error as {code?: unknown} | null)?.code;

const invalid = (c: Context, fields: Fields) =>
  c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);

const notFound = (c: Context, what: string) => c.json(problem('not_found', `No such ${what}.`), 404);

const slugTaken = (c: Context) =>
  c.json({...problem('slug_taken', 'That slug is already used. Pick another.'), fields: {slug: 'That slug is already used. Pick another.'}}, 409);

const changedMeanwhile = (c: Context) =>
  c.json(problem('changed', 'This article was changed meanwhile. Reload it and try again.'), 409);

/** Clears every public knowledge-base read (home, categories, articles, sitemap). Never throws. */
const clearPublicCache = () => cache.delPrefix(KB_CACHE_PREFIX).catch(() => false);

/** `slug`, else `slug-2`, `slug-3`… not in `used` (added to it), at most `max` long. */
function freeSlug(base: string, used: Set<string>, max: number): string {
  let slug = base.slice(0, max);
  for (let n = 2; used.has(slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  used.add(slug);
  return slug;
}

/** A random fallback when a free slug was taken meanwhile. */
const randomSlug = (base: string, max: number) => `${base.slice(0, max - 9).replace(/-+$/, '')}-${crypto.randomUUID().slice(0, 8)}`;

/** Slugs in use that a candidate from `bases` could collide with (`base`, `base-…`). One read. */
async function articleSlugsLike(db: PrismaClient, bases: string[]): Promise<Set<string>> {
  if (!bases.length) return new Set();
  const rows = await db.kbArticle.findMany({
    select: {slug: true},
    where: {OR: bases.flatMap(base => [{slug: base}, {slug: {startsWith: `${base}-`}}])},
    take: 1000,
  });
  return new Set(rows.map(row => row.slug));
}

async function categorySlugsLike(db: PrismaClient, base: string): Promise<Set<string>> {
  const rows = await db.kbCategory.findMany({
    select: {slug: true},
    where: {OR: [{slug: base}, {slug: {startsWith: `${base}-`}}]},
    take: 200,
  });
  return new Set([...rows.map(row => row.slug), ...RESERVED_CATEGORY_SLUGS]);
}

/** A plain-text excerpt (≤ 200 characters) for an article saved without one. */
/** The summary under a title when the editor wrote none: the first plain paragraph, so headings
 * and list items never run together ("Why it happens A noisy grinder…"). */
const NOT_A_PARAGRAPH = /^\s{0,3}(?:#|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/;
function excerptOf(body: string): string {
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const paragraph = blocks.find(block => block.trim() && !NOT_A_PARAGRAPH.test(block));
  const text = markdownToText(paragraph ?? body).replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  const at = text.lastIndexOf(' ', 199);
  return `${cut(text, at > 100 ? at : 199).trimEnd()}…`;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const given = (v: Record<string, unknown>, key: string) => v[key] !== undefined && v[key] !== null;
const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

// ------------------------------------------------------------------ articles --

type ArticleFields = {
  title?: string;
  slug?: string;
  categoryId?: number;
  body?: string;
  excerpt?: string;
  status?: ArticleStatus;
};

const BODY_MESSAGE = `Write the article: 1 to ${KB_LIMITS.articleBody.toLocaleString('en-US')} characters.`;
const BODY_TOO_BIG_MESSAGE = 'This article is too long. Split it into two articles.';
const utf8 = new TextEncoder();
/** Over KB_LIMITS.articleBodyBytes in UTF-8: a body near 50,000 characters of non-Latin text would
 * otherwise pass the character check and still break the Site API's 64 KB request limit. */
const bodyTooBig = (body: string) =>
  body.length * 3 > KB_LIMITS.articleBodyBytes && utf8.encode(body).length > KB_LIMITS.articleBodyBytes;

/** Checks an article's fields; `partial` (PATCH) checks only the ones sent. */
function readArticle(v: Record<string, unknown>, partial: boolean): {out: ArticleFields; fields: Fields} {
  const out: ArticleFields = {};
  const fields: Fields = {};
  if (given(v, 'title') || !partial) {
    const title = str(v.title).trim();
    if (!title || title.length > KB_LIMITS.articleTitle) fields.title = `A title needs 1 to ${KB_LIMITS.articleTitle} characters.`;
    else out.title = title;
  }
  if (given(v, 'slug')) {
    const slug = str(v.slug).trim().toLowerCase();
    if (slug && (slug.length > KB_LIMITS.articleSlug || !SLUG_RE.test(slug))) {
      fields.slug = `Use lower-case letters, digits and single dashes (up to ${KB_LIMITS.articleSlug}).`;
    } else if (slug) out.slug = slug;
  }
  if (given(v, 'categoryId') || !partial) {
    const categoryId = idOf(v.categoryId);
    if (!categoryId) fields.categoryId = 'Pick a category.';
    else out.categoryId = categoryId;
  }
  if (given(v, 'body') || !partial) {
    const body = str(v.body).replace(/\r\n?/g, '\n');
    if (!body.trim() || body.length > KB_LIMITS.articleBody) fields.body = BODY_MESSAGE;
    else if (bodyTooBig(body)) fields.body = BODY_TOO_BIG_MESSAGE;
    else out.body = body;
  }
  if (given(v, 'excerpt')) {
    const excerpt = typeof v.excerpt === 'string' ? v.excerpt.replace(/\s+/g, ' ').trim() : null;
    if (excerpt === null || excerpt.length > KB_LIMITS.articleExcerpt) {
      fields.excerpt = `An excerpt is up to ${KB_LIMITS.articleExcerpt} characters.`;
    } else out.excerpt = excerpt;
  }
  if (given(v, 'status')) {
    if (!(ARTICLE_STATUSES as readonly unknown[]).includes(v.status)) fields.status = 'Pick draft, published or archived.';
    else out.status = v.status as ArticleStatus;
  }
  return {out, fields};
}

const articleBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const {out, fields} = readArticle(objectOf(value), partial);
    return Object.keys(fields).length ? invalid(c, fields) : out;
  });

const articlesQuery = validator('query', value => ({
  status: (ARTICLE_STATUSES as readonly unknown[]).includes(value.status) ? (value.status as ArticleStatus) : ('' as const),
  // Strings here, parsed in the handler: the typed client sends query values as strings.
  category: typeof value.category === 'string' ? value.category : '',
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 80) : '',
  before: typeof value.before === 'string' ? value.before : '',
}));

const articleRowSelect = {
  id: true,
  title: true,
  slug: true,
  status: true,
  helpfulCount: true,
  notHelpfulCount: true,
  viewCount: true,
  updatedAt: true,
  lastReviewedAt: true,
  category: {select: {id: true, name: true}},
} as const;
const articleSelect = {...articleRowSelect, body: true, excerpt: true} as const;

type ArticleRowData = {
  id: number;
  title: string;
  slug: string;
  status: string;
  helpfulCount: number;
  notHelpfulCount: number;
  viewCount: number;
  updatedAt: Date;
  lastReviewedAt: Date;
  category: {id: number; name: string};
};

const toArticleRow = (row: ArticleRowData): KbManageArticleRow => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  status: row.status as ArticleStatus,
  category: {id: row.category.id, name: row.category.name},
  helpfulCount: row.helpfulCount,
  notHelpfulCount: row.notHelpfulCount,
  viewCount: row.viewCount,
  updatedAt: row.updatedAt.toISOString(),
  lastReviewedAt: row.lastReviewedAt.toISOString(),
});

const toArticle = (row: ArticleRowData & {body: string; excerpt: string}): KbManageArticle => ({
  ...toArticleRow(row),
  body: row.body,
  excerpt: row.excerpt,
});

/** The audit action for a status change `from` → `to`, when that is worth recording. */
const statusAction = (from: string, to: string) =>
  to === 'published'
    ? 'kb_article_published'
    : to === 'archived'
      ? 'kb_article_archived'
      : from === 'published' && to === 'draft'
        ? 'kb_article_unpublished'
        : null;

// ---------------------------------------------------------------- categories --

type CategoryFields = {name?: string; slug?: string; description?: string; icon?: string; position?: number};

const SLUG_RESERVED_MESSAGE = 'That address is used by the help center. Pick another slug.';

const categoryBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const v = objectOf(value);
    const out: CategoryFields = {};
    const fields: Fields = {};
    if (given(v, 'name') || !partial) {
      const name = str(v.name).trim();
      if (!name || name.length > KB_LIMITS.categoryName) fields.name = `A name needs 1 to ${KB_LIMITS.categoryName} characters.`;
      else out.name = name;
    }
    if (given(v, 'slug')) {
      const slug = str(v.slug).trim().toLowerCase();
      if (slug && (slug.length > KB_LIMITS.categorySlug || !SLUG_RE.test(slug))) {
        fields.slug = `Use lower-case letters, digits and single dashes (up to ${KB_LIMITS.categorySlug}).`;
      } else if (slug && RESERVED_CATEGORY_SLUGS.has(slug)) fields.slug = SLUG_RESERVED_MESSAGE;
      else if (slug) out.slug = slug;
    }
    if (given(v, 'description') || !partial) {
      const description = typeof v.description === 'string' ? v.description.replace(/\s+/g, ' ').trim() : v.description == null ? '' : null;
      if (description === null || description.length > KB_LIMITS.categoryDescription) {
        fields.description = `A description is up to ${KB_LIMITS.categoryDescription} characters.`;
      } else out.description = description;
    }
    if (given(v, 'icon')) {
      const icon = str(v.icon).trim();
      if (!ICON_RE.test(icon)) fields.icon = 'Pick an icon from the list.';
      else out.icon = icon;
    }
    if (given(v, 'position')) {
      const position = typeof v.position === 'number' ? v.position : typeof v.position === 'string' && v.position.trim() ? Number(v.position) : NaN;
      if (!Number.isSafeInteger(position) || position < 0 || position > 9999) fields.position = 'Use a whole number from 0 to 9999.';
      else out.position = position;
    }
    return Object.keys(fields).length ? invalid(c, fields) : out;
  });

const categorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  icon: true,
  position: true,
  articleCount: true,
  // Admin screen only, ≤ 100 categories: one joined count on kb_articles(category_id, …).
  _count: {select: {articles: true}},
} as const;

const toCategory = (row: {
  id: number;
  name: string;
  slug: string;
  description: string;
  icon: string;
  position: number;
  articleCount: number;
  _count: {articles: number};
}): KbManageCategory => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  icon: row.icon,
  position: row.position,
  articleCount: row.articleCount,
  totalArticles: row._count.articles,
});

// ------------------------------------------------------------------ snippets --

type SnippetFields = {question?: string; answer?: string};

function readSnippet(v: Record<string, unknown>, partial: boolean): {out: SnippetFields; fields: Fields} {
  const out: SnippetFields = {};
  const fields: Fields = {};
  if (given(v, 'question') || !partial) {
    const question = str(v.question).replace(/\s+/g, ' ').trim();
    if (!question || question.length > KB_LIMITS.snippetQuestion) {
      fields.question = `A question needs 1 to ${KB_LIMITS.snippetQuestion} characters.`;
    } else out.question = question;
  }
  if (given(v, 'answer') || !partial) {
    const answer = str(v.answer).replace(/\r\n?/g, '\n').trim();
    if (!answer || answer.length > KB_LIMITS.snippetAnswer) fields.answer = `An answer needs 1 to ${KB_LIMITS.snippetAnswer} characters.`;
    else out.answer = answer;
  }
  return {out, fields};
}

const snippetBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const {out, fields} = readSnippet(objectOf(value), partial);
    return Object.keys(fields).length ? invalid(c, fields) : out;
  });

const snippetSelect = {id: true, question: true, answer: true, updatedAt: true} as const;

const toSnippet = (row: {id: number; question: string; answer: string; updatedAt: Date}): KbSnippet => ({
  id: row.id,
  question: row.question,
  answer: row.answer,
  updatedAt: row.updatedAt.toISOString(),
});

// -------------------------------------------------------------------- routes --

export const kbManageRoutes = new Hono()
  // ---- articles ----------------------------------------------------------------
  // Indexes: kb_articles(status, id), kb_articles(category_id, status, id). `q` is a title
  // `contains`: fine for a knowledge base of hundreds to a few thousand articles.
  .get('/articles', articlesQuery, withViewer, requireAuth, canEdit, withDb, async c => {
    const query = c.req.valid('query');
    const {status, q} = query;
    const category = idOf(query.category);
    const before = idOf(query.before);
    const rows = await c.var.db.kbArticle.findMany({
      select: articleRowSelect,
      where: {
        ...(status ? {status} : {}),
        ...(category ? {categoryId: category} : {}),
        ...(q ? {title: {contains: q, mode: 'insensitive' as const}} : {}),
        ...(before ? {id: {lt: before}} : {}),
      },
      orderBy: {id: 'desc'},
      take: PAGE + 1,
    });
    const articles = rows.slice(0, PAGE).map(toArticleRow);
    const page: KbManageArticlesPage = {articles, next: rows.length > PAGE ? articles.at(-1)!.id : null};
    return c.json(page);
  })

  .get('/articles/:id', withViewer, requireAuth, canEdit, withDb, async c => {
    const id = idOf(c.req.param('id'));
    const row = id ? await c.var.db.kbArticle.findUnique({where: {id}, select: articleSelect}) : null;
    if (!row) return notFound(c, 'article');
    return c.json({article: toArticle(row)});
  })

  .post('/articles', articleBody(false), withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const input = c.req.valid('json') as ArticleFields & {title: string; categoryId: number; body: string};
    const me = c.var.viewer.id!;
    const status: ArticleStatus = input.status ?? 'draft';
    const published = status === 'published';
    const max = KB_LIMITS.articleSlug;
    const base = slugify(input.title, max) || 'article';
    const explicit = Boolean(input.slug);
    const slug = input.slug ?? freeSlug(base, await articleSlugsLike(db, [base]), max);
    const now = new Date();
    const chunks = published ? chunkArticle(input.title, input.body) : [];

    const save = (slugToUse: string) =>
      db.$transaction(async tx => {
        const row = await tx.kbArticle.create({
          data: {
            categoryId: input.categoryId,
            title: input.title,
            slug: slugToUse,
            body: input.body,
            excerpt: input.excerpt || excerptOf(input.body),
            status,
            publishedAt: published ? now : null,
            lastReviewedAt: now,
            createdBy: me,
            updatedBy: me,
            chunks: chunks.length ? {createMany: {data: chunks}} : undefined,
          },
          select: articleSelect,
        });
        if (published) {
          await tx.kbCategory.update({where: {id: input.categoryId}, data: {articleCount: {increment: 1}}, select: {id: true}});
        }
        return row;
      });

    let row;
    try {
      try {
        row = await save(slug);
      } catch (error) {
        // An auto-made slug taken meanwhile: one more try with a random tail (a P2002 wrote nothing).
        if (codeOf(error) !== 'P2002' || explicit) throw error;
        row = await save(randomSlug(base, max));
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === 'P2002') return slugTaken(c);
      if (code === 'P2003' || code === 'P2025') return invalid(c, {categoryId: 'That category no longer exists. Pick another.'});
      throw error;
    }
    if (published) {
      await Promise.all([clearPublicCache(), audit(db, {actorUserId: me, action: 'kb_article_published', target: ['kb_article', row.id]})]);
    }
    return c.json({article: toArticle(row)}, 201);
  })

  .patch('/articles/:id', articleBody(true), withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'article');
    const input = c.req.valid('json');
    const me = c.var.viewer.id!;
    const current = await db.kbArticle.findUnique({
      where: {id},
      select: {id: true, title: true, body: true, status: true, categoryId: true, publishedAt: true},
    });
    if (!current) return notFound(c, 'article');

    const title = input.title ?? current.title;
    const body = input.body ?? current.body;
    const status = input.status ?? (current.status as ArticleStatus);
    const categoryId = input.categoryId ?? current.categoryId;
    const wasPublished = current.status === 'published';
    const isPublished = status === 'published';
    const moved = categoryId !== current.categoryId;
    const contentChanged = title !== current.title || body !== current.body;
    const rebuild = isPublished && (!wasPublished || contentChanged);
    const dropChunks = rebuild || (wasPublished && !isPublished);
    const now = new Date();

    let row;
    try {
      row = await db.$transaction(async tx => {
        if (dropChunks) await tx.kbChunk.deleteMany({where: {articleId: id}});
        // Conditional on what was read: a concurrent status or category change makes this P2025.
        const updated = await tx.kbArticle.update({
          where: {id, status: current.status, categoryId: current.categoryId},
          data: {
            title: input.title,
            slug: input.slug,
            categoryId: input.categoryId,
            body: input.body,
            excerpt: input.excerpt === undefined ? undefined : input.excerpt || excerptOf(body),
            status: input.status,
            publishedAt: isPublished && !wasPublished && !current.publishedAt ? now : undefined,
            lastReviewedAt: contentChanged ? now : undefined,
            updatedBy: me,
            chunks: rebuild ? {createMany: {data: chunkArticle(title, body)}} : undefined,
          },
          select: articleSelect,
        });
        if (wasPublished && (!isPublished || moved)) {
          await tx.kbCategory.updateMany({
            where: {id: current.categoryId, articleCount: {gt: 0}},
            data: {articleCount: {decrement: 1}},
          });
        }
        if (isPublished && (!wasPublished || moved)) {
          await tx.kbCategory.update({where: {id: categoryId}, data: {articleCount: {increment: 1}}, select: {id: true}});
        }
        return updated;
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'P2002') return slugTaken(c);
      if (code === 'P2003') return invalid(c, {categoryId: 'That category no longer exists. Pick another.'});
      if (code === 'P2025') return changedMeanwhile(c);
      throw error;
    }

    const action = status !== current.status ? statusAction(current.status, status) : null;
    await Promise.all([
      wasPublished || isPublished ? clearPublicCache() : null,
      action ? audit(db, {actorUserId: me, action, target: ['kb_article', id]}) : null,
    ]);
    return c.json({article: toArticle(row)});
  })

  .delete('/articles/:id', withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'article');
    const current = await db.kbArticle.findUnique({where: {id}, select: {id: true, status: true, categoryId: true}});
    if (!current) return notFound(c, 'article');
    const wasPublished = current.status === 'published';
    try {
      // Its chunks go with it (ON DELETE CASCADE).
      await db.$transaction(async tx => {
        await tx.kbArticle.delete({where: {id, status: current.status, categoryId: current.categoryId}, select: {id: true}});
        if (wasPublished) {
          await tx.kbCategory.updateMany({
            where: {id: current.categoryId, articleCount: {gt: 0}},
            data: {articleCount: {decrement: 1}},
          });
        }
      });
    } catch (error) {
      if (codeOf(error) === 'P2025') return changedMeanwhile(c);
      throw error;
    }
    await Promise.all([
      wasPublished ? clearPublicCache() : null,
      audit(db, {actorUserId: c.var.viewer.id, action: 'kb_article_deleted', target: ['kb_article', id], meta: {status: current.status}}),
    ]);
    return c.json({ok: true});
  })

  .post(
    '/preview',
    validator('json', (value, c) => {
      const body = objectOf(value).body;
      if (typeof body !== 'string' || body.length > KB_LIMITS.articleBody) return invalid(c, {body: BODY_MESSAGE});
      const normalized = body.replace(/\r\n?/g, '\n');
      if (bodyTooBig(normalized)) return invalid(c, {body: BODY_TOO_BIG_MESSAGE});
      return {body: normalized};
    }),
    withViewer,
    requireAuth,
    canEdit,
    c => {
      const {body} = c.req.valid('json');
      // Rendered, sanitized and heading ids restored (src/server/kb/render.ts), like the public page.
      return c.json({html: renderArticleHtml(body).html});
    }
  )

  // ---- categories --------------------------------------------------------------
  .get('/categories', withViewer, requireAuth, canEdit, withDb, async c => {
    const rows = await c.var.db.kbCategory.findMany({
      select: categorySelect,
      orderBy: [{position: 'asc'}, {id: 'asc'}],
      take: 100,
    });
    return c.json({categories: rows.map(toCategory)});
  })

  .post('/categories', categoryBody(false), withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const input = c.req.valid('json') as CategoryFields & {name: string};
    const max = KB_LIMITS.categorySlug;
    let base = slugify(input.name, max) || 'category';
    if (RESERVED_CATEGORY_SLUGS.has(base)) base = `${base}-topics`;
    const explicit = Boolean(input.slug);
    const slug = input.slug ?? freeSlug(base, await categorySlugsLike(db, base), max);
    const save = (slugToUse: string) =>
      db.kbCategory.create({
        data: {
          name: input.name,
          slug: slugToUse,
          description: input.description ?? '',
          icon: input.icon ?? 'book',
          position: input.position ?? 0,
        },
        select: categorySelect,
      });
    let row;
    try {
      try {
        row = await save(slug);
      } catch (error) {
        if (codeOf(error) !== 'P2002' || explicit) throw error;
        row = await save(randomSlug(base, max));
      }
    } catch (error) {
      if (codeOf(error) === 'P2002') return slugTaken(c);
      throw error;
    }
    // A new category is empty: nothing public changes until an article in it is published.
    return c.json({category: toCategory(row)}, 201);
  })

  .patch('/categories/:id', categoryBody(true), withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'category');
    const input = c.req.valid('json');
    // The slug before, only when a new one is sent (for the audit's slugChanged).
    const before = input.slug ? await db.kbCategory.findUnique({where: {id}, select: {slug: true}}) : null;
    let row;
    try {
      row = await db.kbCategory.update({
        where: {id},
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description,
          icon: input.icon,
          position: input.position,
        },
        select: categorySelect,
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'P2002') return slugTaken(c);
      if (code === 'P2025') return notFound(c, 'category');
      throw error;
    }
    await Promise.all([
      clearPublicCache(),
      audit(db, {
        actorUserId: c.var.viewer.id,
        action: 'kb_category_updated',
        target: ['kb_category', id],
        meta: {slugChanged: Boolean(before && before.slug !== row.slug)},
      }),
    ]);
    return c.json({category: toCategory(row)});
  })

  .delete('/categories/:id', withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'category');
    const current = await db.kbCategory.findUnique({
      where: {id},
      select: {id: true, slug: true, _count: {select: {articles: true}}},
    });
    if (!current) return notFound(c, 'category');
    const notEmpty = (n: number | null) =>
      c.json(
        problem(
          'category_not_empty',
          n ? `Move or delete its ${n} article${n === 1 ? '' : 's'} first.` : 'Move or delete its articles first.'
        ),
        409
      );
    if (current._count.articles > 0) return notEmpty(current._count.articles);
    try {
      await db.kbCategory.delete({where: {id}, select: {id: true}});
    } catch (error) {
      const code = codeOf(error);
      // An article was added meanwhile: the foreign key (ON DELETE RESTRICT) refuses.
      if (code === 'P2003' || code === 'P2014') return notEmpty(null);
      if (code === 'P2025') return notFound(c, 'category');
      throw error;
    }
    await Promise.all([
      clearPublicCache(),
      audit(db, {actorUserId: c.var.viewer.id, action: 'kb_category_deleted', target: ['kb_category', id], meta: {slug: current.slug}}),
    ]);
    return c.json({ok: true});
  })

  // ---- snippets (never public: no cache to clear) -------------------------------
  .get(
    '/snippets',
    validator('query', value => ({
      q: typeof value.q === 'string' ? value.q.trim().slice(0, 80) : '',
      before: typeof value.before === 'string' ? value.before : '',
    })),
    withViewer,
    requireAuth,
    canEdit,
    withDb,
    async c => {
      const {q} = c.req.valid('query');
      const before = idOf(c.req.valid('query').before);
      const rows = await c.var.db.kbSnippet.findMany({
        select: snippetSelect,
        where: {
          ...(before ? {id: {lt: before}} : {}),
          ...(q
            ? {OR: [{question: {contains: q, mode: 'insensitive' as const}}, {answer: {contains: q, mode: 'insensitive' as const}}]}
            : {}),
        },
        orderBy: {id: 'desc'},
        take: PAGE + 1,
      });
      const snippets = rows.slice(0, PAGE).map(toSnippet);
      const page: KbSnippetsPage = {snippets, next: rows.length > PAGE ? snippets.at(-1)!.id : null};
      return c.json(page);
    }
  )

  .post('/snippets', snippetBody(false), withViewer, requireAuth, canEdit, withDb, async c => {
    const input = c.req.valid('json') as {question: string; answer: string};
    const me = c.var.viewer.id!;
    const row = await c.var.db.kbSnippet.create({
      data: {
        question: input.question,
        answer: input.answer,
        createdBy: me,
        updatedBy: me,
        chunks: {createMany: {data: chunkSnippet(input.question, input.answer)}},
      },
      select: snippetSelect,
    });
    return c.json({snippet: toSnippet(row)}, 201);
  })

  .patch('/snippets/:id', snippetBody(true), withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'snippet');
    const input = c.req.valid('json');
    // Its chunk needs both halves: read the one not sent.
    const current =
      input.question === undefined || input.answer === undefined
        ? await db.kbSnippet.findUnique({where: {id}, select: {question: true, answer: true}})
        : {question: input.question, answer: input.answer};
    if (!current) return notFound(c, 'snippet');
    const question = input.question ?? current.question;
    const answer = input.answer ?? current.answer;
    let row;
    try {
      row = await db.$transaction(async tx => {
        await tx.kbChunk.deleteMany({where: {snippetId: id}});
        return tx.kbSnippet.update({
          where: {id},
          data: {question, answer, updatedBy: c.var.viewer.id!, chunks: {createMany: {data: chunkSnippet(question, answer)}}},
          select: snippetSelect,
        });
      });
    } catch (error) {
      if (codeOf(error) === 'P2025') return notFound(c, 'snippet');
      throw error;
    }
    return c.json({snippet: toSnippet(row)});
  })

  .delete('/snippets/:id', withViewer, requireAuth, canEdit, withDb, async c => {
    const db = c.var.db;
    const id = idOf(c.req.param('id'));
    // Its chunk goes with it (ON DELETE CASCADE).
    const {count} = id ? await db.kbSnippet.deleteMany({where: {id}}) : {count: 0};
    if (!count) return notFound(c, 'snippet');
    await audit(db, {actorUserId: c.var.viewer.id, action: 'kb_snippet_deleted', target: ['kb_snippet', id!]});
    return c.json({ok: true});
  })

  // ---- import ----------------------------------------------------------------------
  // Rows are checked one by one: a bad row is skipped (with the reason), the rest are saved.
  // Articles arrive as drafts (no chunks, no counts, nothing public changes).
  .post(
    '/import',
    validator('json', (value, c) => {
      const rows = objectOf(value).rows;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > KB_LIMITS.importBatch) {
        return invalid(c, {rows: `Send 1 to ${KB_LIMITS.importBatch} rows at a time.`});
      }
      return {rows: rows as unknown[]};
    }),
    withViewer,
    requireAuth,
    canEdit,
    withDb,
    async c => {
      const db = c.var.db;
      const me = c.var.viewer.id!;
      const {rows} = c.req.valid('json');
      const skipped: KbImportResult['skipped'] = [];
      const articles: {index: number; title: string; body: string; categoryId: number}[] = [];
      const snippets: {question: string; answer: string}[] = [];

      rows.forEach((raw, index) => {
        const v = objectOf(raw);
        if (v.kind === 'snippet') {
          const {out, fields} = readSnippet(v, false);
          const problemText = Object.values(fields)[0];
          if (problemText) skipped.push({index, reason: problemText});
          else snippets.push({question: out.question!, answer: out.answer!});
        } else if (v.kind === 'article') {
          const {out, fields} = readArticle({title: v.title, body: v.body, categoryId: v.categoryId}, false);
          const problemText = Object.values(fields)[0];
          if (problemText) skipped.push({index, reason: problemText});
          else articles.push({index, title: out.title!, body: out.body!, categoryId: out.categoryId!});
        } else {
          skipped.push({index, reason: 'Each row is an article or a snippet.'});
        }
      });

      const max = KB_LIMITS.articleSlug;
      const bases = articles.map(row => slugify(row.title, max) || 'article');
      const categoryIds = [...new Set(articles.map(row => row.categoryId))];
      const [categories, used] = await Promise.all([
        categoryIds.length
          ? db.kbCategory.findMany({select: {id: true}, where: {id: {in: categoryIds}}, take: KB_LIMITS.importBatch})
          : Promise.resolve([] as {id: number}[]),
        articleSlugsLike(db, [...new Set(bases)]),
      ]);
      const known = new Set(categories.map(row => row.id));

      const now = new Date();
      const articleData: Prisma.KbArticleCreateManyInput[] = [];
      for (const [i, row] of articles.entries()) {
        if (!known.has(row.categoryId)) {
          skipped.push({index: row.index, reason: 'That category no longer exists. Pick another.'});
          continue;
        }
        articleData.push({
          categoryId: row.categoryId,
          title: row.title,
          slug: freeSlug(bases[i], used, max),
          body: row.body,
          excerpt: excerptOf(row.body),
          status: 'draft',
          lastReviewedAt: now,
          createdBy: me,
          updatedBy: me,
        });
      }
      const snippetData = snippets.map(row => ({...row, createdBy: me, updatedBy: me}));
      skipped.sort((a, b) => a.index - b.index);
      if (!articleData.length && !snippetData.length) {
        const result: KbImportResult = {created: 0, skipped};
        return c.json(result);
      }

      let created;
      try {
        created = await db.$transaction(async tx => {
          const madeArticles = articleData.length ? (await tx.kbArticle.createMany({data: articleData})).count : 0;
          if (!snippetData.length) return madeArticles;
          const made = await tx.kbSnippet.createManyAndReturn({data: snippetData, select: {id: true, question: true, answer: true}});
          // Each chunk is built from its own returned row, so the order RETURNING gives doesn't matter.
          await tx.kbChunk.createMany({
            data: made.flatMap(snippet => chunkSnippet(snippet.question, snippet.answer).map(chunk => ({...chunk, snippetId: snippet.id}))),
          });
          return madeArticles + made.length;
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === 'P2002') {
          return c.json(problem('slug_taken', 'Another save just used one of these titles. Send this batch again.'), 409);
        }
        if (code === 'P2003') {
          return c.json(problem('category_gone', 'A category was deleted meanwhile. Pick the category again and send this batch.'), 409);
        }
        throw error;
      }
      await audit(db, {
        actorUserId: me,
        action: 'kb_imported',
        meta: {articles: articleData.length, snippets: snippetData.length},
      });
      const result: KbImportResult = {created, skipped};
      return c.json(result);
    }
  );
