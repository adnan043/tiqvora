import {describe, expect, it} from 'vitest';

import {KB_LIMITS, SLUG_RE, slugify} from '../src/lib/kb-types';
import {chunkArticle, chunkSnippet} from '../src/server/kb/chunks';

/** What search and (later) the assistant read: an article cut into sections that fit the columns. */
const HEADING_MAX = 200;
const TEXT_MAX = 2000;
const CHUNKS_MAX = 60;

function expectWithinLimits(chunks: {position: number; heading: string; text: string}[]) {
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.length).toBeLessThanOrEqual(CHUNKS_MAX);
  for (const chunk of chunks) {
    expect(chunk.heading.length).toBeLessThanOrEqual(HEADING_MAX);
    expect(chunk.text.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(chunk.text.trim().length).toBeGreaterThan(0);
  }
  const positions = chunks.map(c => c.position);
  expect(new Set(positions).size).toBe(positions.length);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

/** A paragraph of about `n` characters, tagged so it can be found again. */
const para = (tag: string, n = 500) => `${tag} ${'beans roast slowly '.repeat(Math.ceil(n / 19))}`.slice(0, n).trim();

describe('chunkArticle', () => {
  it('splits on ## and ### headings and names each chunk "Title — Section"', () => {
    const body = 'An intro about brewing.\n\n## Grind size\n\nUse a **medium** grind.\n\n### For espresso\n\nGo finer.\n\n## Water\n\nUse water just off the boil.';
    const chunks = chunkArticle('Brewing basics', body);
    expectWithinLimits(chunks);

    const grind = chunks.find(c => c.heading === 'Brewing basics — Grind size');
    expect(grind?.text).toContain('Use a medium grind.');
    expect(chunks.find(c => c.heading === 'Brewing basics — For espresso')?.text).toContain('Go finer.');
    expect(chunks.find(c => c.heading === 'Brewing basics — Water')?.text).toContain('just off the boil');
    // The text before the first heading is not lost.
    expect(chunks.some(c => c.text.includes('An intro about brewing.'))).toBe(true);
    // Plain text: no Markdown left.
    for (const c of chunks) expect(c.text).not.toMatch(/\*\*|^#+\s/m);
  });

  it('an article without headings is one chunk under its title', () => {
    const chunks = chunkArticle('Opening hours', 'We are open every day from 8 to 6.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading.startsWith('Opening hours')).toBe(true);
    expect(chunks[0]!.text).toContain('We are open every day from 8 to 6.');
  });

  it('splits a long section on paragraph boundaries, every chunk ≤ 2000 characters, nothing lost', () => {
    const paragraphs = Array.from({length: 12}, (_, i) => para(`P${i}x`, 600));
    const chunks = chunkArticle('Long guide', `## Everything\n\n${paragraphs.join('\n\n')}`);
    expectWithinLimits(chunks);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const all = chunks.map(c => c.text).join('\n');
    for (let i = 0; i < 12; i++) expect(all).toContain(`P${i}x`);
    // A paragraph is never cut in two when it fits.
    for (let i = 0; i < 12; i++) expect(chunks.filter(c => c.text.includes(`P${i}x`))).toHaveLength(1);
    for (const c of chunks) expect(c.heading).toBe('Long guide — Everything');
  });

  it('cuts one huge paragraph to fit', () => {
    const chunks = chunkArticle('Wall of text', `## Section\n\n${'word '.repeat(2000)}`);
    expectWithinLimits(chunks);
  });

  it('keeps headings within 200 characters', () => {
    const chunks = chunkArticle('T'.repeat(160), `## ${'H'.repeat(150)}\n\nBody text.`);
    expectWithinLimits(chunks);
    expect(chunks[0]!.heading.startsWith('T'.repeat(160))).toBe(true);
  });

  it('never makes more than 60 chunks', () => {
    const body = Array.from({length: 150}, (_, i) => `## Section ${i}\n\n${para(`S${i}`, 300)}`).join('\n\n');
    expectWithinLimits(chunkArticle('Huge article', body));
    const long = Array.from({length: 40}, (_, i) => `## Part ${i}\n\n${Array.from({length: 6}, (_, j) => para(`Q${i}-${j}`, 900)).join('\n\n')}`).join('\n\n');
    expectWithinLimits(chunkArticle('Even bigger', long));
  });

  it('skips empty sections', () => {
    const chunks = chunkArticle('Gaps', '## Empty\n\n## Full\n\nSomething here.');
    expectWithinLimits(chunks);
    expect(chunks.some(c => c.heading === 'Gaps — Full')).toBe(true);
  });
});

/** One chunk, whether it comes back alone or as a one-row list. */
const snippetRows = (q: string, a: string) => {
  const out: unknown = chunkSnippet(q, a);
  return (Array.isArray(out) ? out : [out]) as {heading: string; text: string}[];
};

describe('chunkSnippet', () => {
  it('is one chunk: the question as heading, the answer as text', () => {
    const rows = snippetRows('Do you ship abroad?', 'Yes, to the EU and the UK.');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({heading: 'Do you ship abroad?', text: 'Yes, to the EU and the UK.'});
  });

  it('fits the columns', () => {
    const [chunk] = snippetRows('Q'.repeat(300), 'A'.repeat(2000));
    expect(chunk!.heading.length).toBeLessThanOrEqual(HEADING_MAX);
    expect(chunk!.text.length).toBeLessThanOrEqual(TEXT_MAX);
  });
});

describe('slugify', () => {
  it('lower-cases and joins words with single dashes', () => {
    expect(slugify('Track your order')).toBe('track-your-order');
    expect(slugify('Orders & shipping')).toBe('orders-shipping');
    expect(slugify('  --Hello,   World!--  ')).toBe('hello-world');
  });

  it('drops accents', () => {
    expect(slugify('Café crème brûlée')).toBe('cafe-creme-brulee');
  });

  it('is empty when nothing is left', () => {
    expect(slugify('!!! ???')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('keeps to the length limit without a trailing dash', () => {
    const long = slugify('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(KB_LIMITS.articleSlug);
    expect(long.endsWith('-')).toBe(false);
    expect(slugify('abc def ghi', 4)).toBe('abc');
    expect(slugify('Some category name that is long', KB_LIMITS.categorySlug).length).toBeLessThanOrEqual(KB_LIMITS.categorySlug);
  });

  it('always gives a valid slug or nothing', () => {
    for (const text of ['Grind size: fine vs. coarse', 'Ünïcödé — test', '100% Arabica', 'a--b', 'x'.repeat(400)]) {
      const slug = slugify(text);
      expect(slug === '' || SLUG_RE.test(slug), text).toBe(true);
    }
  });
});
