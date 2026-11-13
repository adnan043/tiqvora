/**
 * A knowledge file's bytes (.txt / .md) → text for the splitter (`split.ts`).
 * Pure: no I/O. The caller caps the bytes before this runs (KB_FILE_LIMITS.textBytes).
 *
 * UTF-8 only. A file with NUL bytes (UTF-16, a binary file renamed .txt) or with
 * more than 1 % undecodable characters is refused with words for people.
 */

/** A file we could not read. `message` is shown to people as is. */
export class FileReadError extends Error {
  override name = 'FileReadError';
}

/** `decodeText` refused the bytes. */
export class TextFileError extends FileReadError {
  override name = 'TextFileError';
}

export const NOT_TEXT = "This doesn't look like a text file. Save it as UTF-8 text and try again.";

/** Share of U+FFFD (undecodable bytes) above which the file is refused. */
const MAX_BAD_SHARE = 0.01;

/**
 * UTF-8 bytes → text with `\n` line ends. Strips a byte-order mark and control
 * characters other than tab and newline. Throws `TextFileError` (words for people).
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new TextFileError(NOT_TEXT);
  // Non-fatal: bad bytes become U+FFFD and are counted below. `ignoreBOM: false` strips a leading BOM.
  let text = new TextDecoder('utf-8', {fatal: false, ignoreBOM: false}).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let bad = 0;
  for (let at = text.indexOf('�'); at !== -1; at = text.indexOf('�', at + 1)) bad++;
  if (bad > 0 && bad > text.length * MAX_BAD_SHARE) throw new TextFileError(NOT_TEXT);

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
