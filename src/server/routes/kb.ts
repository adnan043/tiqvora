import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {
  KB_LIMITS,
  SLUG_RE,
  type KbArticle,
  type KbArticleSummary,
  type KbArticlesPage,
  type KbCategory,
  type KbCategoryPage,
  type KbHome,
  type KbSearchResult,
} from '../../lib/kb-types';
import {cache} from '../../platform/cache';
import {problem, withDb} from '../../platform/guards';
import {kbKeys} from '../kb/keys';
import {renderArticleHtml} from '../kb/render';
import {searchKb} from '../kb/search';
import {getHelpdeskSettings} from '../kb/settings';
import {clientRateKey, takeRateWindow, takeRateWindows} from '../rate-window';

/**
 * The public help center's data (no sign-in; the `/help/` pages and their scripts read it).
 * PUBLISHED content only; never an author id, an email or a draft.
 *
 *   GET  /site-api/kb/home                      title, intro, categories, popular articles
 *   GET  /site-api/kb/categories                every category with a published article
 *   GET  /site-api/kb/categories/:slug          one category + its published articles (404 when it has none)
 *   GET  /site-api/kb/articles?category=&before= published articles, 20 a page, newest first
 *   GET  /site-api/kb/articles/:slug            one published article (sanitized HTML, related, side nav)
 *   GET  /site-api/kb/search?q=                 full-text search (30 a minute per client, 3000 site-wide)
 *   GET  /site-api/kb/sitemap                   slugs for /sitemap.xml
 *   POST /site-api/kb/articles/:id/feedback     {helpful: boolean}
 *   POST /site-api/kb/articles/:id/view         counts one page view
 *
 * Cache (docs/agent/cache.md), all under `kb:` and cleared together by every manage write that
 * changes public content (`cache.delPrefix(KB_CACHE_PREFIX)` in routes/kb-manage.ts) and by the
 * help desk settings save:
 *   kb:home — 1 h — on every /help/ visit; popular order drifts with views (time-based) — kb-manage writes, settings save
 *   kb:categories, kb:category:<slug>, kb:article:<slug>, kb:sitemap — 1 h — read on every help page — kb-manage writes
 * Search, the article list pages, feedback and views are not cached (visitor input, or writes).
 * Counters are bumped with raw UPDATEs so they don't touch `updated_at` (shown as "Updated" and
 * used as the sitemap's lastmod).
 */

const HOUR = 3600;
const PAGE_SIZE = 20;
const SITEMAP_LIMIT = 1000;
/** An article page's side nav: published articles of its category (also where `related` comes from). */
const SIBLINGS_LIMIT = 100;
const RELATED_LIMIT = 4;
const PUBLIC_CACHE = 'public, max-age=300';
/**
 * Rate limits per minute (src/server/rate-window.ts): per client (keyed IP hash) first, then
 * site-wide as a ceiling. Buckets fit VARCHAR(40): `s:`/`f:`/`v:` + 16 hex, `fa:` + 12 hex + id.
 */
const SEARCH_PER_CLIENT = 30;
const SEARCH_SITE_WIDE = 3000;
const FEEDBACK_PER_CLIENT = 10;
/** One vote per client per article per minute (a double click, or vote stuffing). */
const FEEDBACK_PER_CLIENT_ARTICLE = 1;
const FEEDBACK_SITE_WIDE = 1200;
const VIEW_PER_CLIENT = 5;
const VIEW_SITE_WIDE = 6000;

/**
 * Categories shown publicly (home, list, sitemap, their own page): only those with a published
 * article; an empty one answers 404 like an unknown slug. `article_count`
 * changes only in kb-manage writes, which clear the `kb:` cache. ≤ 100 rows: no index needed.
 */
const LISTED = {articleCount: {gt: 0}} as const;

const categorySelect = {id: true, name: true, slug: true, description: true, icon: true, articleCount: true} as const;
const summarySelect = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  updatedAt: true,
  category: {select: {name: true, slug: true}},
} as const;

type CategoryRow = {id: number; name: string; slug: string; description: string; icon: string; articleCount: number};
type SummaryRow = {
  id: number;
  title: string;
  slug: string;
  excerpt: string;
  updatedAt: Date;
  category: {name: string; slug: string};
};

const toCategory = (row: CategoryRow): KbCategory => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  icon: row.icon,
  articleCount: row.articleCount,
});

const toSummary = (row: SummaryRow): KbArticleSummary => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  excerpt: row.excerpt,
  category: {name: row.category.name, slug: row.category.slug},
  updatedAt: row.updatedAt.toISOString(),
});

const idOf = (value: unknown) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const isSlug = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && SLUG_RE.test(value);

const NOT_FOUND_ARTICLE = problem('not_found', 'No such article.');
const NOT_FOUND_CATEGORY = problem('not_found', 'No such category.');

