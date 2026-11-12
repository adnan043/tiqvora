/**
 * Site Cache keys for the knowledge base and the help desk settings (docs/agent/cache.md).
 *
 * Every public KB read is cached under `kb:` and holds PUBLISHED content only. Any write that
 * changes what the public help center shows (an article, a category, a settings word shown on
 * `/help/`) clears the whole group AFTER it committed: `await cache.delPrefix(KB_CACHE_PREFIX)`.
 * Keys are built from ids and slugs only, never from what a visitor typed (search is not cached).
 */
export const KB_CACHE_PREFIX = 'kb:';

export const kbKeys = {
  /** GET /kb/home: settings words + categories + popular. */
  home: 'kb:home',
  /** GET /kb/categories */
  categories: 'kb:categories',
  /** GET /kb/categories/:slug (slug already matched SLUG_RE). */
  category: (slug: string) => `kb:category:${slug}`,
  /** GET /kb/articles/:slug (slug already matched SLUG_RE). */
  article: (slug: string) => `kb:article:${slug}`,
  /** GET /kb/sitemap */
  sitemap: 'kb:sitemap',
} as const;

/** The `helpdesk_settings` row (src/server/kb/settings.ts). Its writer clears it AND `KB_CACHE_PREFIX` (`/help/` shows its words). */
export const HELPDESK_SETTINGS_KEY = 'helpdesk:settings';
