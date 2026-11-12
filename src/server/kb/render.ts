import {renderMarkdown, withHeadingIds, type RenderedMarkdown} from '../../lib/markdown';
import {sanitizeHtml} from '../../platform/sanitize';

/**
 * An article body (Markdown) as the HTML a page may `set:html`: rendered with every input
 * character escaped (src/lib/markdown.ts), cleaned by `sanitizeHtml`, then the `## ` heading
 * ids put back IN ORDER (the sanitizer drops `id`; `withHeadingIds` only adds ids matching
 * /^[a-z0-9-]+$/). Server only. Used by GET /kb/articles/:slug and POST /kb/manage/preview.
 */
export function renderArticleHtml(body: string): RenderedMarkdown {
  const {html, headings} = renderMarkdown(body);
  return {html: withHeadingIds(sanitizeHtml(html), headings), headings};
}
