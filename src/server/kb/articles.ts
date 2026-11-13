import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {ARTICLE_STATUSES, type ArticleStatus, KB_LIMITS, type KbManageArticle, type KbManageArticleRow, SLUG_RE, slugify} from '../../lib/kb-types';
import {markdownToText} from '../../lib/markdown';
import {chunkArticle, cut} from './chunks';

/**
 * The article write path, shared by the editors' routes (src/server/routes/kb-manage.ts) and
 * Knowledge health's Accept (src/server/knowledge/accept.ts). Moved here unchanged from kb-manage.ts.
 *
 * Write rules: only PUBLISHED articles have chunks (`kb_chunks`) and count in their category's
 * `articleCount`. These functions run inside the caller's transaction (or on the client) and never
 * clear the `kb:` cache or write an audit row: the caller does both after commit.
 */

export type Db = PrismaClient | Prisma.TransactionClient;
export type Fields = Record<string, string>;

export const idOf = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

export const str = (value: unknown) => (typeof value === 'string' ? value : '');
export const given = (v: Record<string, unknown>, key: string) => v[key] !== undefined && v[key] !== null;

/** `slug`, else `slug-2`, `slug-3`… not in `used` (added to it), at most `max` long. */
export function freeSlug(base: string, used: Set<string>, max: number): string {
  let slug = base.slice(0, max);
  for (let n = 2; used.has(slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  used.add(slug);
  return slug;
}

/** A random fallback when a free slug was taken meanwhile. */
export const randomSlug = (base: string, max: number = KB_LIMITS.articleSlug) =>
  `${base.slice(0, max - 9).replace(/-+$/, '')}-${crypto.randomUUID().slice(0, 8)}`;

/** Slugs in use that a candidate from `bases` could collide with (`base`, `base-…`). One read. */
export async function articleSlugsLike(db: Db, bases: string[]): Promise<Set<string>> {
  if (!bases.length) return new Set();
  const rows = await db.kbArticle.findMany({
    select: {slug: true},
    where: {OR: bases.flatMap(base => [{slug: base}, {slug: {startsWith: `${base}-`}}])},
    take: 1000,
  });
  return new Set(rows.map(row => row.slug));
}

/** A free slug from a title (one read), and the base it came from (for `randomSlug` on a retry). */
export async function newArticleSlug(db: Db, title: string): Promise<{slug: string; base: string}> {
  const max = KB_LIMITS.articleSlug;
  const base = slugify(title, max) || 'article';
  return {slug: freeSlug(base, await articleSlugsLike(db, [base]), max), base};
}

/** The summary under a title when the editor wrote none: the first plain paragraph, so headings
 * and list items never run together ("Why it happens A noisy grinder…"). At most 200 characters. */
const NOT_A_PARAGRAPH = /^\s{0,3}(?:#|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/;
export function excerptOf(body: string): string {
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const paragraph = blocks.find(block => block.trim() && !NOT_A_PARAGRAPH.test(block));
  const text = markdownToText(paragraph ?? body).replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  const at = text.lastIndexOf(' ', 199);
  return `${cut(text, at > 100 ? at : 199).trimEnd()}…`;
}

// ------------------------------------------------------------------ validation --

export type ArticleFields = {
  title?: string;
  slug?: string;
  categoryId?: number;
  body?: string;
  excerpt?: string;
  status?: ArticleStatus;
};

export const BODY_MESSAGE = `Write the article: 1 to ${KB_LIMITS.articleBody.toLocaleString('en-US')} characters.`;
export const BODY_TOO_BIG_MESSAGE = 'This article is too long. Split it into two articles.';
const utf8 = new TextEncoder();
/** Over KB_LIMITS.articleBodyBytes in UTF-8: a body near 50,000 characters of non-Latin text would
 * otherwise pass the character check and still break the Site API's 64 KB request limit. */
export const bodyTooBig = (body: string) =>
  body.length * 3 > KB_LIMITS.articleBodyBytes && utf8.encode(body).length > KB_LIMITS.articleBodyBytes;

/** Checks an article's fields; `partial` (PATCH) checks only the ones sent. */
export function readArticle(v: Record<string, unknown>, partial: boolean): {out: ArticleFields; fields: Fields} {
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

// --------------------------------------------------------------------- output --

export const articleRowSelect = {
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
export const articleSelect = {...articleRowSelect, body: true, excerpt: true} as const;

export type ArticleRowData = {
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
/** An article as `articleSelect` reads it. */
export type ArticleRow = ArticleRowData & {body: string; excerpt: string};

export const toArticleRow = (row: ArticleRowData): KbManageArticleRow => ({
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

export const toArticle = (row: ArticleRow): KbManageArticle => ({
  ...toArticleRow(row),
  body: row.body,
  excerpt: row.excerpt,
});

// --------------------------------------------------------------------- writes --

/**
 * The create of POST /articles: the row, its chunks and its category's count when published.
 * Run it inside a transaction (`db.$transaction(tx => insertArticle(tx, …))`). No cache, no audit:
 * the caller does both after commit. P2002 = the slug is taken; P2003 / P2025 = the category is gone.
 */
export async function insertArticle(
  tx: Db,
  input: {title: string; body: string; categoryId: number; excerpt?: string; status: ArticleStatus},
  me: number,
  slug: string
): Promise<ArticleRow> {
  const published = input.status === 'published';
  const now = new Date();
  const chunks = published ? chunkArticle(input.title, input.body) : [];
  const row = await tx.kbArticle.create({
    data: {
      categoryId: input.categoryId,
      title: input.title,
      slug,
      body: input.body,
      excerpt: input.excerpt || excerptOf(input.body),
      status: input.status,
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
}

/**
 * Replaces a DRAFT's title, body and excerpt (an empty or missing excerpt is made from the body),
 * conditional on its status still being 'draft': P2025 when it isn't (or is gone). Sets
 * lastReviewedAt and updatedBy. No chunks and no counts: drafts have neither. No cache, no audit.
 */
export async function updateDraftArticle(
  tx: Db,
  id: number,
  input: {title: string; body: string; excerpt?: string},
  me: number
): Promise<ArticleRow> {
  return tx.kbArticle.update({
    where: {id, status: 'draft'},
    data: {
      title: input.title,
      body: input.body,
      excerpt: input.excerpt || excerptOf(input.body),
      lastReviewedAt: new Date(),
      updatedBy: me,
    },
    select: articleSelect,
  });
}
