import {describe, expect, it} from 'vitest';

import {KB_FILE_LIMITS, KB_FILE_MESSAGES, kbFileProblem} from '../src/lib/kb-file-types';
import {pageInstruction, pageRange, parseTranscript, pdfHold, toBase64, tooLongMessage, unreadablePageNote} from '../src/server/kb/sources/pdf';

/** The PDF reader's pure helpers (src/server/kb/sources/pdf.ts) and the shared file-name rules. */

const reply = (o: Record<string, unknown>) => JSON.stringify(o);

describe('parseTranscript', () => {
  it('accepts a reply inside the asked range', () => {
    expect(parseTranscript(reply({pageCount: 10, lastPage: 4, markdown: '# One\n\nText.'}), 1, 4)).toEqual({pageCount: 10, lastPage: 4, markdown: '# One\n\nText.'});
    // Fewer pages than asked (the document ends) is fine.
    expect(parseTranscript(reply({pageCount: 3, lastPage: 3, markdown: ''}), 1, 4)).toEqual({pageCount: 3, lastPage: 3, markdown: ''});
  });

  const nulls: [string, string][] = [
    ['not JSON', '{"pageCount": 1'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['pageCount missing', reply({lastPage: 1, markdown: ''})],
    ['pageCount 0', reply({pageCount: 0, lastPage: 1, markdown: ''})],
    ['pageCount over 600', reply({pageCount: 601, lastPage: 1, markdown: ''})],
    ['pageCount a string', reply({pageCount: '10', lastPage: 1, markdown: ''})],
    ['pageCount a fraction', reply({pageCount: 1.5, lastPage: 1, markdown: ''})],
    ['lastPage before the range', reply({pageCount: 10, lastPage: 4, markdown: ''})],
    ['lastPage after the range', reply({pageCount: 10, lastPage: 9, markdown: ''})],
    ['lastPage past pageCount', reply({pageCount: 5, lastPage: 6, markdown: ''})],
    ['markdown missing', reply({pageCount: 10, lastPage: 6})],
    ['markdown not a string', reply({pageCount: 10, lastPage: 6, markdown: 42})],
    ['markdown over 40,000 characters', reply({pageCount: 10, lastPage: 6, markdown: 'x'.repeat(40_001)})],
  ];
  for (const [name, text] of nulls) {
    it(`null for ${name}`, () => {
      expect(parseTranscript(text, 5, 8)).toBeNull();
    });
  }

  it('drops control characters (keeps tab and newline), lines that are only an HTML tag, and normalises CRLF', () => {
    const markdown = 'Line\u0000 one\r\n<div class="x">\r\nTab\there\u0007\r<img src="a.png"/>\n  </span>  \nA <b>bold</b> word end\u007f';
    const out = parseTranscript(reply({pageCount: 1, lastPage: 1, markdown}), 1, 1)!;
    expect(out.markdown).toBe('Line one\nTab\there\nA <b>bold</b> wordend');
    expect(out.markdown).not.toContain('\r');
  });
});

describe('toBase64', () => {
  it('matches Buffer for every length around the slice size, and has no newlines', () => {
    const SLICE = 3 * 0x4000;
    for (const n of [0, 1, 2, 3, 4, 100, SLICE - 1, SLICE, SLICE + 1, SLICE + 2, 2 * SLICE + 1, 200_003]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const out = toBase64(bytes);
      expect(out, `length ${n}`).toBe(Buffer.from(bytes).toString('base64'));
      expect(out).not.toMatch(/\s/);
    }
  });
});

describe('tooLongMessage', () => {
  it('null up to the cap, words above it (at least "about 1 page")', () => {
    expect(tooLongMessage(1)).toBeNull();
    expect(tooLongMessage(KB_FILE_LIMITS.pdfMaxInputTokens)).toBeNull();
    expect(tooLongMessage(KB_FILE_LIMITS.pdfMaxInputTokens + 1)).toBe(
      'This PDF is too long to read in one go (about 45 pages). Split it into smaller files.'
    );
    expect(tooLongMessage(200_000)).toContain('about 100 pages');
  });
});

describe('pageRange and the instruction', () => {
  it('starts at the step (1 when not started) and asks for perCall pages (at least one)', () => {
    expect(pageRange(0, 4)).toEqual({from: 1, to: 4});
    expect(pageRange(1, 4)).toEqual({from: 1, to: 4});
    expect(pageRange(9, 2)).toEqual({from: 9, to: 10});
    expect(pageRange(5, 1)).toEqual({from: 5, to: 5});
    expect(pageRange(5, 0)).toEqual({from: 5, to: 5});
    expect(pageInstruction(5, 5)).toBe('Transcribe page 5 only.');
    expect(pageInstruction(1, 4)).toBe('Transcribe pages 1 to 4 only.');
    expect(unreadablePageNote(7)).toBe('> [Page 7 could not be read.]');
  });
});

describe('pdfHold', () => {
  it('grows with the input and covers the full reply', () => {
    let last = -1;
    for (const tokens of [1, 1000, 21_000, 50_000, 90_000, 100_000]) {
      const hold = pdfHold(tokens);
      expect(hold).toBeGreaterThan(last);
      last = hold;
    }
    // Claude Haiku 5.5 ($0.10 / $0.50 per million): 21,200 in + 5,000 out.
    expect(pdfHold(21_000)).toBeCloseTo(4620, 0);
  });
});

describe('file names and sizes (shared by the screen and the server)', () => {
  it('names', () => {
    expect(kbFileProblem('guide.pdf', 10)).toBeNull();
    expect(kbFileProblem('  Guide 📘.md  ', 10)).toBeNull();
    expect(kbFileProblem('.txt', 10)).toBe(KB_FILE_MESSAGES.nameBase);
    expect(kbFileProblem('a‮txt.pdf', 10)).toBe(KB_FILE_MESSAGES.nameChars);
    expect(kbFileProblem('a‍b.md', 10)).toBe(KB_FILE_MESSAGES.nameChars);
    expect(kbFileProblem('a\uD800.md', 10)).toBe(KB_FILE_MESSAGES.nameChars);
    expect(kbFileProblem('a.exe', 10)).toBe(KB_FILE_MESSAGES.kind);
    expect(kbFileProblem(`${'a'.repeat(200)}.md`, 10)).toBe(KB_FILE_MESSAGES.name);
  });

  it('sizes', () => {
    expect(kbFileProblem('a.md', 0)).toBe(KB_FILE_MESSAGES.empty);
    expect(kbFileProblem('a.md', 1.5)).toBe(KB_FILE_MESSAGES.size);
    expect(kbFileProblem('a.md', 1e20)).toBe(KB_FILE_MESSAGES.size);
    expect(kbFileProblem('a.md', -3)).toBe(KB_FILE_MESSAGES.size);
    expect(kbFileProblem('a.txt', 2 * 1024 * 1024)).toBe('A text file can be at most 1 MB.');
    expect(kbFileProblem('a.pdf', 9 * 1024 * 1024)).toBe('A PDF can be at most 8 MB.');
  });
});
