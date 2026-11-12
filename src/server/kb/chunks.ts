import {markdownToText} from '../../lib/markdown';

/**
 * What search (and, later, the assistant) reads: a PUBLISHED article split by
 * its `##` / `###` headings, or one snippet, as rows of `kb_chunks`. Built by
 * the manage routes (src/server/routes/kb-manage.ts) in the same transaction
 * as the article or snippet they come from.
 *
 * Plain text only (`markdownToText`): no markup reaches the index. The limits
 * match the columns (`heading` 200, `text` 2000) and keep one article's rows
 * bounded (60).
 */

export const CHUNK_LIMITS = {heading: 200, text: 2000, perArticle: 60} as const;

export interface ChunkRow {
  position: number;
  heading: string;
  text: string;
}

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const SECTION = /^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$/;

/** The body's blocks (blank-line separated; a fenced code block is one block). */
function blocksOf(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!fenced) flush();
      current.push(line);
      fenced = !fenced;
      if (!fenced) flush();
      continue;
    }
    if (!fenced && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** Plain-text pieces of one section, each ≤ the text limit, split between paragraphs. */
function piecesOf(lines: string[]): string[] {
  const max = CHUNK_LIMITS.text;
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current) pieces.push(current);
    current = '';
  };
  for (const block of blocksOf(lines)) {
    let text = markdownToText(block).trim();
    if (!text) continue;
    if (current && current.length + 2 + text.length <= max) {
      current += '\n\n' + text;
      continue;
    }
    push();
    // One paragraph longer than a chunk: cut it at a space where there is one.
    while (text.length > max) {
      let at = text.lastIndexOf(' ', max);
      if (at < max / 2) at = max;
      pieces.push(cut(text, at).trim());
      text = text.slice(cut(text, at).length).trim();
    }
    current = text;
  }
  push();
  return pieces;
}

/**
 * An article's chunks: the text before the first `##`/`###` heading under the
 * article's title, then one section per heading (`Title — Section`), long
 * sections split between paragraphs. At most 60, in order (`position` 0…).
 */
export function chunkArticle(title: string, body: string): ChunkRow[] {
  const cleanTitle = title.trim();
  const sections: {heading: string; lines: string[]}[] = [{heading: cleanTitle, lines: []}];
  let fenced = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : SECTION.exec(line);
    if (match) {
      const name = markdownToText(match[1]).replace(/\s+/g, ' ').trim();
      sections.push({heading: name ? `${cleanTitle} — ${name}` : cleanTitle, lines: []});
    } else {
      sections.at(-1)!.lines.push(line);
    }
  }

  const rows: ChunkRow[] = [];
  for (const section of sections) {
    for (const text of piecesOf(section.lines)) {
      if (rows.length >= CHUNK_LIMITS.perArticle) return rows;
      rows.push({position: rows.length, heading: cut(section.heading, CHUNK_LIMITS.heading).trim(), text});
    }
  }
  // A body with no text at all still makes the article findable by its title.
  if (!rows.length && cleanTitle) {
    rows.push({position: 0, heading: cut(cleanTitle, CHUNK_LIMITS.heading), text: cut(cleanTitle, CHUNK_LIMITS.text)});
  }
  return rows;
}

/** A snippet's one chunk: the question as the heading, the answer as the text. */
export function chunkSnippet(question: string, answer: string): ChunkRow[] {
  return [
    {
      position: 0,
      heading: cut(question.trim(), CHUNK_LIMITS.heading),
      text: cut(answer.trim(), CHUNK_LIMITS.text),
    },
  ];
}
