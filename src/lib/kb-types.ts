/**
 * The knowledge base's JSON shapes, shared by the Site API routes
 * (src/server/routes/kb.ts, kb-manage.ts), the public `/help/` pages and the
 * dashboard screens. Browser-safe: types and constants only.
 *
 * Dates are ISO strings. Lists are keyset-paged: `next` is the cursor for the
 * following page (`?before=<next>`), `null` on the last page.
 */
import type {ArticleStatus} from './helpdesk-tones';

export type {ArticleStatus};

/** Validator limits; the database columns use the same lengths. */
export const KB_LIMITS = {
  categoryName: 80,
  categorySlug: 80,
  categoryDescription: 300,
  articleTitle: 160,
  articleSlug: 160,
  articleBody: 50_000,
  /** UTF-8 bytes of an article body: keeps a save under the Site API's 64 KB request limit. */
  articleBodyBytes: 60_000,
  articleExcerpt: 300,
  snippetQuestion: 300,
  snippetAnswer: 2000,
  searchQuery: 120,
  helpTitle: 120,
  helpIntro: 300,
  /** Rows in one import request (the browser sends batches). */
  importBatch: 50,
} as const;

/** `/help/articles/` and `/help/search/` are pages of their own: never a category's slug. */
export const RESERVED_CATEGORY_SLUGS = ['articles', 'search'] as const;

export const ARTICLE_STATUSES: readonly ArticleStatus[] = ['draft', 'published', 'archived'];

/** A slug: lower-case letters, digits and single dashes. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Turns a title into a slug candidate (the server still checks it's free). */
export function slugify(text: string, max: number = KB_LIMITS.articleSlug): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

// ------------------------------------------------------------------ public --

export interface KbCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  /** A name from ICON_NAMES. */
  icon: string;
  /** Published articles in it. */
  articleCount: number;
}

export interface KbArticleSummary {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  category: {name: string; slug: string};
  updatedAt: string;
}

export interface KbArticle extends KbArticleSummary {
  /** Sanitized HTML rendered from the Markdown body (src/lib/markdown.ts + sanitizeHtml). */
  html: string;
  /** `## ` headings, for the "On this page" list: id matches the heading's `id` in `html`. */
  headings: {id: string; text: string}[];
  publishedAt: string | null;
  related: KbArticleSummary[];
  /** The category's published articles (this one included), A–Z, up to 100: the page's side nav. */
  siblings?: {title: string; slug: string}[];
}

/** GET /site-api/kb/home: everything `/help/` shows, one request. */
export interface KbHome {
  title: string;
  intro: string;
  categories: KbCategory[];
  popular: KbArticleSummary[];
}

/** GET /site-api/kb/categories/:slug */
export interface KbCategoryPage {
  category: KbCategory;
  articles: KbArticleSummary[];
}

/** GET /site-api/kb/articles?category=&before= */
export interface KbArticlesPage {
  articles: KbArticleSummary[];
  next: number | null;
}

export interface KbSearchHit {
  title: string;
  slug: string;
  category: {name: string; slug: string};
  /** Plain text around the match (never HTML). */
  snippet: string;
}

/** GET /site-api/kb/search?q= */
export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}

// ------------------------------------------------------------------ manage --

export interface KbManageArticleRow {
  id: number;
  title: string;
  slug: string;
  status: ArticleStatus;
  category: {id: number; name: string};
  helpfulCount: number;
  notHelpfulCount: number;
  viewCount: number;
  updatedAt: string;
  lastReviewedAt: string;
}

export interface KbManageArticlesPage {
  articles: KbManageArticleRow[];
  next: number | null;
}

/** GET /site-api/kb/manage/articles/:id (for editing) */
export interface KbManageArticle extends KbManageArticleRow {
  body: string;
  excerpt: string;
}

/** POST /site-api/kb/manage/articles, PATCH …/:id (every field optional on PATCH) */
export interface KbArticleInput {
  title: string;
  /** Optional on create: made from the title. */
  slug?: string;
  categoryId: number;
  body: string;
  excerpt?: string;
  status?: ArticleStatus;
}

export interface KbManageCategory extends KbCategory {
  position: number;
  /** Every article in it, any status (a category with articles can't be deleted). */
  totalArticles: number;
}

export interface KbCategoryInput {
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  position?: number;
}

export interface KbSnippet {
  id: number;
  question: string;
  answer: string;
  updatedAt: string;
}

export interface KbSnippetsPage {
  snippets: KbSnippet[];
  next: number | null;
}

export interface KbSnippetInput {
  question: string;
  answer: string;
}

/** POST /site-api/kb/manage/import: one batch from the browser. */
export type KbImportRow =
  | {kind: 'snippet'; question: string; answer: string}
  | {kind: 'article'; title: string; body: string; categoryId: number};

export interface KbImportResult {
  created: number;
  /** Rows refused, by their index in the batch, with the reason in words. */
  skipped: {index: number; reason: string}[];
}
