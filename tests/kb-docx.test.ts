import {describe, expect, it} from 'vitest';

import {decodeEntities, DOCX_WORDS, DocxError, docxToMarkdown} from '../src/server/kb/sources/docx';
import {FileReadError} from '../src/server/kb/sources/text';

// ------------------------------------------------------------- ZIP writer --

interface ZipEntry {
  name: string;
  data: string | Uint8Array;
  /** 0 stored, 8 deflated (default). */
  method?: number;
  flags?: number;
  /** Lie in the central directory. */
  size?: number;
  crc?: number;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class Bytes {
  parts: number[] = [];
  u16(n: number) {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff);
    return this;
  }
  u32(n: number) {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    return this;
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
}

async function zip(
  entries: ZipEntry[],
  options: {totalEntries?: number; zip64Locator?: boolean; disk?: number} = {}
): Promise<Uint8Array> {
  const out = new Bytes();
  const central = new Bytes();
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
    const method = entry.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = utf8(entry.name);
    const crc = entry.crc ?? crc32(raw);
    const size = entry.size ?? raw.length;
    const offset = out.parts.length;
    out.u32(0x04034b50).u16(20).u16(entry.flags ?? 0).u16(method).u16(0).u16(0).u32(crc).u32(body.length).u32(size);
    out.u16(name.length).u16(0).bytes(name).bytes(body);
    central.u32(0x02014b50).u16(20).u16(20).u16(entry.flags ?? 0).u16(method).u16(0).u16(0).u32(crc);
    central.u32(body.length).u32(size).u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(name);
  }
  const cdOffset = out.parts.length;
  out.bytes(new Uint8Array(central.parts));
  if (options.zip64Locator) out.u32(0x07064b50).u32(0).u32(0).u32(0).u32(1);
  const total = options.totalEntries ?? entries.length;
  out.u32(0x06054b50).u16(options.disk ?? 0).u16(0).u16(total).u16(total).u32(central.parts.length).u32(cdOffset).u16(0);
  return new Uint8Array(out.parts);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`;
const p = (text: string, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const styled = (style: string, text: string) => p(text, `<w:pStyle w:val="${style}"/>`);
const item = (text: string, level = 0) => p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`);
const cell = (text: string) => `<w:tc><w:tcPr/>${p(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

async function read(body: string, extra: ZipEntry[] = []) {
  return docxToMarkdown(await zip([{name: 'word/document.xml', data: doc(body)}, ...extra]));
}

async function refusal(bytes: Uint8Array | Promise<Uint8Array>, limits = {}): Promise<string> {
  try {
    await docxToMarkdown(await bytes, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(DocxError);
    expect(error).toBeInstanceOf(FileReadError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

// ------------------------------------------------------------------ tests --

describe('docxToMarkdown: content', () => {
  it('reads paragraphs and headings by style id', async () => {
    const {markdown, warnings} = await read(
      styled('Title', 'Guide') + styled('Heading1', 'Start') + p('Hello world.') + styled('heading2', 'Sub') + styled('Heading3', 'Deep') + p('End')
    );
    expect(markdown).toBe('# Guide\n\n# Start\n\nHello world.\n\n## Sub\n\n### Deep\n\nEnd');
    expect(warnings).toEqual([]);
  });

  it('maps localized style ids through styles.xml names', async () => {
    const styles = `<w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>
      <w:style w:type="character" w:styleId="Fett"><w:name w:val="heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading9"><w:name w:val="heading 9"/></w:style>
    </w:styles>`;
    const {markdown} = await read(styled('berschrift1', 'Eins') + styled('Titel', 'Haupt') + styled('Fett', 'Not a heading') + styled('Heading9', 'Nine'), [
      {name: 'word/styles.xml', data: styles},
    ]);
    expect(markdown).toBe('# Eins\n\n# Haupt\n\nNot a heading\n\nNine');
  });

  it('reads list items as one tight list, with one nested level', async () => {
    const {markdown} = await read(p('Before') + item('One') + item('Two', 1) + item('Three', 3) + p('After') + p('Zero', '<w:numPr><w:numId w:val="0"/></w:numPr>'));
    expect(markdown).toBe('Before\n\n- One\n  - Two\n  - Three\n\nAfter\n\nZero');
  });

  it('reads an even table as a Markdown table, escaping pipes', async () => {
    const {markdown} = await read(`<w:tbl><w:tblPr/>${row('Plan', 'Price')}${row('Basic', 'a|b')}</w:tbl>`);
    expect(markdown).toBe('| Plan | Price |\n| --- | --- |\n| Basic | a\\|b |');
  });

  it('reads an uneven table as lines', async () => {
    const {markdown} = await read(`<w:tbl>${row('Wide')}${row('a', 'b')}</w:tbl>`);
    expect(markdown).toBe('Wide\n\na | b');
  });

  it('honours xml:space, tabs, breaks, entities and numeric references', async () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>  trimmed  </w:t><w:t xml:space="preserve"> kept </w:t><w:tab/><w:t>A&amp;B &lt;tag&gt; &quot;q&quot; &apos;s&apos; &#233;&#x1F600; &#0; &nbsp; &bogus</w:t></w:r>' +
      '<w:r><w:br/><w:t>line two</w:t><w:br w:type="page"/><w:t>same</w:t></w:r></w:p>';
    const {markdown} = await read(body);
    expect(markdown).toBe('trimmed kept A&B <tag> "q" \'s\' é😀 &nbsp; &bogus\nline two same');
  });

  it('leaves out pictures (with a warning), field codes and deleted text', async () => {
    const body =
      '<w:p><w:r><w:t>Look:</w:t></w:r><w:r><w:drawing><wp:inline><w:p><w:r><w:t>caption inside</w:t></w:r></w:p></wp:inline></w:drawing></w:r>' +
      '<w:r><w:instrText> HYPERLINK "x" </w:instrText></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r>' +
      '<w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>';
    const {markdown, warnings} = await read(body);
    expect(markdown).toBe('Look: here');
    expect(warnings).toEqual([DOCX_WORDS.pictures]);
  });

  it('escapes paragraph text that would read as a heading or a fence', async () => {
    const {markdown} = await read(p('# not a heading') + p('```js'));
    expect(markdown).toBe('\\# not a heading\n\n\\```js');
  });

  it('reads stored entries and skips comments, CDATA kept as text', async () => {
    const xml = doc('<!-- note --><w:p><w:r><w:t><![CDATA[a &lt; b]]></w:t></w:r></w:p>');
    const {markdown} = await docxToMarkdown(await zip([{name: 'word/document.xml', data: xml, method: 0}]));
    expect(markdown).toBe('a &lt; b');
  });

  it('cuts very long output with a warning', async () => {
    const body = Array.from({length: 50}, (_, i) => p(`Paragraph ${i} ${'x'.repeat(100)}`)).join('');
    const {markdown, warnings} = await docxToMarkdown(await zip([{name: 'word/document.xml', data: doc(body)}]), {maxTextChars: 1000});
    expect(markdown.length).toBeLessThanOrEqual(1000);
    expect(markdown.startsWith('Paragraph 0 ')).toBe(true);
    expect(warnings).toEqual([DOCX_WORDS.cut]);
  });

  it('reads a large document quickly and within the output cap', async () => {
    const body = Array.from({length: 30_000}, (_, i) => (i % 50 === 0 ? styled('Heading2', `Part ${i}`) : p(`Sentence number ${i} with some words.`))).join('');
    const started = Date.now();
    const {markdown, warnings} = await read(body);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(markdown.length).toBeLessThanOrEqual(200_000);
    expect(warnings).toEqual([DOCX_WORDS.cut]);
  });

  it('an empty document reads as empty text', async () => {
    expect(await read('')).toEqual({markdown: '', warnings: []});
  });
});

