/**
 * A knowledge file's Markdown (from `text.ts`, `docx.ts` or the PDF reader) →
 * draft articles. Pure: no I/O.
 *
 * 1. If the text has a `# ` heading outside code fences, each one starts a draft.
 *    Text before the first heading becomes a draft titled from the file name.
 * 2. Else, with two or more `## ` headings, the same one level down.
 * 3. Else one draft titled from the file name.
 * 4. A body over `partChars` characters or `partBytes` UTF-8 bytes is cut at blank
 *    lines (never inside a code fence when it can be helped) into
 *    "Title (part 2)", "Title (part 3)", ….
 * 5. Empty bodies are dropped; at most `maxDrafts` drafts, the rest counted in `dropped`.
 *
 * Link and image targets that are not `https://` are removed (the text stays):
 * the file is untrusted. Linear scanners only, no regex that can backtrack on long lines.
 */
import {KB_FILE_LIMITS} from '../../../lib/kb-file-types';
import {KB_LIMITS} from '../../../lib/kb-types';

export interface SplitDraft {
  title: string;
  body: string;
}

export interface SplitResult {
  drafts: SplitDraft[];
  /** Sections left out because of the `maxDrafts` cap. */
  dropped: number;
}

export const SPLIT_LIMITS = {
  /** Characters in one draft body (well under `KB_LIMITS.articleBody`). */
  partChars: 20_000,
  /** UTF-8 bytes in one draft body (well under `KB_LIMITS.articleBodyBytes`). */
  partBytes: 24_000,
  /** Drafts made from one file. */
  maxDrafts: KB_FILE_LIMITS.maxDrafts,
} as const;

const UNTITLED = 'Untitled section';
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function splitIntoDrafts(markdown: string, fileName: string): SplitResult {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const fileTitle = titleFromFileName(fileName);
  const level = countHeadings(lines, 1) >= 1 ? 1 : countHeadings(lines, 2) >= 2 ? 2 : 0;

  const sections: {title: string; lines: string[]}[] = [{title: fileTitle, lines: []}];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    const title = level && !fence && !marker ? headingText(line, level) : null;
    if (title !== null) sections.push({title, lines: []});
    else sections[sections.length - 1]!.lines.push(fence || marker ? line : safeLinks(line));
  }

  const drafts: SplitDraft[] = [];
  let total = 0;
  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;
    const parts = cutIntoParts(body);
    parts.forEach((part, i) => {
      total++;
      if (drafts.length < SPLIT_LIMITS.maxDrafts) {
        drafts.push({title: cleanTitle(section.title, i === 0 ? '' : ` (part ${i + 1})`), body: part});
      }
    });
  }
  return {drafts, dropped: total - drafts.length};
}

// ------------------------------------------------------------------ titles --

/** "Guide v2.docx" → "Guide v2". */
export function titleFromFileName(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && base.length - dot <= 10 ? base.slice(0, dot) : base;
}

/** A UTF-16 surrogate without its pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Format characters: bidi controls (U+202A–202E, U+2066–2069), zero-width (U+200B–200F, U+2060), U+FEFF, … */
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * One line, no control characters, no hidden format characters (a bidi override could make a
 * title read differently from what it is), no broken surrogates, at most `KB_LIMITS.articleTitle`
 * with the suffix.
 */
export function cleanTitle(raw: string, suffix = ''): string {
  let title = raw
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(FORMAT_CHARS, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) title = UNTITLED;
  const room = KB_LIMITS.articleTitle - suffix.length;
  if (title.length > room) title = cutAt(title, room).trimEnd();
  return title + suffix;
}

/** A heading of exactly `level` `#`s at the start of the line, or null. Its text without closing `#`s. */
function headingText(line: string, level: number): string | null {
  for (let i = 0; i < level; i++) if (line.charCodeAt(i) !== 35) return null;
  const next = line[level];
  if (next !== ' ' && next !== '\t') return null;
  let text = line.slice(level + 1).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trimEnd();
  return text ? text : null;
}

function countHeadings(lines: string[], level: number): number {
  let count = 0;
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (!fence && headingText(line, level) !== null) count++;
  }
  return count;
}

// ------------------------------------------------------------------- links --

/**
 * `[text](target)` and `![alt](target)` whose target is not `https://` → the text.
 * One pass: each character is looked at a bounded number of times.
 */
