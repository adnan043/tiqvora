import {describe, expect, it} from 'vitest';

import {markdownToText, renderMarkdown} from '../src/lib/markdown';
import {sanitizeHtml} from '../src/platform/sanitize';
import {renderArticleHtml} from '../src/server/kb/render';

/** The article renderer: a CommonMark subset that never lets raw HTML or a script URL through. */
const html = (md: string) => renderMarkdown(md).html;
/** Whitespace between tags doesn't matter to these checks. */
const flat = (md: string) => html(md).replace(/>\s+</g, '><').trim();

describe('renderMarkdown: untrusted input', () => {
  it('escapes a <script> tag instead of passing it through', () => {
    const out = html('Hello <script>alert(1)</script> there');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;script');
  });

  it('escapes raw HTML with an event handler', () => {
    const out = html('<img src=x onerror="alert(1)">\n\n<div onclick="x()">hi</div>');
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/<div/i);
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
  });

  it('drops javascript:, data: and vbscript: links', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)']) {
      const out = html(`[click me](${url})`);
      expect(out, url).not.toMatch(/href\s*=\s*["']?\s*(javascript|data|vbscript):/i);
      expect(out, url).not.toMatch(/<a\s[^>]*href=["']?\s*javascript/i);
    }
  });

  it('drops images with a script or data URL', () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>']) {
      expect(html(`![x](${url})`), url).not.toMatch(/<img[^>]*src\s*=\s*["']?\s*(javascript|data):/i);
    }
  });

  it('keeps safe links and images', () => {
    expect(html('[Docs](https://example.com/docs)')).toMatch(/<a [^>]*href="https:\/\/example\.com\/docs"[^>]*>Docs<\/a>/);
    expect(html('[Write](mailto:help@example.com)')).toMatch(/href="mailto:help@example\.com"/);
    expect(html('[Shipping](/help/articles/shipping/)')).toMatch(/href="\/help\/articles\/shipping\/"/);
    expect(html('![A cup](https://example.com/cup.jpg)')).toMatch(/<img [^>]*src="https:\/\/example\.com\/cup\.jpg"[^>]*alt="A cup"|<img [^>]*alt="A cup"[^>]*src="https:\/\/example\.com\/cup\.jpg"/);
  });

  it('escapes quotes inside a link so it cannot break out of the attribute', () => {
    const out = html('[x](https://example.com/"onmouseover="alert(1))');
    expect(out).not.toMatch(/<a[^>]*\sonmouseover=/i);
  });
});

