import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import type {KbSearchHit} from '../../lib/kb-types';

/**
 * Full-text search over `kb_chunks` (published articles split by heading, plus snippets).
 *
 * The vector is STORED in `kb_chunks.search_vec` (migration 20261112121731): a trigger sets it
 * to `setweight(to_tsvector('simple', heading), 'A') || setweight(to_tsvector('simple', text), 'B')`
 * on every insert and on updates of heading/text, and the GIN index `kb_chunks_search_vec_idx`
 * is on it. Matching and ranking read the column (no to_tsvector per row); the chunk table is
 * aliased `c` in every query that uses this.
 */
export const KB_SEARCH_VECTOR = Prisma.sql`c."search_vec"`;

const MAX_PREFIX_WORDS = 8;

/** Words this long or longer match as prefixes; shorter ones ("uk", "eu", "tea") only exactly. */
export const PREFIX_MIN_LENGTH = 4;

/** A tsquery term for one word (letters/digits only): `word:*` from PREFIX_MIN_LENGTH up, else `word`. */
export function tsTerm(word: string): string {
  return word.length >= PREFIX_MIN_LENGTH ? `${word}:*` : word;
}

/**
 * The 'simple' configuration doesn't stem ("grinders" never matches "grinder"), so a search also
 * matches word prefixes: `prefixQuery('Burr grinders in the UK?')` → `'burr:* & grinders:* & in & the & uk'`,
 * or `null` when no word of 2+ letters or digits is left. Words under PREFIX_MIN_LENGTH match
 * exactly ("uk:*" would also match "ukulele"). Only letters and digits survive, so the result is
 * always valid `to_tsquery` syntax; it is still sent as a bound parameter, never SQL text.
 */
export function prefixQuery(q: string): string | null {
  const words = [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2)
    ),
  ].slice(0, MAX_PREFIX_WORDS);
  return words.length ? words.map(tsTerm).join(' & ') : null;
}

/** The tsquery for a visitor's search: their words as typed (websearch syntax) OR as prefixes. */
export function kbTsQuery(q: string): Prisma.Sql {
  const prefix = prefixQuery(q);
  return prefix
    ? Prisma.sql`(websearch_to_tsquery('simple', ${q}) || to_tsquery('simple', ${prefix}))`
    : Prisma.sql`websearch_to_tsquery('simple', ${q})`;
}

/** Match markers ts_headline puts around hits: private-use characters no article contains; stripped. */
const MARK_START = '\uE000';
const MARK_STOP = '\uE001';
/** ts_headline options: one short fragment around the best match, marked with MARK_START/STOP. */
const HEADLINE = `StartSel=${MARK_START}, StopSel=${MARK_STOP}, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1`;
/** Characters of the chunk's start and end sent back to tell whether the fragment reaches them. */
const EDGE = 80;
/** A snippet's length, "…" included. */
const SNIPPET_MAX = 200;
/**
 * Matching chunks kept before grouping per article: the best-ranked ones (bounded work on a big
 * knowledge base). The GIN index still finds the matches (bitmap scan); ranking them is a top-N sort.
 */
const CANDIDATES = 1000;

type Row = {
  title: string;
  slug: string;
  category_name: string;
  category_slug: string;
  snippet: string | null;
  text_start: string | null;
  text_end: string | null;
};

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
/** A list number at the start, or after a sentence ends ("hopper. 2. Turn" → "hopper. Turn"). */
const LIST_NUMBER = /(^|[.!?:;]\s)\d{1,3}[.)]\s+/g;
const EDGE_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;

/**
 * A search hit's snippet, plain text: the ts_headline fragment without its markers, whitespace
 * collapsed, list numbers dropped, stray quotes at its ends removed, "…" where it starts or ends
 * inside the chunk, at most SNIPPET_MAX characters. `textStart` / `textEnd` are the chunk's first
 * and last EDGE characters. Never HTML: the page shows it with textContent.
 */
export function cleanSnippet(headline: string, textStart: string, textEnd: string): string {
  const fragment = collapse(headline.replaceAll(MARK_START, '').replaceAll(MARK_STOP, ''));
  if (!fragment) return '';
  const head = collapse(textStart);
  const tail = collapse(textEnd);
  const probe = Math.min(24, fragment.length);
  const fromStart = head.startsWith(fragment.slice(0, probe));
  let toEnd = tail.endsWith(fragment.slice(-probe));
  let text = collapse(fragment.replace(LIST_NUMBER, '$1').replace(EDGE_QUOTES, ''));
  const room = SNIPPET_MAX - (fromStart ? 0 : 1) - 1;
  if (text.length > room + (toEnd ? 1 : 0)) {
    const at = text.lastIndexOf(' ', room);
    text = text.slice(0, at > room / 2 ? at : room).replace(/[\s,;:.-]+$/, '');
    toEnd = false;
  }
  return `${fromStart ? '' : '…'}${text}${toEnd ? '' : '…'}`;
}

/**
 * The public help-center search: PUBLISHED articles only (snippets are never shown publicly),
 * one hit per article (its best chunk), best first. ONE query. `query` is what the visitor
 * typed (trimmed, 2–120 characters, checked by the route); `limit` 1–20.
 */
export async function searchKb(db: PrismaClient, query: string, limit: number): Promise<KbSearchHit[]> {
  const q = query.trim().slice(0, 120);
  if (q.length < 2) return [];
  const take = Math.min(20, Math.max(1, Math.floor(limit)));
  const tsq = kbTsQuery(q);
  const rows = await db.$queryRaw<Row[]>`
    WITH matched AS (
      SELECT c."article_id", c."text", ts_rank_cd(${KB_SEARCH_VECTOR}, ${tsq}) AS rank
      FROM "kb_chunks" c
      WHERE c."article_id" IS NOT NULL AND ${KB_SEARCH_VECTOR} @@ ${tsq}
      ORDER BY rank DESC, c."id" DESC
      LIMIT ${CANDIDATES}
    ),
    best AS (
      SELECT DISTINCT ON (m."article_id") m."article_id", m."text", m.rank
      FROM matched m
      ORDER BY m."article_id", m.rank DESC
    ),
    top AS (
      SELECT a."id", a."title", a."slug", k."name" AS category_name, k."slug" AS category_slug, b."text", b.rank
      FROM best b
      JOIN "kb_articles" a ON a."id" = b."article_id" AND a."status" = 'published'
      JOIN "kb_categories" k ON k."id" = a."category_id"
      ORDER BY b.rank DESC, a."id" DESC
      LIMIT ${take}
    )
    SELECT t."title", t."slug", t.category_name, t.category_slug,
      ts_headline('simple', t."text", ${tsq}, ${HEADLINE}) AS snippet,
      left(t."text", ${EDGE}) AS text_start, right(t."text", ${EDGE}) AS text_end
    FROM top t
    ORDER BY t.rank DESC, t."id" DESC`;
  return rows.map(row => ({
    title: row.title,
    slug: row.slug,
    category: {name: row.category_name, slug: row.category_slug},
    snippet: cleanSnippet(row.snippet ?? '', row.text_start ?? '', row.text_end ?? ''),
  }));
}