describe('docxToMarkdown: refusals', () => {
  const documentEntry = {name: 'word/document.xml', data: doc(p('x'))};

  it('refuses something that is not a ZIP, and a truncated end record', async () => {
    expect(await refusal(utf8('just text, no zip at all'))).toBe(DOCX_WORDS.notDocx);
    const whole = await zip([documentEntry]);
    expect(await refusal(whole.slice(0, whole.length - 5))).toBe(DOCX_WORDS.notDocx);
    expect(await refusal(new Uint8Array(3))).toBe(DOCX_WORDS.notDocx);
  });

  it('refuses an old .doc or locked file (OLE header)', async () => {
    const ole = new Uint8Array(600);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await refusal(ole)).toBe(DOCX_WORDS.oldOrLocked);
  });

  it('refuses a ZIP without word/document.xml', async () => {
    expect(await refusal(zip([{name: 'word/other.xml', data: 'x'}]))).toBe(DOCX_WORDS.notDocx);
  });

  it('refuses an encrypted entry', async () => {
    expect(await refusal(zip([{...documentEntry, flags: 1}]))).toBe(DOCX_WORDS.encrypted);
  });

  it('refuses ZIP64 markers and multi-disk archives', async () => {
    expect(await refusal(zip([documentEntry], {zip64Locator: true}))).toBe(DOCX_WORDS.unsafe);
    expect(await refusal(zip([documentEntry], {totalEntries: 0xffff}))).toBe(DOCX_WORDS.unsafe);
    expect(await refusal(zip([{...documentEntry, size: 0xffffffff}]))).toBe(DOCX_WORDS.unsafe);
    expect(await refusal(zip([documentEntry], {disk: 1}))).toBe(DOCX_WORDS.unsafe);
  });

  it('refuses more than 2,000 entries', async () => {
    const many = Array.from({length: 2001}, (_, i) => ({name: `f${i}`, data: '', method: 0}));
    expect(await refusal(zip([documentEntry, ...many]))).toBe(DOCX_WORDS.unsafe);
  });

  it('refuses a zip bomb (ratio) and an oversized part', async () => {
    const bomb = doc(p('a'.repeat(200_000)));
    expect(await refusal(zip([{name: 'word/document.xml', data: bomb}]))).toBe(DOCX_WORDS.unsafe);
    expect(await refusal(zip([documentEntry]), {docxMaxUncompressed: 100})).toBe(DOCX_WORDS.tooBig);
  });

  it('refuses a declared size that lies (inflate overrun or short)', async () => {
    const real = doc(p('hello there, this is some text'));
    expect(await refusal(zip([{name: 'word/document.xml', data: real, size: 20}]))).toBe(DOCX_WORDS.damaged);
    expect(await refusal(zip([{name: 'word/document.xml', data: real, size: utf8(real).length + 10}]))).toBe(DOCX_WORDS.damaged);
  });

  it('refuses a CRC mismatch and corrupt deflate data', async () => {
    expect(await refusal(zip([{...documentEntry, crc: 1234}]))).toBe(DOCX_WORDS.damaged);
    const bytes = await zip([documentEntry]);
    const start = 30 + 'word/document.xml'.length;
    bytes.fill(0xff, start, start + 8);
    expect(await refusal(bytes)).toBe(DOCX_WORDS.damaged);
  });

  it('refuses DOCTYPE and ENTITY declarations', async () => {
    const dtd = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "aaaa">]><w:document ${W}><w:body>${p('&a;')}</w:body></w:document>`;
    expect(await refusal(zip([{name: 'word/document.xml', data: dtd}]))).toBe(DOCX_WORDS.unsafe);
    const styles = `<!ENTITY x "y"><w:styles ${W}/>`;
    expect(await refusal(zip([documentEntry, {name: 'word/styles.xml', data: styles}]))).toBe(DOCX_WORDS.unsafe);
  });

  it('refuses a duplicate document part', async () => {
    expect(await refusal(zip([documentEntry, documentEntry]))).toBe(DOCX_WORDS.unsafe);
  });

  it('refuses an unknown compression method', async () => {
    const bytes = await zip([{...documentEntry, method: 0}]);
    // Patch the central directory's method to 12 (bzip2).
    const cd = bytes.length - 22 - (46 + 'word/document.xml'.length);
    bytes[cd + 10] = 12;
    expect(await refusal(bytes)).toBe(DOCX_WORDS.notDocx);
  });

  it('refuses an unclosed tag', async () => {
    expect(await refusal(zip([{name: 'word/document.xml', data: `<w:document ${W}><w:body><w:p`}]))).toBe(DOCX_WORDS.damaged);
  });
});

describe('decodeEntities', () => {
  it('decodes only the five entities and valid numeric references', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'');
    expect(decodeEntities('&#65;&#x42;&#xD800;&#1114112;&toString;&constructor;')).toBe("AB&toString;&constructor;");
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('a & b; c')).toBe('a & b; c');
  });

  it('is linear on hostile input', () => {
    const started = Date.now();
    decodeEntities('&'.repeat(300_000));
    decodeEntities('&#'.repeat(1_000_000) + ';');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
