import {describe, expect, it} from 'vitest';

import {decodeText, FileReadError, NOT_TEXT, TextFileError} from '../src/server/kb/sources/text';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('decodeText', () => {
  it('reads UTF-8 and keeps non-ASCII text', () => {
    expect(decodeText(utf8('# Café\n\nÜber 100 € — 日本語 😀'))).toBe('# Café\n\nÜber 100 € — 日本語 😀');
  });

  it('strips a byte-order mark', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Hello')]))).toBe('Hello');
  });

  it('turns CRLF and lone CR into LF', () => {
    expect(decodeText(utf8('a\r\nb\rc\n'))).toBe('a\nb\nc\n');
  });

  it('drops control characters but keeps tabs and newlines', () => {
    expect(decodeText(utf8('a\tb\u0007c\u001bd\u007f\ne'))).toBe('a\tbcd\ne');
  });

  it('refuses a file with NUL bytes (UTF-16, binary)', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(() => decodeText(utf16)).toThrow(TextFileError);
    expect(() => decodeText(utf16)).toThrow(NOT_TEXT);
  });

  it('refuses more than 1 % undecodable bytes, allows a few', () => {
    const latin1 = new Uint8Array([...utf8('caf'), 0xe9, ...utf8(' au lait')]); // 1 bad in 12
    expect(() => decodeText(latin1)).toThrow(FileReadError);
    const mostlyFine = new Uint8Array([...utf8('x'.repeat(500)), 0xe9, ...utf8('y'.repeat(500))]);
    expect(decodeText(mostlyFine)).toHaveLength(1001);
  });

  it('reads an empty file as empty text', () => {
    expect(decodeText(new Uint8Array())).toBe('');
  });
});
