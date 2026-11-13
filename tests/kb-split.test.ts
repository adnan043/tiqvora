import {describe, expect, it} from 'vitest';

import {KB_LIMITS} from '../src/lib/kb-types';
import {safeLinks, SPLIT_LIMITS, splitIntoDrafts, titleFromFileName, utf8Length} from '../src/server/kb/sources/split';

function expectWithinLimits(drafts: {title: string; body: string}[]) {
  for (const {title, body} of drafts) {
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(KB_LIMITS.articleTitle);
    expect(title).not.toMatch(/[\u0000-\u001f]/);
    expect(body.trim()).toBe(body);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(SPLIT_LIMITS.partChars);
    expect(utf8Length(body)).toBeLessThanOrEqual(SPLIT_LIMITS.partBytes);
  }
}

describe('splitIntoDrafts: headings', () => {
  it('makes one draft per # heading, the text before it titled from the file name', () => {
    const md = 'Intro words.\n\n# Getting started\nStep one.\n\n## Detail\nMore.\n\n# Billing #\nPay here.';
    const {drafts, dropped} = splitIntoDrafts(md, 'Help guide.md');
    expect(dropped).toBe(0);
    expect(drafts).toEqual([
      {title: 'Help guide', body: 'Intro words.'},
      {title: 'Getting started', body: 'Step one.\n\n## Detail\nMore.'},
      {title: 'Billing', body: 'Pay here.'},
    ]);
  });

  it('drops a heading with no text under it, and no preamble when there is none', () => {
    const {drafts} = splitIntoDrafts('# Empty\n\n# Full\nText', 'a.md');
    expect(drafts).toEqual([{title: 'Full', body: 'Text'}]);
  });

  it('falls back to ## headings when there are at least two and no #', () => {
    const {drafts} = splitIntoDrafts('Lead.\n## One\nA\n### Sub\nB\n## Two\nC', 'notes.txt');
    expect(drafts).toEqual([
      {title: 'notes', body: 'Lead.'},
      {title: 'One', body: 'A\n### Sub\nB'},
      {title: 'Two', body: 'C'},
    ]);
  });

  it('a single ## heading is not split: one draft from the file name', () => {
    const {drafts} = splitIntoDrafts('## Only\nText', 'faq.md');
    expect(drafts).toEqual([{title: 'faq', body: '## Only\nText'}]);
  });

  it('no headings → one draft titled from the file name', () => {
    expect(splitIntoDrafts('Line one\r\nLine two', 'policy.v2.docx').drafts).toEqual([
      {title: 'policy.v2', body: 'Line one\nLine two'},
    ]);
  });

  it('ignores headings inside code fences', () => {
    const md = '# Real\n```\n# not a heading\n```\n~~~~\n# still code\n~~~\nmore code\n~~~~\nAfter';
    const {drafts} = splitIntoDrafts(md, 'x.md');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe('Real');
    expect(drafts[0]!.body).toContain('# not a heading');
    expect(drafts[0]!.body).toContain('# still code');
  });

  it('a fence hiding every # heading means the ## fallback decides', () => {
    const {drafts} = splitIntoDrafts('```\n# code\n```\n## A\nx\n## B\ny', 'f.md');
    expect(drafts.map(d => d.title)).toEqual(['f', 'A', 'B']);
  });

  it('needs a space after the #s', () => {
    expect(splitIntoDrafts('#hashtag\ntext', 'n.md').drafts).toEqual([{title: 'n', body: '#hashtag\ntext'}]);
  });

  it('cleans titles: one line, no controls, at most 160, empty → Untitled section', () => {
    const long = 'T'.repeat(300);
    const {drafts} = splitIntoDrafts(`# ${long}\nx\n# a\u0007b\ty\nz`, '\u0001.md');
    expect(drafts[0]!.title).toBe('T'.repeat(160));
    expect(drafts[1]!.title).toBe('a b y');
    expect(splitIntoDrafts('body', '.md').drafts[0]!.title).toBe('.md');
    expect(splitIntoDrafts('body', '\u0002\u0003.txt').drafts[0]!.title).toBe('Untitled section');
  });

  it('empty input makes no drafts', () => {
    expect(splitIntoDrafts('  \n\n ', 'a.md')).toEqual({drafts: [], dropped: 0});
  });
});

