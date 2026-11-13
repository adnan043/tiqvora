import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {KB_SEARCH_VECTOR, tsTerm} from '../kb/search';
import type {Source} from './prompt';

/**
 * What the assistant may answer from: the chunks (`kb_chunks`) of PUBLISHED articles and of
 * snippets that best match the customer's question. ONE plain `SELECT` (a read: the database
 * socket may overlap or re-send it), using the GIN index on the stored `KB_SEARCH_VECTOR`
 * column; a second one only for a follow-up whose own words found nothing (`retrieve`).
 *
 * Why not `kbTsQuery()` (the help-center search's query): it ANDs every word, and the 'simple'
 * configuration has no stop words, so "how do I change my grind" needs `how & do & i & …` in one
 * chunk and matches nothing (checked on the seeded data). A question is matched instead by its
 * meaningful words (stop words dropped, up to MAX_TERMS), OR-ed together: words of 4+ characters
 * as prefixes, shorter ones exactly (`tsTerm`: "uk" must not match "ukulele").
 *
 * Score = `ts_rank_cd` × coverage (the share of the question's words the chunk contains), × 0.8
 * for an article not reviewed in 180 days. Only chunks scoring ≥ MIN_RANK are sources.
 *
 * MIN_RANK = 0.3, chosen on the seeded Northwind data (2026-11-12, 26 published articles,
 * 10 snippets, 123 chunks), with this exact query; re-checked the same day after short words
 * (2–3 characters) became exact matches: unchanged but for "my beans go stale fast", 0.9 (4) →
 * 0.4 (2), as "go" no longer matches "good". Best chunk score per question (chunks ≥ 0.3):
 *   should match:     "how do I change my grind" 5.2 (29), "refund my order" 3.4 (28), "how do I
 *                     cancel my subscription" 4.6 (28), "do you ship to Canada?" 2.8 (15),
 *                     "my espresso tastes sour" 2.6 (10), "what are your support hours?" 2.8 (1),
 *                     "is there decaf?" 1.8 (2), "my beans go stale fast" 0.4 (2), "I was charged
 *                     twice" 0.7 (8), "where is my package?" 0.4 (1: one body hit, full coverage,
 *                     the lowest real ones)
 *   should not match: "what is the meaning of life", "what's the weather tomorrow", "capital of
 *                     france", "tell me a joke": no chunk at all; "what is the bitcoin price" 0.2,
 *                     "who won the football game last night" 0.2, "write a poem about love" 0.13
 * One body hit for half the words scores 0.2; one body hit for all of them 0.4: 0.3 sits between.
 * Off-topic questions sharing a real word ("can you write python code" → the gift-code article,
 * 1.2) still pass; the model then says it isn't sure and the customer is handed to a person.
 * A question in another language than the articles ("¿Puedo pedir un reembolso?") finds nothing.
 */
export const MIN_RANK = 0.3;
/** Sources sent to the model. */
export const MAX_SOURCES = 6;
/** Words of the question used to match (like the search's prefix words). */
const MAX_TERMS = 8;
/** Best raw-ranked matches scored for coverage: bounded work on a big knowledge base. */
const CANDIDATES = 50;
/** An article not reviewed for this long ranks lower (× STALE_FACTOR). */
const STALE_FACTOR = 0.8;

/**
 * Words that say nothing about the topic, in the languages a customer most often writes in
 * (English, Spanish, French, German, Portuguese). Lower-case, as the question is lower-cased.
 */
const STOP_WORDS = new Set(
  (
    // English
    'about above after again all also am an and any are as at be because been before being below between both but by ' +
    'can cannot could did do does doing done down during each few for from further get got had has have having he her ' +
    'here hers him his how if in into is it its itself just let like me might more most must my no nor not now of off on ' +
    'once only or other our ours out over own please same she should so some such than thank thanks that the their them ' +
    'then there these they this those through to too under until up very was we were what when where which while who ' +
    'whom why will with would you your yours hi hello hey ok okay want need know tell help question ' +
    // Spanish
    'el la los las un una unos unas del que en es por para con como mi mis su sus lo le se al te yo tu qué cómo cuál ' +
    'cuando dónde puedo quiero hola gracias favor está son hay ' +
    // French
    'les une des du et ou qui est avec comment mon ma mes je vous il elle ce cette bonjour merci pas au aux nous ' +
    // German
    'der die das ein eine einen und oder ist ich mein meine wie wo wann für mit von zu im den dem bitte kann hallo danke ' +
    'nicht ' +
    // Portuguese
    'os as um uma do da dos das em é com meu minha eu você olá obrigado não'
  ).split(/\s+/)
);