describe('renderMarkdown: formatting', () => {
  it('gives ## headings ids and returns them, deduplicated', () => {
    const {html: out, headings} = renderMarkdown('# Title\n\nIntro.\n\n## Getting started\n\nText.\n\n### A detail\n\nMore.\n\n## Getting started\n\nAgain.');
    expect(headings.map(h => h.text)).toEqual(['Getting started', 'Getting started']);
    expect(headings[0]!.id).toBe('sec-getting-started');
    expect(headings[1]!.id).not.toBe(headings[0]!.id);
    for (const h of headings) {
      expect(h.id).toMatch(/^[a-z0-9-]+$/);
      expect(out).toMatch(new RegExp(`<h2[^>]*id="${h.id}"[^>]*>Getting started</h2>`));
    }
    // Never a second <h1> on the page: `#` becomes an h2 that isn't in "On this page".
    expect(out).not.toContain('<h1');
    expect(out).toMatch(/<h2 class="md-h2">Title<\/h2>/);
    expect(out).toMatch(/<h3[^>]*>A detail<\/h3>/);
  });

  it('heading ids survive the article pipeline, so "On this page" links work', () => {
    // sanitizeHtml (managed) strips ids; renderArticleHtml puts the h2 ids back.
    const {html, headings} = renderArticleHtml('## Grind size\n\nMedium.\n\n<script>alert(1)</script>');
    expect(html).toContain(`<h2 id="${headings[0]!.id}">`);
    expect(html).not.toContain('<script');
    expect(sanitizeHtml(renderMarkdown('## Grind size').html)).not.toContain('id=');
  });

  it('a heading with markup gives plain text and a clean id', () => {
    const {headings} = renderMarkdown('## Returns & **refunds**');
    expect(headings[0]!.text).toBe('Returns & refunds');
    expect(headings[0]!.id).toMatch(/^sec-returns-(and-)?refunds$/);
  });

  it('renders paragraphs, bold, italic and inline code (escaped)', () => {
    const out = flat('A **bold** and *soft* word.\n\nUse `a<b` here.');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>soft</em>');
    expect(out).toContain('<code>a&lt;b</code>');
    expect((out.match(/<p>/g) ?? []).length).toBe(2);
  });

  it('renders fenced code with its content escaped and not formatted', () => {
    const out = flat('```js\nconst a = "<b>**x**</b>";\n```');
    expect(out).toMatch(/<pre[^>]*><code[^>]*>/);
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<strong>');
    expect(out).not.toMatch(/<b>/);
  });

  it('renders unordered, ordered and nested lists', () => {
    expect(flat('- one\n- two')).toMatch(/<ul><li>one<\/li><li>two<\/li><\/ul>/);
    expect(flat('1. first\n2. second')).toMatch(/<ol[^>]*><li>first<\/li><li>second<\/li><\/ol>/);
    const nested = flat('- outer\n  - inner\n- next');
    expect((nested.match(/<ul/g) ?? []).length).toBe(2);
    expect(nested).toMatch(/<li>outer<ul><li>inner<\/li><\/ul><\/li>/);
  });

  it('renders a blockquote and a rule', () => {
    const out = flat('> Keep beans airtight.\n\n---\n\nAfter.');
    expect(out).toMatch(/<blockquote>(<p>)?Keep beans airtight\.(<\/p>)?<\/blockquote>/);
    expect(out).toMatch(/<hr\s*\/?>/);
  });

  it('handles empty input', () => {
    const out = renderMarkdown('');
    expect(out.html.trim()).toBe('');
    expect(out.headings).toEqual([]);
  });
});

describe('markdownToText', () => {
  it('drops markup and keeps the words', () => {
    const text = markdownToText('## Grind\n\nUse a **medium** grind, see [the guide](https://example.com).\n\n- one\n- two\n\n`code`');
    expect(text).toContain('Grind');
    expect(text).toContain('Use a medium grind, see the guide.');
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(text).toContain('code');
    expect(text).not.toMatch(/[*#`[\]]|https:\/\//);
  });

  it('is empty for empty input', () => {
    expect(markdownToText('').trim()).toBe('');
  });
});

describe('renderMarkdown: hostile input stays fast and ids stay in step', () => {
  it('long runs of spaces and backticks render in linear time (fence, code span, hard break)', () => {
    for (const body of ['```' + ' '.repeat(50_000) + '`', 'a' + '`'.repeat(50_000), 'x' + ' '.repeat(50_000) + 'y']) {
      const started = performance.now();
      renderMarkdown(body);
      markdownToText(body);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('code spans still work', () => {
    expect(renderMarkdown('use `a` and ``c`d``').html).toContain('<code>a</code>');
    expect(renderMarkdown('use `a` and ``c`d``').html).toContain('<code>c`d</code>');
  });

  it('a quoted or single-# heading never shifts the "On this page" ids', () => {
    const {html, headings} = renderArticleHtml('## One\n\n> ## Quoted\n\n# Big\n\n## Two\n\n## Main');
    expect(headings.map(h => h.id)).toEqual(['sec-one', 'sec-two', 'sec-main']);
    expect(html).toContain('<h2 id="sec-two">Two</h2>');
    expect(html).toContain('<h2 id="sec-main">Main</h2>');
    expect(html).not.toContain('id="main"');
  });
});