const articleSlugParam = validator('param', (value, c) =>
  isSlug(value.slug, KB_LIMITS.articleSlug) ? {slug: value.slug} : c.json(NOT_FOUND_ARTICLE, 404)
);
const categorySlugParam = validator('param', (value, c) =>
  isSlug(value.slug, KB_LIMITS.categorySlug) ? {slug: value.slug} : c.json(NOT_FOUND_CATEGORY, 404)
);
const articleIdParam = validator('param', (value, c) => {
  const id = idOf(value.id);
  return id ? {id} : c.json(NOT_FOUND_ARTICLE, 404);
});

const listQuery = validator('query', value => ({
  category: isSlug(value.category, KB_LIMITS.categorySlug) ? value.category : '',
  before: typeof value.before === 'string' ? value.before : '',
}));

const searchQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.replace(/\s+/g, ' ').trim().slice(0, KB_LIMITS.searchQuery).trim() : '',
}));

const feedbackBody = validator('json', (value, c) => {
  const helpful = (value as {helpful?: unknown} | null)?.helpful;
  if (typeof helpful !== 'boolean') {
    const message = 'Say whether the article helped: helpful is true or false.';
    return c.json({...problem('invalid', message), fields: {helpful: message}}, 422);
  }
  return {helpful};
});

const RATE_LIMITED = (message: string) => problem('rate_limited', message);