describe('splitIntoDrafts: parts and caps', () => {
  it('cuts a long body at blank lines into "Title (part n)"', () => {
    const para = 'word '.repeat(199) + 'end'; // 998 chars
    const body = Array.from({length: 50}, () => para).join('\n\n'); // ~50k chars
    const {drafts} = splitIntoDrafts(`# Long\n${body}`, 'l.md');
    expect(drafts.length).toBe(3);
    expect(drafts.map(d => d.title)).toEqual(['Long', 'Long (part 2)', 'Long (part 3)']);
    expectWithinLimits(drafts);
    for (const d of drafts) for (const p of d.body.split('\n\n')) expect(p).toBe(para);
  });

  it('respects the byte limit for multi-byte text', () => {
    const para = '日本語'.repeat(300); // 900 chars, 2700 bytes
    const body = Array.from({length: 20}, () => para).join('\n\n'); // ~18k chars, ~54k bytes
    const {drafts} = splitIntoDrafts(body, 'jp.txt');
    expect(drafts.length).toBeGreaterThanOrEqual(3);
    expectWithinLimits(drafts);
  });

  it('cuts one huge line, and never splits a surrogate pair', () => {
    const {drafts} = splitIntoDrafts('😀'.repeat(30_000), 'e.txt');
    expectWithinLimits(drafts);
    expect(drafts.map(d => d.body).join('')).toBe('😀'.repeat(30_000));
  });

  it('keeps a code fence whole when it fits, and closes / reopens one that does not', () => {
    const filler = 'x'.repeat(15_000);
    const code = '```js\n' + 'let a = 1;\n\n'.repeat(500) + '```';
    const {drafts} = splitIntoDrafts(`${filler}\n\n${code}`, 'c.md');
    expect(drafts).toHaveLength(2);
    expect(drafts[1]!.body).toBe(code);

    const big = '```\n' + Array.from({length: 3000}, (_, i) => `line ${i} of code`).join('\n') + '\n```';
    const parts = splitIntoDrafts(big, 'b.md').drafts;
    expect(parts.length).toBeGreaterThan(1);
    expectWithinLimits(parts);
    for (const p of parts) {
      expect(p.body.startsWith('```')).toBe(true);
      expect(p.body.endsWith('```')).toBe(true);
    }
  });

  it('keeps the first 30 drafts and counts the rest', () => {
    const md = Array.from({length: 45}, (_, i) => `# S${i}\nbody ${i}`).join('\n');
    const {drafts, dropped} = splitIntoDrafts(md, 'm.md');
    expect(drafts).toHaveLength(30);
    expect(dropped).toBe(15);
    expect(drafts[29]!.title).toBe('S29');
  });

  it('counts parts toward the cap', () => {
    const body = Array.from({length: 40}, () => 'y'.repeat(19_000)).join('\n\n');
    const {drafts, dropped} = splitIntoDrafts(body, 'p.md');
    expect(drafts).toHaveLength(30);
    expect(dropped).toBe(10);
    expect(drafts[29]!.title).toBe('p (part 30)');
  });

  it('long title plus part suffix stays within 160', () => {
    const body = Array.from({length: 3}, () => 'z'.repeat(15_000)).join('\n\n');
    const {drafts} = splitIntoDrafts(`# ${'T'.repeat(200)}\n${body}`, 'x.md');
    expect(drafts[1]!.title.endsWith(' (part 2)')).toBe(true);
    expectWithinLimits(drafts);
  });
});

describe('links', () => {
  it('keeps https targets and removes every other one, keeping the text', () => {
    const md = [
      'See [docs](https://example.com/a(b)) and [bad](javascript:alert(1)).',
      'Also [http](http://example.com "t"), [mail](mailto:a@b.c), [rel](/x) and ![pic](data:image/png;base64,AAA).',
      '![ok](https://example.com/p.png) [x] (y) [a]b](c)',
    ].join('\n');
    const {drafts} = splitIntoDrafts(md, 'l.md');
    expect(drafts[0]!.body).toBe(
      [
        'See [docs](https://example.com/a(b)) and bad.',
        'Also http, mail, rel and pic.',
        '![ok](https://example.com/p.png) [x] (y) [a]b](c)', // not a link in the renderer either
      ].join('\n')
    );
  });

  it('finds a target behind many spaces', () => {
    expect(safeLinks(`[x](${' '.repeat(5000)}/relative)`)).toBe('x');
  });

  it('leaves code fences alone', () => {
    const {drafts} = splitIntoDrafts('```\n[x](javascript:1)\n```', 'c.md');
    expect(drafts[0]!.body).toBe('```\n[x](javascript:1)\n```');
  });

  it('is fast on hostile lines', () => {
    const hostile = ['['.repeat(200_000), ']('.repeat(200_000), '[a]('.repeat(100_000), `#${' '.repeat(100_000)}x`, '#'.repeat(200_000)];
    const started = Date.now();
    for (const line of hostile) {
      safeLinks(line);
      splitIntoDrafts(line, 'h.md');
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('titleFromFileName', () => {
  it('drops a short extension and any folder', () => {
    expect(titleFromFileName('Guide.docx')).toBe('Guide');
    expect(titleFromFileName('a/b\\Guide.final.md')).toBe('Guide.final');
    expect(titleFromFileName('README')).toBe('README');
    expect(titleFromFileName('.env')).toBe('.env');
  });
});
