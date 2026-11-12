/**
 * The knowledge-base import, browser side (`/dashboard/import`): a CSV of
 * questions and answers becomes snippets, pasted Markdown becomes draft
 * articles. Everything here is pure and browser-safe, so it can be tested
 * without a DOM. The server checks every row again (`POST /kb/manage/import`).
 */
import {KB_LIMITS, type KbImportRow} from './kb-types';

/** One request: at most this many rows… */
export const IMPORT_BATCH_ROWS = KB_LIMITS.importBatch;
/** …and at most this many bytes of JSON. */
export const IMPORT_BATCH_BYTES = 64 * 1024;
/** A bigger CSV file is refused before it is read. */
export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** More rows than this in one import are refused (split the file). */
export const IMPORT_MAX_ROWS = 5000;

/** A row ready to send, or the reason it can't be. `line` is where it starts in the source (1-based). */
export interface PreparedRow {
  line: number;
  /** What the row is called in results ("How do I…?", "Grinding guide"). */
  label: string;
  row: KbImportRow | null;
  error: string | null;
}

// --------------------------------------------------------------------- CSV --

export interface CsvRecord {
  /** The line the record starts on (1-based). */
  line: number;
  fields: string[];
}

/**
 * RFC 4180: fields separated by commas, records by CRLF, LF or CR; a field in
 * double quotes may hold commas, line breaks and `""` (one quote). A leading
 * byte order mark is dropped. Throws an Error in words on an unclosed quote.
 */
export function parseCsv(text: string): CsvRecord[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // A blank line is no record.
    if (!(fields.length === 1 && fields[0] === '')) records.push({line: recordLine, fields});
    fields = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && input[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      // Text after a closing quote ("a"b) is kept as written, like spreadsheets do.
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error(`A quote opened on line ${quoteLine} is never closed. Check that every " inside a field is written as "".`);
  if (fieldStarted || field || fields.length) endRecord();
  return records;
}

/**
 * A CSV with a `question,answer` header row (any order, any case, other
 * columns ignored) → one snippet per row. Throws an Error in words when the
 * file itself can't be used (no header, no rows, too many rows).
 */
export function csvToSnippetRows(text: string): PreparedRow[] {
  const records = parseCsv(text);
  const header = records.shift();
  if (!header) throw new Error('The file is empty. Add a header row "question,answer" and one row per question.');
  const names = header.fields.map(name => name.trim().toLowerCase());
  const q = names.indexOf('question');
  const a = names.indexOf('answer');
  if (q === -1 || a === -1)
    throw new Error('The first row must name the columns "question" and "answer" (for example: question,answer).');
  if (!records.length) throw new Error('The file has a header row but no questions under it.');
  if (records.length > IMPORT_MAX_ROWS)
    throw new Error(`The file has ${records.length.toLocaleString()} rows; import at most ${IMPORT_MAX_ROWS.toLocaleString()} at a time. Split it into smaller files.`);

  return records.map(({line, fields}): PreparedRow => {
    const question = (fields[q] ?? '').trim();
    const answer = (fields[a] ?? '').trim();
    const label = question || `Row on line ${line}`;
    const error = !question
      ? 'The question is empty.'
      : question.length > KB_LIMITS.snippetQuestion
        ? `The question is ${question.length} characters; use at most ${KB_LIMITS.snippetQuestion}.`
        : !answer
          ? 'The answer is empty.'
          : answer.length > KB_LIMITS.snippetAnswer
            ? `The answer is ${answer.length} characters; use at most ${KB_LIMITS.snippetAnswer}.`
            : null;
    return {line, label, error, row: error ? null : {kind: 'snippet', question, answer}};
  });
}

// ---------------------------------------------------------------- Markdown --

/**
 * Pasted Markdown → one draft article per `# ` heading (a line starting with
 * exactly one `#` and a space, outside fenced code). The heading is the title;
 * everything up to the next one is the body. `preamble` is the text before
 * the first heading, which is not imported.
 */
export function splitMarkdownArticles(markdown: string, categoryId: number): {rows: PreparedRow[]; preamble: boolean} {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const found: {line: number; title: string; body: string[]}[] = [];
  const preamble: string[] = [];
  let fence: string | null = null;

  lines.forEach((text, i) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    const heading = !fence && !marker ? /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(text) : null;
    if (heading) found.push({line: i + 1, title: heading[1]!.trim(), body: []});
    else if (found.length) found[found.length - 1]!.body.push(text);
    else preamble.push(text);
  });

  const rows = found.map(({line, title, body}): PreparedRow => {
    const text = body.join('\n').trim();
    const error =
      title.length > KB_LIMITS.articleTitle
        ? `The title is ${title.length} characters; use at most ${KB_LIMITS.articleTitle}.`
        : !text
          ? 'There is no text under this heading.'
          : text.length > KB_LIMITS.articleBody
            ? `The article is ${text.length.toLocaleString()} characters; use at most ${KB_LIMITS.articleBody.toLocaleString()}.`
            : null;
    return {line, label: title, error, row: error ? null : {kind: 'article', title, body: text, categoryId}};
  });
  return {rows, preamble: preamble.join('').trim() !== ''};
}

// ----------------------------------------------------------------- batches --

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * Groups the rows (by their index in `rows`) into requests of at most
 * `maxRows` rows and `maxBytes` of JSON (`{"rows":[…]}`). A row too big to
 * fit any request alone comes back in `tooBig`.
 */
export function planBatches(
  rows: KbImportRow[],
  maxRows: number = IMPORT_BATCH_ROWS,
  maxBytes: number = IMPORT_BATCH_BYTES
): {batches: number[][]; tooBig: number[]} {
  const base = bytes({rows: []});
  const batches: number[][] = [];
  const tooBig: number[] = [];
  let current: number[] = [];
  let size = base;
  rows.forEach((row, index) => {
    const own = bytes(row);
    if (base + own > maxBytes) {
      tooBig.push(index);
      return;
    }
    const extra = own + (current.length ? 1 : 0);
    if (current.length >= maxRows || size + extra > maxBytes) {
      batches.push(current);
      current = [];
      size = base;
    }
    size += own + (current.length ? 1 : 0);
    current.push(index);
  });
  if (current.length) batches.push(current);
  return {batches, tooBig};
}
