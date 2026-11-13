import {describe, expect, it} from 'vitest';

import {hasControlChars, oneLine, parseImport, questionOf, TEST_LAB_LIMITS} from '../src/lib/test-lab';

/** The shared question rules and the import parser (src/lib/test-lab.ts): the screen and the server run this code. */
describe('oneLine / questionOf', () => {
  it('strips zero-width characters and collapses spaces, never cuts', () => {
    expect(oneLine('  Do​ you‍ ship﻿ to⁠ Canada?\n')).toBe('Do you ship to Canada?');
    expect(oneLine(42)).toBeNull();
    const long = 'x'.repeat(TEST_LAB_LIMITS.question + 1);
    expect(oneLine(long)).toBe(long);
    expect(questionOf(long)).toBe('Type a question of 3 to 500 characters.');
    expect(questionOf('x'.repeat(500))).toEqual({question: 'x'.repeat(500), key: 'x'.repeat(500)});
  });

  it('refuses C0, DEL, C1 and bidi controls', () => {
    for (const ch of ['\u0000', '\u0007', '\u007f', '\u0080', '\u0085', '\u009f', '‪', '‮', '⁦', '⁩']) {
      expect(hasControlChars(`Is there ${ch} decaf?`), JSON.stringify(ch)).toBe(true);
      expect(questionOf(`Is there ${ch} decaf?`), JSON.stringify(ch)).toBe("The question has characters that can't be saved. Type it again.");
    }
    expect(hasControlChars('¿Cómo puedo rastrear mi pedido? 注文 🚚')).toBe(false);
    expect(questionOf('Is there​ decaf?')).toEqual({question: 'Is there decaf?', key: 'is there decaf'});
    expect(questionOf('???')).toBe('Type a question of 3 to 500 characters.');
  });
});

describe('parseImport', () => {
  it('keeps the 1-based source lines, skips blanks, keeps the first of a repeated question', () => {
    const parsed = parseImport('Do you ship to Canada\n\n  How do refunds work?\r\nhow do refunds work\rIs there​ decaf?\n');
    expect(parsed.errors).toEqual([]);
    expect(parsed.questions).toEqual([
      {line: 1, question: 'Do you ship to Canada', key: 'do you ship to canada'},
      {line: 3, question: 'How do refunds work?', key: 'how do refunds work'},
      {line: 5, question: 'Is there decaf?', key: 'is there decaf'},
    ]);
  });

  it('lists every bad line by its source line; an over-long line is an error, never cut', () => {
    const parsed = parseImport(['Fine line', '', 'x'.repeat(501), 'ab', 'Bad \u0000 line', 'Bidi ‮ line', '???', 'Another fine one'].join('\n'));
    expect(parsed.errors).toEqual([
      {line: 3, message: 'Line 3 is too long: up to 500 characters.'},
      {line: 4, message: 'Line 4 is too short: at least 3 characters.'},
      {line: 5, message: "Line 5 has characters that can't be saved."},
      {line: 6, message: "Line 6 has characters that can't be saved."},
      {line: 7, message: 'Line 7 needs a question with words in it.'},
    ]);
    expect(parsed.questions.map(q => q.line)).toEqual([1, 8]);
  });

  it('a tab inside a line is a space, not a control', () => {
    expect(parseImport('Is\tthere decaf?').questions).toEqual([{line: 1, question: 'Is there decaf?', key: 'is there decaf'}]);
  });

  it('nothing to import, and more than 100 lines', () => {
    expect(parseImport('\n \n​\n')).toEqual({questions: [], errors: []});
    const text = ['', ...Array.from({length: 101}, (_, i) => `Question ${i}`), 'Question 999'].join('\n');
    const parsed = parseImport(text);
    expect(parsed.questions).toHaveLength(100);
    expect(parsed.errors).toEqual([{line: 102, message: 'Paste up to 100 questions at a time.'}]);
  });
});
