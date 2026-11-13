/**
 * A Word file (.docx) → Markdown for the splitter (`split.ts`). Pure apart from
 * the platform's `DecompressionStream`; no package (see the plan's dependency table).
 *
 * The file is untrusted, so every step is bounded:
 * - ZIP: only the End Of Central Directory in the last 65,557 bytes is searched; ZIP64,
 *   multi-disk and more than 2,000 entries are refused; only `word/document.xml` and
 *   `word/styles.xml` are read; each one's declared size is capped and its compression
 *   ratio too (zip bombs); inflating stops at the declared size; the CRC-32 must match.
 * - XML: a linear scanner, no DOM and no regex that can backtrack on the input.
 *   `<!DOCTYPE` / `<!ENTITY` are refused; only the five XML entities and numeric
 *   references are decoded.
 * - Output: at most `maxTextChars`; the rest is left out with a warning.
 *
 * Headings (Title, Heading 1–3, also by the style's display name in styles.xml for
 * localized ids), list items, tables and line breaks are kept; pictures, fields' codes,
 * comments and footnotes are left out.
 */
import {KB_FILE_LIMITS} from '../../../lib/kb-file-types';
import {FileReadError} from './text';

export class DocxError extends FileReadError {
  override name = 'DocxError';
}

export interface DocxLimits {
  /** Uncompressed bytes of one part (`word/document.xml`). */
  docxMaxUncompressed: number;
  /** Uncompressed / compressed size of one part. */
  docxMaxRatio: number;
  /** Characters of Markdown returned. */
  maxTextChars: number;
}

export const DOCX_LIMITS: DocxLimits = {
  docxMaxUncompressed: KB_FILE_LIMITS.docxMaxUncompressed,
  docxMaxRatio: KB_FILE_LIMITS.docxMaxRatio,
  maxTextChars: KB_FILE_LIMITS.maxTextChars,
};

export const DOCX_WORDS = {
  notDocx: "This file isn't a Word document we can read. Save it as .docx and try again.",
  oldOrLocked:
    'This file is password-protected or an older Word file (.doc). Remove the password or save it as .docx, then try again.',
  encrypted: 'This document is password-protected. Remove the password and try again.',
  unsafe: "This file has parts we can't read safely.",
  tooBig: 'This document is too large to read. Split it into smaller files.',
  damaged: 'This file looks damaged. Open it in Word, save it again and try again.',
  pictures: 'Pictures were left out.',
  cut: 'Only the first part of the document was read: it is very long.',
} as const;

const MAX_ENTRIES = 2000;
const EOCD_SEARCH = 65_557; // 22-byte record + the largest comment
const DOCUMENT = 'word/document.xml';
const STYLES = 'word/styles.xml';

/** .docx bytes → Markdown. Throws `DocxError` (its message is for people). */
export async function docxToMarkdown(
  bytes: Uint8Array,
  limits: Partial<DocxLimits> = {}
): Promise<{markdown: string; warnings: string[]}> {
  const limit: DocxLimits = {...DOCX_LIMITS, ...limits};
  const entries = readCentralDirectory(bytes);
  const document = entries.get(DOCUMENT);
  if (!document) throw new DocxError(DOCX_WORDS.notDocx);
  const styles = entries.get(STYLES);

  const decoder = new TextDecoder('utf-8');
  const styleLevels = styles ? headingStyles(decoder.decode(await readEntry(bytes, styles, limit))) : new Map<string, number>();
  return documentToMarkdown(decoder.decode(await readEntry(bytes, document, limit)), styleLevels, limit.maxTextChars);
}

// --------------------------------------------------------------------- ZIP --

