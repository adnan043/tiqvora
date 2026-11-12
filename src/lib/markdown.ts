/**
 * Markdown for knowledge-base articles: a small, dependency-free CommonMark subset.
 *
 *   # … ####  headings (`##` get an `id` and are listed in `headings`; ##### and ###### render as h4)
 *   paragraphs, **bold**, *italic*, `code`, ``` fenced code ```, > blockquotes, --- rules
 *   - / * / + and 1. lists, with ONE nested level
 *   [text](url)   http, https, mailto or relative only (anything else renders as plain text)
 *   ![alt](url)   https or relative only
 *   | simple | GFM | tables |
 *
 * SAFE BY CONSTRUCTION: every piece of the input is HTML-escaped before any markup is added, and
 * no raw HTML passes through (`<script>` shows as text). The server still runs the result through
 * `sanitizeHtml` (src/platform/sanitize.ts), which drops `id`s: put them back with
 * `withHeadingIds()`. Bounded regexes only, so a 50,000-character body can't stall the Worker.
 * Browser-safe (no Node or DOM APIs).
 */
import {slugify} from './kb-types';

export interface MarkdownHeading {
  id: string;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  /** The `## ` headings, in order (for "On this page"). */
  headings: MarkdownHeading[];
}

const ENTITIES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const esc = (text: string) => text.replace(/[&<>"']/g, ch => ENTITIES[ch]!);

const FENCE = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** Placeholders for finished HTML pieces (NUL never survives `normalize`). */
const SLOT = /\u0000(\d+)\u0000/g;

const normalize = (md: unknown) =>
  String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '�')
    .replace(/\t/g, '    ');

const isTableStart = (lines: string[], i: number) =>
  lines[i]!.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('|') && TABLE_SEP.test(lines[i + 1]!);

const startsBlock = (lines: string[], i: number) => {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(lines, i);
};

const indentOf = (line: string) => line.length - line.trimStart().length;

/** A link target: http(s), mailto, or relative (no scheme). Input is already escaped. */
function linkUrl(url: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url;
  return /^[^/?#]*:/.test(url) ? null : url;
}

/** An image source: https or relative only (no http, data: or anything else). */
function imageUrl(url: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  if (/^https:\/\//i.test(url)) return url;
  return /^[^/?#]*:/.test(url) || url.startsWith('//') ? null : url;
}

/** **bold**, __bold__, *italic*, _italic_ on ALREADY-ESCAPED text. Spans are bounded. */
const emphasis = (s: string) =>
  s
    .replace(/\*\*(?=\S)([^\n]{0,500}?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([^\n]{0,500}?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^\n*]{0,500}?[^\s*])?\*/g, (m, inner?: string) => (inner === undefined ? m : `<em>${inner}</em>`))
    .replace(/(^|[^\w])_(?=[^\s_])([^\n_]{0,500}?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    // `*a*`: one character between the stars.
    .replace(/\*([^\s*])\*/g, '<em>$1</em>');

/** One paragraph's (or cell's, or heading's) inline Markdown to HTML. */
function inline(src: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src
    // Code spans first: their content is literal.
    .replace(/(?<!`)(`{1,16})(?!`)([\s\S]{1,1000}?)(?<!`)\1(?!`)/g, (_m, _ticks, code: string) => hold(`<code>${esc(code.trim())}</code>`))
    // Backslash escapes: the character itself, never markup.
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => hold(esc(ch)));
  s = esc(s);
  s = s.replace(/!\[([^\]\n]{0,300})\]\([ ]*((?:[^\s()]|\([^\s()]{0,200}\)){1,2000})(?:[ ]+&quot;[^\n]{0,300}?&quot;)?[ ]*\)/g, (_m, alt: string, url: string) => {
    const src = imageUrl(url);
    return src ? hold(`<img src="${src}" alt="${alt.replace(SLOT, '')}">`) : alt;
  });
  s = s.replace(/\[([^\]\n]{1,500})\]\([ ]*((?:[^\s()]|\([^\s()]{0,200}\)){1,2000})(?:[ ]+&quot;[^\n]{0,300}?&quot;)?[ ]*\)/g, (_m, label: string, url: string) => {
    const href = linkUrl(url);
    return href ? hold(`<a href="${href}">${emphasis(label)}</a>`) : emphasis(label);
  });
  // Hard breaks: a run of spaces is only tried from its start (linear, not quadratic).
  s = emphasis(s).replace(/(?<! ) {2,}\n|\\\n/g, '<br>\n');
  // Slots can hold slots (a code span inside a link): earlier ones only, so this ends.
  const restore = (text: string): string => text.replace(SLOT, (_m, n: string) => restore(slots[Number(n)] ?? ''));
  return restore(s);
}

/** Inline Markdown to plain text (no markup). */
function inlineText(src: string): string {
  return src
    // Backslash escapes are held aside (as NUL + char code + NUL) so they never act as markup.
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => `\u0000${ch.charCodeAt(0)}\u0000`)
    .replace(/!\[([^\]\n]{0,300})\]\((?:[^()\n]|\([^()\n]{0,200}\)){0,2000}\)/g, '$1')
    .replace(/\[([^\]\n]{1,500})\]\((?:[^()\n]|\([^()\n]{0,200}\)){0,2000}\)/g, '$1')
    .replace(/`+([^`\n]{0,1000})`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]{0,500}?\S)\1/g, '$2')
    .replace(/\*(?=\S)([^\n*]{0,500}?\S)?\*/g, '$1')
    .replace(/(^|\W)_(?=\S)([^\n_]{0,500}?\S)_(?=\W|$)/g, '$1$2')
    .replace(SLOT, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map(cell => cell.trim());
}

interface Context {
  headings: MarkdownHeading[];
  used: Set<string>;
}

function headingId(ctx: Context, text: string): string {
  const base = `sec-${slugify(text, 76) || 'section'}`;
  let id = base;
  for (let n = 2; ctx.used.has(id); n++) id = `${base}-${n}`;
  ctx.used.add(id);
  return id;
}

/** A list starting at `start`; `nest` 0 allows one nested list inside its items, 1 none. */
function renderList(lines: string[], start: number, nest: number, ctx: Context): {html: string; next: number} {
  const first = LIST.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const sameList = (m: RegExpExecArray | null) => m !== null && m[1]!.length <= indent + 1 && /\d/.test(m[2]!) === ordered;
  const items: string[][] = [];
  let contentIndent = 0;
  let prevBlank = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST.exec(line);
    if (sameList(m)) {
      items.push([m![3] ?? '']);
      contentIndent = m![1]!.length + m![2]!.length + 1;
      prevBlank = false;
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless an item or an indented line follows it.
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      if (j < lines.length && (sameList(LIST.exec(lines[j]!)) || indentOf(lines[j]!) >= indent + 2)) {
        items.at(-1)!.push('');
        prevBlank = true;
        i = j;
        continue;
      }
      break;
    }
    const lead = indentOf(line);
    if (lead >= indent + 2) {
      items.at(-1)!.push(line.slice(Math.min(lead, contentIndent)));
    } else if (!prevBlank && !startsBlock(lines, i)) {
      items.at(-1)!.push(line.trim()); // a lazy continuation of the item's text
    } else {
      break;
    }
    prevBlank = false;
    i++;
  }

  const textHtml = (text: string[]) => {
    const paras = text.join('\n').trim().split(/\n[ \t]*\n/).filter(Boolean);
    return paras.length > 1 ? paras.map(p => `<p>${inline(p.trim())}</p>`).join('') : inline(paras[0] ?? '');
  };
  const body = items
    .map(item => {
      const sub = nest === 0 ? item.findIndex((l, k) => k > 0 && LIST.test(l)) : -1;
      if (sub < 0) return `<li>${textHtml(item)}</li>`;
      const nested = renderList(item, sub, 1, ctx);
      const rest = item.slice(nested.next);
      return `<li>${textHtml(item.slice(0, sub))}${nested.html}${rest.some(l => l.trim()) ? textHtml(rest) : ''}</li>`;
    })
    .join('');
  const startAt = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return {html: `<${tag}${startAt !== 1 ? ` start="${startAt}"` : ''}>${body}</${tag}>`, next: i};
}

function renderBlocks(lines: string[], ctx: Context, depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      i++;
    } else if ((m = FENCE.exec(line))) {
      const marker = m[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        code.push(lines[i++]!);
      }
      i++; // the closing fence (or past the end)
      const lang = ((m[2] ?? '').trim().split(/\s/)[0] ?? '').replace(/[^\w+-]/g, '').slice(0, 20);
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = HEADING.exec(line))) {
      // The page owns the only <h1> (the article title): `#` in a body renders as an h2,
      // and only a real `##` joins "On this page".
      const source = m[1]!.length;
      const level = Math.max(2, Math.min(source, 4));
      const raw = (m[2] ?? '').trim();
      if (source === 2 && depth === 0) {
        const text = inlineText(raw);
        const id = headingId(ctx, text);
        ctx.headings.push({id, text});
        out.push(`<h2 id="${id}">${inline(raw)}</h2>`);
      } else {
        out.push(level === 2 ? `<h2 class="md-h2">${inline(raw)}</h2>` : `<h${level}>${inline(raw)}</h${level}>`);
      }
      i++;
    } else if (HR.test(line)) {
      out.push('<hr>');
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const q = QUOTE.exec(lines[i]!);
        if (!q && startsBlock(lines, i)) break;
        inner.push(q ? q[1]! : lines[i]!);
        i++;
      }
      out.push(
        depth < 3
          ? `<blockquote>${renderBlocks(inner, ctx, depth + 1)}</blockquote>`
          : `<blockquote><p>${inline(inner.join('\n').trim())}</p></blockquote>`
      );
    } else if (isTableStart(lines, i)) {
      const head = tableCells(line);
      const aligns = tableCells(lines[i + 1]!).map(c =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''
      );
      const cols = Math.min(head.length, 20);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) rows.push(tableCells(lines[i++]!));
      const row = (cells: string[], tag: 'th' | 'td') =>
        `<tr>${Array.from({length: cols}, (_, k) => `<${tag}${aligns[k] ? ` align="${aligns[k]}"` : ''}>${inline(cells[k] ?? '')}</${tag}>`).join('')}</tr>`;
      out.push(
        `<table><thead>${row(head, 'th')}</thead>${rows.length ? `<tbody>${rows.map(r => row(r, 'td')).join('')}</tbody>` : ''}</table>`
      );
    } else if (LIST.test(line)) {
      const list = renderList(lines, i, 0, ctx);
      out.push(list.html);
      i = list.next;
    } else {
      const para = [line];
      i++;
      while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) para.push(lines[i++]!);
      out.push(`<p>${inline(para.join('\n').trim())}</p>`);
    }
  }
  return out.join('\n');
}

/** Markdown → HTML (escaped, no raw HTML) + the `## ` headings with their ids. */
export function renderMarkdown(md: string): RenderedMarkdown {
  const ctx: Context = {headings: [], used: new Set()};
  const html = renderBlocks(normalize(md).split('\n'), ctx, 0);
  return {html, headings: ctx.headings};
}

/**
 * Puts the `## ` heading ids back after `sanitizeHtml` (which drops `id` attributes):
 *   const {html, headings} = renderMarkdown(body);
 *   const safe = withHeadingIds(sanitizeHtml(html), headings);
 * Safe: `renderMarkdown` escapes every `<` of the input, so each `<h2>` is one of its headings,
 * in order, and the ids are slugs (letters, digits, dashes).
 */
export function withHeadingIds(html: string, headings: readonly MarkdownHeading[]): string {
  let k = 0;
  return html.replace(/<h2>/g, () => {
    const heading = headings[k++];
    return heading && /^[a-z0-9-]+$/.test(heading.id) ? `<h2 id="${heading.id}">` : '<h2>';
  });
}

/**
 * Markdown → plain text, for excerpts and search chunks. Blocks are separated by a blank line
 * (`\n\n`); list items, table rows and code lines by a line break. Never HTML: show it with
 * `textContent` / Astro's `{}` (raw `<tags>` in the Markdown stay as literal text).
 */
export function markdownToText(md: string): string {
  const blocks: string[] = [];
  let current = '';
  let fence: string | null = null;
  const flush = () => {
    if (current.trim()) blocks.push(current.trim());
    current = '';
  };
  const add = (text: string, newLine: boolean) => {
    if (!text) return;
    current += current ? (newLine ? '\n' : ' ') + text : text;
  };
  for (const line of normalize(md).split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        fence = null;
        flush();
      } else {
        add(line.trimEnd(), true);
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      flush();
      fence = open[1]!;
      continue;
    }
    if (!line.trim() || HR.test(line)) {
      flush();
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(line)) continue;
    const t = line.replace(/^(?: {0,3}> ?)+/, '');
    const heading = HEADING.exec(t);
    if (heading) {
      flush();
      add(inlineText(heading[2] ?? ''), false);
      flush();
      continue;
    }
    const item = LIST.exec(t);
    if (item) {
      add(inlineText(item[3] ?? ''), true);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(t)) {
      add(tableCells(t).map(inlineText).filter(Boolean).join(' '), true);
      continue;
    }
    add(inlineText(t), false);
  }
  flush();
  return blocks.join('\n\n');
}
