/**
 * The design system holds (docs/design-system.md): every spacing, font size,
 * radius and weight in the stylesheets is a token, colours are hex only inside
 * the token blocks, and media queries use the three breakpoints. A raw value
 * here is how a screen starts to look "slightly different" from the rest.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const STYLESHEETS = ['src/styles/global.css', 'src/styles/app.css', 'src/styles/home.css', 'src/styles/help.css', 'src/styles/inbox.css', 'src/styles/support.css'];
const ASTRO_STYLES = [
  'src/pages/checkout/index.astro',
  'src/components/payments/BuyButton.astro',
  'src/components/payments/CheckoutAskForm.astro',
  'src/components/payments/PriceList.astro',
  'src/components/payments/TestModeBadge.astro',
];

function read(file: string) {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.astro')) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}

/** Lines of a stylesheet with the colour token blocks (`:root…{ --x: … }`) blanked out. */
function withoutTokenBlocks(css: string) {
  const lines = css.split('\n');
  let depth = 0;
  let tokenDepth = -1;
  return lines.map(line => {
    const starts = /^\s*:root[^{]*\{/.test(line);
    if (starts && tokenDepth < 0) tokenDepth = depth;
    const inTokens = tokenDepth >= 0;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (inTokens && depth <= tokenDepth) tokenDepth = -1;
    return inTokens ? '' : line;
  });
}

/** Every declaration `prop: value` with its file and line, outside the token blocks. */
function declarations() {
  const out: {where: string; prop: string; value: string}[] = [];
  for (const file of [...STYLESHEETS, ...ASTRO_STYLES]) {
    withoutTokenBlocks(read(file)).forEach((line, i) => {
      const m = line.match(/^\s*([a-z-]+)\s*:\s*([^;]+);/);
      if (m) out.push({where: `${file}:${i + 1}`, prop: m[1], value: m[2].replace(/\/\*.*?\*\//g, '').trim()});
    });
  }
  return out;
}

const RAW_LENGTH = /(?<![\w-])-?\d*\.?\d+(px|rem)\b/;

describe('design tokens', () => {
  const all = declarations();

  it('spacing uses --space-* tokens', () => {
    const bad = all.filter(d => /^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(d.prop) && RAW_LENGTH.test(d.value));
    expect(bad.map(d => `${d.where} ${d.prop}: ${d.value}`)).toEqual([]);
  });

  it('font sizes use --text-* tokens (inline code may scale with its paragraph in em)', () => {
    const bad = all.filter(d => d.prop === 'font-size' && !/^var\(--text-|^calc\(var\(--brand-size\)|^\d*\.?\d+em$|^inherit$/.test(d.value));
    expect(bad.map(d => `${d.where} font-size: ${d.value}`)).toEqual([]);
  });

  it('radii use --radius-* tokens', () => {
    const bad = all.filter(d => /radius$/.test(d.prop) && /\d(px|rem|em)\b/.test(d.value.replace(/calc\(var\(--radius-lg\) \+ var\(--space-\d+\)\)/, '')));
    expect(bad.map(d => `${d.where} ${d.prop}: ${d.value}`)).toEqual([]);
  });

  it('weights use --weight-* tokens', () => {
    const bad = all.filter(d => d.prop === 'font-weight' && /^\d+$/.test(d.value));
    expect(bad.map(d => `${d.where} font-weight: ${d.value}`)).toEqual([]);
  });

  it('colours are tokens outside :root (white knob and QR backgrounds excepted, ui.md)', () => {
    const bad: string[] = [];
    for (const file of [...STYLESHEETS, ...ASTRO_STYLES]) {
      withoutTokenBlocks(read(file)).forEach((line, i) => {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/#ffffff;\s*\/\* (the knob|a QR code)/.test(line)) bad.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('media queries use the 640 / 1024 / 1280 breakpoints', () => {
    const bad: string[] = [];
    for (const file of [...STYLESHEETS, ...ASTRO_STYLES]) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)) {
            if (!['640', '641', '1024', '1025', '1280', '1281'].includes(m[1])) bad.push(`${file}:${i + 1} ${m[0]}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it('every colour token has a dark value, in both dark blocks', () => {
    const css = readFileSync('src/styles/global.css', 'utf8');
    const block = (start: RegExp) => {
      const from = css.search(start);
      const body = css.slice(from, css.indexOf('\n}', from));
      return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:\s*#/gm)].map(m => m[1]));
    };
    const light = block(/^:root \{/m);
    const forced = block(/^:root\[data-theme='dark'\] \{/m);
    const device = block(/:root:not\(\[data-theme='light'\]\) \{/m);
    // Same-in-both-themes colours (the scrim's text) need no dark value.
    const missing = [...light].filter(t => t !== '--on-scrim' && (!forced.has(t) || !device.has(t)));
    expect(missing).toEqual([]);
  });
});