interface Entry {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** The two parts we read, by exact name. */
function readCentralDirectory(bytes: Uint8Array): Map<string, Entry> {
  if (bytes.length >= 8 && u32(bytes, 0) === 0xe011cfd0 && u32(bytes, 4) === 0xe11ab1a1) {
    // An OLE compound file: an old .doc or a password-protected .docx.
    throw new DocxError(DOCX_WORDS.oldOrLocked);
  }
  if (bytes.length < 22) throw new DocxError(DOCX_WORDS.notDocx);

  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - EOCD_SEARCH); at--) {
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new DocxError(DOCX_WORDS.notDocx);

  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (total === 0xffff || onDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new DocxError(DOCX_WORDS.unsafe);
  if (eocd >= 20 && u32(bytes, eocd - 20) === 0x07064b50) throw new DocxError(DOCX_WORDS.unsafe); // ZIP64 locator
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new DocxError(DOCX_WORDS.unsafe);
  if (total > MAX_ENTRIES) throw new DocxError(DOCX_WORDS.unsafe);
  if (cdOffset + cdSize > eocd) throw new DocxError(DOCX_WORDS.damaged);

  const found = new Map<string, Entry>();
  const names = new TextDecoder('utf-8');
  let at = cdOffset;
  for (let i = 0; i < total; i++) {
    if (at + 46 > cdOffset + cdSize || u32(bytes, at) !== 0x02014b50) throw new DocxError(DOCX_WORDS.damaged);
    const nameLength = u16(bytes, at + 28);
    const next = at + 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (next > cdOffset + cdSize) throw new DocxError(DOCX_WORDS.damaged);
    // Only short names can be ours: never decode a long one.
    if (nameLength === DOCUMENT.length || nameLength === STYLES.length) {
      const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      if (name === DOCUMENT || name === STYLES) {
        if (found.has(name)) throw new DocxError(DOCX_WORDS.unsafe);
        found.set(name, {
          flags: u16(bytes, at + 8),
          method: u16(bytes, at + 10),
          crc: u32(bytes, at + 16),
          compressedSize: u32(bytes, at + 20),
          size: u32(bytes, at + 24),
          offset: u32(bytes, at + 42),
        });
      }
    }
    at = next;
  }
  return found;
}

/** One part's bytes, checked against its declared size, ratio and CRC-32. */
async function readEntry(bytes: Uint8Array, entry: Entry, limit: DocxLimits): Promise<Uint8Array> {
  if (entry.flags & 0x41) throw new DocxError(DOCX_WORDS.encrypted); // bit 0 encrypted, bit 6 strong encryption
  if (entry.method !== 0 && entry.method !== 8) throw new DocxError(DOCX_WORDS.notDocx);
  if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) throw new DocxError(DOCX_WORDS.unsafe);
  if (entry.size > limit.docxMaxUncompressed) throw new DocxError(DOCX_WORDS.tooBig);
  if (entry.size / Math.max(1, entry.compressedSize) > limit.docxMaxRatio) throw new DocxError(DOCX_WORDS.unsafe);

  const local = entry.offset;
  if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new DocxError(DOCX_WORDS.damaged);
  const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new DocxError(DOCX_WORDS.damaged);

  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new DocxError(DOCX_WORDS.damaged);
    data = bytes.subarray(start, end);
  } else {
    data = await inflateRaw(bytes.slice(start, end), entry.size);
  }
  if (crc32(data) !== entry.crc) throw new DocxError(DOCX_WORDS.damaged);
  return data;
}

/** Raw deflate → exactly `size` bytes; more (a size that lies), less, or bad data → damaged. */
async function inflateRaw(compressed: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let length = 0;
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (length + value.length > size) throw new DocxError(DOCX_WORDS.damaged);
      out.set(value, length);
      length += value.length;
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error instanceof DocxError ? error : new DocxError(DOCX_WORDS.damaged);
  }
  if (length !== size) throw new DocxError(DOCX_WORDS.damaged);
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --------------------------------------------------------------------- XML --

interface XmlVisitor {
  open(name: string, tag: string, selfClosing: boolean): void;
  close(name: string): void;
  text(raw: string, cdata: boolean): void;
}

/** Stops a scan early (output cap reached). */
class StopScan extends Error {}