export function safeLinks(line: string): string {
  if (!line.includes('](')) return line;
  let out = '';
  let from = 0; // copied up to here
  let search = 0;
  for (;;) {
    const mid = line.indexOf('](', search);
    if (mid === -1) break;
    // The label: back to the nearest `[`, stopping at another `]` (linear overall).
    let open = mid - 1;
    while (open >= from && line[open] !== '[' && line[open] !== ']') open--;
    if (open < from || line[open] !== '[') {
      search = mid + 2;
      continue;
    }
    // The target: up to the `)` that closes it (one level of nested parentheses), stopping at `[` / `]`.
    let depth = 0;
    let close = -1;
    let end = mid + 2;
    for (; end < line.length; end++) {
      const ch = line[end];
      if (ch === '[' || ch === ']') break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          close = end;
          break;
        }
        depth--;
      }
    }
    if (close === -1) {
      search = Math.max(end, mid + 2);
      continue;
    }
    const target = line.slice(mid + 2, close).trim();
    if (!/^https:\/\//i.test(target) || /[\u0000-\u001f\u007f]/.test(target)) {
      const image = open > from && line[open - 1] === '!';
      out += line.slice(from, image ? open - 1 : open) + line.slice(open + 1, mid);
      from = close + 1;
    }
    search = close + 1;
  }
  return from === 0 ? line : out + line.slice(from);
}

// ------------------------------------------------------------------- parts --

/** UTF-8 length without allocating. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A body → parts that each fit, cut at blank lines outside code fences when possible. */
function cutIntoParts(body: string): string[] {
  if (body.length <= SPLIT_LIMITS.partChars && utf8Length(body) <= SPLIT_LIMITS.partBytes) return [body];
  const parts: string[] = [];
  let current: string[] = [];
  let chars = 0;
  let bytes = 0;
  const flush = () => {
    const text = current.join('\n\n').trim();
    if (text) parts.push(text);
    current = [];
    chars = 0;
    bytes = 0;
  };
  for (const unit of blocksOf(body)) {
    const unitChars = unit.length;
    const unitBytes = utf8Length(unit);
    const sep = current.length ? 2 : 0;
    if (chars + sep + unitChars <= SPLIT_LIMITS.partChars && bytes + sep + unitBytes <= SPLIT_LIMITS.partBytes) {
      current.push(unit);
      chars += sep + unitChars;
      bytes += sep + unitBytes;
      continue;
    }
    flush();
    if (unitChars <= SPLIT_LIMITS.partChars && unitBytes <= SPLIT_LIMITS.partBytes) {
      current.push(unit);
      chars = unitChars;
      bytes = unitBytes;
    } else for (const piece of hardCut(unit)) parts.push(piece);
  }
  flush();
  return parts;
}

/** Paragraph-sized blocks: split at blank lines, except inside a code fence. */
function blocksOf(body: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    if (!fence && !marker && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * One block too big for a part: cut at line ends, else inside a line (at a space when
 * one is near). A code fence is closed at the end of each piece and opened again.
 */
function hardCut(block: string): string[] {
  const lines = block.split('\n');
  const opener = FENCE.exec(lines[0]!) ? lines[0]! : null;
  const closer = opener ? FENCE.exec(opener)![1]! : null;
  // Room for the fence lines added around each piece.
  const extra = opener ? opener.length + closer!.length + 2 : 0;
  const maxChars = SPLIT_LIMITS.partChars - extra;
  const maxBytes = SPLIT_LIMITS.partBytes - (opener ? utf8Length(opener) + closer!.length + 2 : 0);

  const pieces: string[] = [];
  let current: string[] = [];
  let chars = 0;
  let bytes = 0;
  const flush = () => {
    if (current.length) pieces.push(current.join('\n'));
    current = [];
    chars = 0;
    bytes = 0;
  };
  for (let line of lines) {
    for (;;) {
      const lineBytes = utf8Length(line);
      const sep = current.length ? 1 : 0;
      if (chars + sep + line.length <= maxChars && bytes + sep + lineBytes <= maxBytes) {
        current.push(line);
        chars += sep + line.length;
        bytes += sep + lineBytes;
        break;
      }
      if (current.length) {
        flush();
        continue;
      }
      // A single line longer than a part.
      const cut = prefixLength(line, maxChars, maxBytes);
      current.push(line.slice(0, cut).trimEnd());
      flush();
      line = line.slice(cut).trimStart();
      if (!line) break;
    }
  }
  flush();
  if (!opener) return pieces;
  return pieces.map((piece, i) => {
    let text = piece;
    if (i > 0) text = `${opener}\n${text}`;
    if (i < pieces.length - 1) text = `${text}\n${closer}`;
    return text;
  });
}

/** How much of `line` fits in `maxChars` / `maxBytes`, preferring to end at a space; never splits a surrogate pair. */
function prefixLength(line: string, maxChars: number, maxBytes: number): number {
  let bytes = 0;
  let end = 0;
  while (end < line.length && end < maxChars) {
    const c = line.charCodeAt(end);
    const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < line.length;
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    const width = pair ? 2 : 1;
    if (bytes + size > maxBytes || end + width > maxChars) break;
    bytes += size;
    end += width;
  }
  const space = line.lastIndexOf(' ', end);
  return space > end - 1000 && space > 0 ? space : Math.max(end, 1);
}

/** `text` cut to at most `max` characters without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  let end = Math.max(0, max);
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}