export const kbRoutes = new Hono()
  .get('/home', withDb, async c => {
    const db = c.var.db;
    const home = await cache.getOrSet<KbHome>(kbKeys.home, HOUR, async () => {
      const [settings, categories, popular] = await Promise.all([
        getHelpdeskSettings(db),
        db.kbCategory.findMany({select: categorySelect, where: LISTED, orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100}),
        // Index: kb_articles(status, view_count DESC, id DESC).
        db.kbArticle.findMany({
          select: summarySelect,
          where: {status: 'published'},
          orderBy: [{viewCount: 'desc'}, {id: 'desc'}],
          take: 8,
        }),
      ]);
      return {
        title: settings.helpTitle,
        intro: settings.helpIntro,
        categories: categories.map(toCategory),
        popular: popular.map(toSummary),
      };
    });
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(home);
  })

  .get('/categories', withDb, async c => {
    const db = c.var.db;
    const categories = await cache.getOrSet<KbCategory[]>(kbKeys.categories, HOUR, async () =>
      (await db.kbCategory.findMany({select: categorySelect, where: LISTED, orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100})).map(
        toCategory
      )
    );
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json({categories});
  })

  .get('/categories/:slug', categorySlugParam, withDb, async c => {
    const db = c.var.db;
    const {slug} = c.req.valid('param');
    // One query: the category and its published articles (index: kb_articles(category_id, status, id)).
    const page = await cache.getOrSet<KbCategoryPage | null>(kbKeys.category(slug), HOUR, async () => {
      const row = await db.kbCategory.findUnique({
        where: {slug},
        select: {
          ...categorySelect,
          articles: {
            where: {status: 'published'},
            select: {id: true, title: true, slug: true, excerpt: true, updatedAt: true},
            orderBy: {title: 'asc'},
            take: 100,
          },
        },
      });
      if (!row || row.articleCount === 0) return null;
      const category = {name: row.name, slug: row.slug};
      return {
        category: toCategory(row),
        articles: row.articles.map(article => toSummary({...article, category})),
      };
    });
    if (!page) return c.json(NOT_FOUND_CATEGORY, 404);
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(page);
  })

  .get('/articles', listQuery, withDb, async c => {
    const {category, before} = c.req.valid('query');
    const cursor = idOf(before);
    const rows = await c.var.db.kbArticle.findMany({
      select: summarySelect,
      where: {
        status: 'published',
        ...(cursor ? {id: {lt: cursor}} : {}),
        ...(category ? {category: {slug: category}} : {}),
      },
      orderBy: {id: 'desc'},
      take: PAGE_SIZE + 1,
    });
    const articles = rows.slice(0, PAGE_SIZE).map(toSummary);
    const page: KbArticlesPage = {articles, next: rows.length > PAGE_SIZE ? articles.at(-1)!.id : null};
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(page);
  })

  .get('/articles/:slug', articleSlugParam, withDb, async c => {
    const db = c.var.db;
    const {slug} = c.req.valid('param');
    const article = await cache.getOrSet<KbArticle | null>(kbKeys.article(slug), HOUR, async () => {
      // One query: the article, its category and the category's published articles (this one
      // included). Prisma can't select one relation twice, so both lists come from this one:
      // the SIBLINGS_LIMIT most viewed (index: kb_articles(category_id, status, id)); `related`
      // is their top 4 other than this article (exact: the 4 most viewed are always in it), and
      // the side nav is the same rows A–Z. A category with more published articles than that
      // lists its most viewed ones in the side nav.
      const row = await db.kbArticle.findFirst({
        where: {slug, status: 'published'},
        select: {
          id: true,
          title: true,
          slug: true,
          excerpt: true,
          body: true,
          publishedAt: true,
          updatedAt: true,
          category: {
            select: {
              name: true,
              slug: true,
              articles: {
                where: {status: 'published'},
                select: {id: true, title: true, slug: true, excerpt: true, updatedAt: true},
                orderBy: [{viewCount: 'desc'}, {id: 'desc'}],
                take: SIBLINGS_LIMIT,
              },
            },
          },
        },
      });
      if (!row) return null;
      const category = {name: row.category.name, slug: row.category.slug};
      const {html, headings} = renderArticleHtml(row.body);
      const inCategory = row.category.articles;
      return {
        ...toSummary({...row, category}),
        html,
        headings,
        publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        related: inCategory
          .filter(other => other.id !== row.id)
          .slice(0, RELATED_LIMIT)
          .map(related => toSummary({...related, category})),
        siblings: inCategory
          .map(other => ({title: other.title, slug: other.slug}))
          .sort((a, b) => a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug)),
      };
    });
    if (!article) return c.json(NOT_FOUND_ARTICLE, 404);
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(article);
  })

  .get('/search', searchQuery, withDb, async c => {
    const {q} = c.req.valid('query');
    if (q.length < 2) return c.json({query: q, hits: []} satisfies KbSearchResult);
    const client = await clientRateKey(c);
    const allowed = await takeRateWindows(c.var.db, [
      client ? [`s:${client}`, SEARCH_PER_CLIENT] : null,
      ['kb-search', SEARCH_SITE_WIDE],
    ]);
    if (!allowed) {
      return c.json(RATE_LIMITED('Too many searches right now. Try again in a minute.'), 429);
    }
    const hits = await searchKb(c.var.db, q, 20);
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json({query: q, hits} satisfies KbSearchResult);
  })

  .get('/sitemap', withDb, async c => {
    const db = c.var.db;
    const sitemap = await cache.getOrSet(kbKeys.sitemap, HOUR, async () => {
      const [articles, categories] = await Promise.all([
        db.kbArticle.findMany({
          select: {slug: true, updatedAt: true},
          where: {status: 'published'},
          orderBy: {id: 'desc'},
          take: SITEMAP_LIMIT,
        }),
        db.kbCategory.findMany({
          select: {slug: true, updatedAt: true},
          where: LISTED,
          orderBy: [{position: 'asc'}, {id: 'asc'}],
          take: 100,
        }),
      ]);
      const out = (row: {slug: string; updatedAt: Date}) => ({slug: row.slug, updatedAt: row.updatedAt.toISOString()});
      return {articles: articles.map(out), categories: categories.map(out)};
    });
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(sitemap);
  })

  .post('/articles/:id/feedback', articleIdParam, feedbackBody, withDb, async c => {
    const {id} = c.req.valid('param');
    const {helpful} = c.req.valid('json');
    const db = c.var.db;
    const tooMany = () => c.json(RATE_LIMITED('Too many answers right now. Try again in a minute.'), 429);
    const client = await clientRateKey(c);
    if (client) {
      if (!(await takeRateWindow(db, `f:${client}`, FEEDBACK_PER_CLIENT))) return tooMany();
      // Already voted on this article this minute: answered as done, not counted again.
      if (!(await takeRateWindow(db, `fa:${client.slice(0, 12)}:${id}`, FEEDBACK_PER_CLIENT_ARTICLE))) {
        return c.json({ok: true as const});
      }
    }
    if (!(await takeRateWindow(db, 'kb-feedback', FEEDBACK_SITE_WIDE))) return tooMany();
    // Conditional and atomic: only a published article; two fixed statements (no column from input).
    const updated = helpful
      ? await db.$executeRaw`UPDATE "kb_articles" SET "helpful_count" = "helpful_count" + 1 WHERE "id" = ${id} AND "status" = 'published'`
      : await db.$executeRaw`UPDATE "kb_articles" SET "not_helpful_count" = "not_helpful_count" + 1 WHERE "id" = ${id} AND "status" = 'published'`;
    if (!updated) return c.json(NOT_FOUND_ARTICLE, 404);
    return c.json({ok: true as const});
  })

  .post('/articles/:id/view', articleIdParam, withDb, async c => {
    const {id} = c.req.valid('param');
    const db = c.var.db;
    // Over the limit: still 200, just not counted.
    const client = await clientRateKey(c);
    if (await takeRateWindows(db, [client ? [`v:${client}`, VIEW_PER_CLIENT] : null, ['kb-view', VIEW_SITE_WIDE]])) {
      await db.$executeRaw`UPDATE "kb_articles" SET "view_count" = "view_count" + 1 WHERE "id" = ${id} AND "status" = 'published'`;
    }
    return c.json({ok: true as const});
  });