/**
 * Calls the visitor for each tag and each run of text, left to right. Each character
 * is read once or twice. `<!DOCTYPE`, `<!ENTITY` and any other `<!…>` declaration are refused.
 */
function scanXml(xml: string, visit: XmlVisitor): void {
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf('<', at);
    if (lt === -1) {
      visit.text(xml.slice(at), false);
      return;
    }
    if (lt > at) visit.text(xml.slice(at, lt), false);

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new DocxError(DOCX_WORDS.damaged);
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new DocxError(DOCX_WORDS.damaged);
      visit.text(xml.slice(lt + 9, end), true);
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new DocxError(DOCX_WORDS.unsafe);
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new DocxError(DOCX_WORDS.damaged);
      at = end + 2;
      continue;
    }

    // A tag: up to the `>` outside quotes.
    let end = lt + 1;
    let quote = '';
    for (; end < xml.length; end++) {
      const ch = xml[end];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end >= xml.length) throw new DocxError(DOCX_WORDS.damaged);
    const tag = xml.slice(lt + 1, end);
    at = end + 1;
    if (tag.startsWith('/')) {
      visit.close(tag.slice(1).trim());
      continue;
    }
    const selfClosing = tag.endsWith('/');
    let nameEnd = 0;
    while (nameEnd < tag.length && !' \t\r\n/'.includes(tag[nameEnd]!)) nameEnd++;
    visit.open(tag.slice(0, nameEnd), tag, selfClosing);
  }
}