/** The question's meaningful words: letters and digits only (valid `to_tsquery` input), 2+ long. */
export function questionTerms(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2 && !STOP_WORDS.has(word))
    ),
  ].slice(0, MAX_TERMS);
}

type Row = {
  article_id: number | null;
  heading: string;
  text: string;
  title: string;
  slug: string | null;
};

export interface Retrieved {
  /** Best first, numbered from 1. */
  sources: Source[];
  /** The best matching ARTICLE (not snippet), for the question log. */
  topArticleId: number | null;
}

/**
 * `previous`: the customer's previous question in this chat, if any. The question's OWN words are
 * searched first; only when they find no source (a follow-up such as "how long does that take?",
 * or no meaningful word at all) and there is a previous question, a second query searches the
 * own words plus the previous question's. One extra round trip, on that path only. Coverage is
 * always over the terms the query actually used.
 */
export async function retrieve(db: PrismaClient, question: string, previous = ''): Promise<Retrieved> {
  const own = questionTerms(question);
  let rows = own.length ? await search(db, own) : [];
  if (!rows.length && previous) {
    const both = [...new Set([...own, ...questionTerms(previous)])].slice(0, MAX_TERMS);
    if (both.length > own.length) rows = await search(db, both);
  }

  const sources: Source[] = rows.map((row, i) => ({
    n: i + 1,
    title: row.title ?? '',
    heading: row.heading ?? '',
    text: row.text ?? '',
    // A snippet is never cited as a link.
    url: row.article_id !== null && row.slug ? `/help/articles/${row.slug}/` : '',
    articleId: row.article_id !== null ? Number(row.article_id) : null,
  }));
  const top = rows.find(row => row.article_id !== null);
  return {sources, topArticleId: top ? Number(top.article_id) : null};
}

/** The chunks scoring ≥ MIN_RANK for these terms (non-empty), best first, at most MAX_SOURCES. */
async function search(db: PrismaClient, terms: string[]): Promise<Row[]> {
  // Every term is letters/digits only, so `tsTerm` is valid syntax; still bound as parameters.
  const tsq = Prisma.sql`to_tsquery('simple', ${terms.map(tsTerm).join(' | ')})`;
  const covered = Prisma.join(
    terms.map(term => Prisma.sql`(m."vec" @@ to_tsquery('simple', ${tsTerm(term)}))::int`),
    ' + '
  );

  return db.$queryRaw<Row[]>`
    SELECT s."article_id", s."heading", s."text", s."title", s."slug"
    FROM (
      SELECT m."id", m."article_id", m."heading", m."text", m."title", m."slug",
        m."rank" * ((${covered})::float8 / ${terms.length}::float8) * (CASE WHEN m."stale" THEN ${STALE_FACTOR}::float8 ELSE 1.0::float8 END) AS "score"
      FROM (
        SELECT c."id", c."article_id", c."heading", c."text",
          COALESCE(a."title", sn."question") AS "title", a."slug",
          ts_rank_cd(${KB_SEARCH_VECTOR}, ${tsq}) AS "rank",
          ${KB_SEARCH_VECTOR} AS "vec",
          (a."last_reviewed_at" < now() - interval '180 days') AS "stale"
        FROM "kb_chunks" c
        LEFT JOIN "kb_articles" a ON a."id" = c."article_id"
        LEFT JOIN "kb_snippets" sn ON sn."id" = c."snippet_id"
        WHERE ${KB_SEARCH_VECTOR} @@ ${tsq}
          AND ((c."article_id" IS NOT NULL AND a."status" = 'published') OR c."snippet_id" IS NOT NULL)
        ORDER BY "rank" DESC, c."id" ASC
        LIMIT ${CANDIDATES}
      ) m
    ) s
    WHERE s."score" >= ${MIN_RANK}::float8
    ORDER BY s."score" DESC, s."id" ASC
    LIMIT ${MAX_SOURCES}`;
}