/** The value of attribute `name` in a tag's text, entities decoded; undefined when absent. */
function attribute(tag: string, name: string): string | undefined {
  let from = 0;
  for (;;) {
    const at = tag.indexOf(name, from);
    if (at === -1) return undefined;
    from = at + name.length;
    const before = tag[at - 1];
    if (before !== ' ' && before !== '\t' && before !== '\r' && before !== '\n') continue;
    let i = from;
    while (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\r' || tag[i] === '\n') i++;
    if (tag[i] !== '=') continue;
    i++;
    while (tag[i] === ' ' || tag[i] === '\t' || tag[i] === '\r' || tag[i] === '\n') i++;
    const quote = tag[i];
    if (quote !== '"' && quote !== "'") return undefined;
    const close = tag.indexOf(quote, i + 1);
    if (close === -1) return undefined;
    return decodeEntities(tag.slice(i + 1, close));
  }
}

const NAMED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

const validCodePoint = (n: number) =>
  n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

/** The five XML entities and numeric references; anything else stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let from = 0;
  let semi = -1; // the first `;` after the current `&`, searched again only once passed (linear)
  for (let amp = text.indexOf('&'); amp !== -1; amp = text.indexOf('&', amp + 1)) {
    if (semi <= amp) semi = text.indexOf(';', amp + 1);
    if (semi === -1) break;
    if (semi - amp > 10) continue;
    const ref = text.slice(amp + 1, semi);
    let value = NAMED.get(ref);
    if (value === undefined && (/^#x[0-9a-fA-F]{1,6}$/.test(ref) || /^#[0-9]{1,7}$/.test(ref))) {
      const n = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      value = validCodePoint(n) ? String.fromCodePoint(n) : '';
    }
    if (value === undefined) continue;
    out += text.slice(from, amp) + value;
    from = semi + 1;
    amp = semi;
  }
  return out + text.slice(from);
}

// ------------------------------------------------------------------ styles --

/** styles.xml → paragraph style id → heading level (Title and Heading 1 → 1, Heading 2 → 2, Heading 3 → 3). */
function headingStyles(xml: string): Map<string, number> {
  const levels = new Map<string, number>();
  let styleId: string | null = null;
  scanXml(xml, {
    open(name, tag, selfClosing) {
      if (name === 'w:style') {
        styleId = attribute(tag, 'w:type') === 'paragraph' ? (attribute(tag, 'w:styleId') ?? null) : null;
        if (selfClosing) styleId = null;
      } else if (name === 'w:name' && styleId !== null) {
        const level = levelOfName((attribute(tag, 'w:val') ?? '').trim().toLowerCase());
        if (level) levels.set(styleId, level);
      }
    },
    close(name) {
      if (name === 'w:style') styleId = null;
    },
    text() {},
  });
  return levels;
}

function levelOfName(name: string): number {
  if (name === 'title') return 1;
  if (name === 'heading 1') return 1;
  if (name === 'heading 2') return 2;
  if (name === 'heading 3') return 3;
  return 0;
}

function levelOfStyle(styleId: string, levels: Map<string, number>): number {
  const known = levels.get(styleId);
  if (known) return known;
  if (styleId.length > 20) return 0;
  if (/^title$/i.test(styleId)) return 1;
  const match = /^heading([1-3])$/i.exec(styleId);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------- document --

interface Paragraph {
  style: string;
  list: boolean;
  numId: string;
  level: number;
  text: string[];
}

interface Table {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
}

interface Block {
  list: boolean;
  text: string;
}

/** Elements whose whole content is left out. The first four are pictures. */
const PICTURES = new Set(['w:drawing', 'w:pict', 'w:object', 'mc:AlternateContent']);
const SKIPPED = new Set([...PICTURES, 'w:instrText', 'w:delText', 'w:footnoteReference', 'w:commentReference']);

function documentToMarkdown(xml: string, styleLevels: Map<string, number>, maxChars: number): {markdown: string; warnings: string[]} {
  const warnings = new Set<string>();
  const blocks: Block[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];
  let length = 0;
  let skip = 0;
  let inProps = 0; // inside <w:pPr>: tabs there are tab stops, not text
  let inText = false;
  let preserve = false;
  let pending = '';

  const add = (block: Block) => {
    const room = maxChars - length - (blocks.length ? 2 : 0);
    if (block.text.length > room) {
      if (room > 0) blocks.push({list: block.list, text: block.text.slice(0, room)});
      warnings.add(DOCX_WORDS.cut);
      throw new StopScan();
    }
    length += block.text.length + (blocks.length ? 2 : 0);
    blocks.push(block);
  };

  const finishParagraph = (p: Paragraph) => {
    const raw = p.text.join('').replace(/\t/g, ' ');
    const table = tables[tables.length - 1];
    if (table?.cell) {
      const flat = raw.replace(/\s+/g, ' ').trim();
      if (flat) table.cell.push(flat);
      return;
    }
    const level = p.style ? levelOfStyle(p.style, styleLevels) : 0;
    if (level) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text) add({list: false, text: `${'#'.repeat(level)} ${text}`});
      return;
    }
    const lines = raw
      .split('\n')
      .map(line => escapeLineStart(line.replace(/ {2,}/g, ' ').trim()))
      .filter(Boolean);
    if (!lines.length) return;
    if (p.list && p.numId !== '0') {
      add({list: true, text: `${p.level > 0 ? '  ' : ''}- ${lines.join(' ')}`});
    } else add({list: false, text: lines.join('\n')});
  };

  const finishTable = (t: Table) => {
    const rows = t.rows.filter(row => row.some(cell => cell !== ''));
    if (!rows.length) return;
    const outer = tables[tables.length - 1];
    if (outer?.cell) {
      outer.cell.push(rows.map(row => row.filter(Boolean).join(' ')).join(' '));
      return;
    }
    const width = rows[0]!.length;
    if (width > 0 && rows.every(row => row.length === width)) {
      const line = (row: string[]) => `| ${row.map(cell => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
      const head = [line(rows[0]!), `| ${Array.from({length: width}, () => '---').join(' | ')} |`];
      add({list: false, text: [...head, ...rows.slice(1).map(line)].join('\n')});
    } else {
      for (const row of rows) {
        const text = row.filter(Boolean).join(' | ');
        if (text) add({list: false, text: escapeLineStart(text)});
      }
    }
  };

  const visitor: XmlVisitor = {
    open(name, tag, selfClosing) {
      if (skip) {
        if (!selfClosing) skip++;
        return;
      }
      if (SKIPPED.has(name)) {
        if (PICTURES.has(name)) warnings.add(DOCX_WORDS.pictures);
        if (!selfClosing) skip = 1;
        return;
      }
      const p = paragraphs[paragraphs.length - 1];
      switch (name) {
        case 'w:p':
          if (!selfClosing) paragraphs.push({style: '', list: false, numId: '', level: 0, text: []});
          return;
        case 'w:pPr':
          if (!selfClosing) inProps++;
          return;
        case 'w:pStyle':
          if (p && inProps) p.style = attribute(tag, 'w:val') ?? '';
          return;
        case 'w:numPr':
          if (p && inProps) p.list = true;
          return;
        case 'w:ilvl':
          if (p && inProps) p.level = Number(attribute(tag, 'w:val')) || 0;
          return;
        case 'w:numId':
          if (p && inProps) p.numId = attribute(tag, 'w:val') ?? '';
          return;
        case 'w:t':
          if (!selfClosing) {
            inText = true;
            preserve = attribute(tag, 'xml:space') === 'preserve';
            pending = '';
          }
          return;
        case 'w:tab':
          if (p && !inProps) p.text.push(' ');
          return;
        case 'w:br': {
          const type = attribute(tag, 'w:type');
          if (p && !inProps) p.text.push(type === 'page' || type === 'column' ? ' ' : '\n');
          return;
        }
        case 'w:cr':
          if (p && !inProps) p.text.push('\n');
          return;
        case 'w:noBreakHyphen':
          if (p && !inProps) p.text.push('-');
          return;
        case 'w:tbl':
          if (!selfClosing) tables.push({rows: [], row: null, cell: null});
          return;
        case 'w:tr': {
          const t = tables[tables.length - 1];
          if (t && !selfClosing) t.row = [];
          return;
        }
        case 'w:tc': {
          const t = tables[tables.length - 1];
          if (t?.row && !selfClosing) t.cell = [];
          else if (t?.row) t.row.push('');
          return;
        }
      }
    },
    close(name) {
      if (skip) {
        skip--;
        return;
      }
      switch (name) {
        case 'w:t': {
          if (!inText) return;
          inText = false;
          let text = decodeEntities(pending);
          pending = '';
          if (!preserve) text = text.trim();
          const p = paragraphs[paragraphs.length - 1];
          if (p && text) p.text.push(text);
          return;
        }
        case 'w:pPr':
          if (inProps) inProps--;
          return;
        case 'w:p': {
          const p = paragraphs.pop();
          if (p) finishParagraph(p);
          return;
        }
        case 'w:tc': {
          const t = tables[tables.length - 1];
          if (t?.row && t.cell) t.row.push(t.cell.join(' '));
          if (t) t.cell = null;
          return;
        }
        case 'w:tr': {
          const t = tables[tables.length - 1];
          if (t?.row) t.rows.push(t.row);
          if (t) t.row = null;
          return;
        }
        case 'w:tbl': {
          const t = tables.pop();
          if (t) finishTable(t);
          return;
        }
      }
    },
    text(raw, cdata) {
      if (inText && !skip) pending += cdata ? raw.replace(/&/g, '&amp;') : raw;
    },
  };

  try {
    scanXml(xml, visitor);
  } catch (error) {
    if (!(error instanceof StopScan)) throw error;
  }

  let markdown = '';
  blocks.forEach((block, i) => {
    if (i > 0) markdown += blocks[i - 1]!.list && block.list ? '\n' : '\n\n';
    markdown += block.text;
  });
  return {markdown, warnings: [...warnings]};
}

/** A paragraph line that would read as a heading or a code fence in Markdown gets a backslash. */
function escapeLineStart(line: string): string {
  return line.startsWith('#') || line.startsWith('```') || line.startsWith('~~~') ? `\\${line}` : line;
}
