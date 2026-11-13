import type {PrismaClient} from '../../generated/prisma/client';
import {KB_LIMITS} from '../../lib/kb-types';
import {excerptOf, insertArticle, newArticleSlug, randomSlug} from '../kb/articles';

/**
 * Accepting a Knowledge health issue (POST /site-api/helpdesk/health/:id/accept,
 * src/server/routes/knowledge-health.ts): the reviewer's edited draft becomes a DRAFT article.
 *
 * Before the transaction: a free slug from the title (one read; only when the reviewer gave none).
 * Then ONE interactive transaction, at most three statements, so the claim and the article commit
 * together or not at all:
 *   1. Claim: a conditional UPDATE (`state = 'open'`) whose row lock serialises two reviewers.
 *      The second one waits, finds the row no longer open and gets `NotOpen` (409 `changed`). Its
 *      RETURNING also reads the target article's status, category and "edited since?" (subselects
 *      on the primary key), so there is no separate read.
 *   2. The write. The target is a DRAFT nobody has edited since this issue was raised → that draft
 *      is updated in place (the plan's §7.1), conditional on it STILL being a draft with the same
 *      `updated_at` (an editor saving meanwhile makes it match no row). Anything else (a draft
 *      someone edited after the issue was raised, published, archived, deleted, or no article) →
 *      a NEW draft article, so an editor's work in progress is never overwritten. A published
 *      article is NEVER written here, and nothing here can publish: `status` is hard-coded
 *      `'draft'` and the PATCH path is never called. A draft has no chunks and counts in no
 *      category, so nothing public changes (no `kb:` cache clear).
 *   3. `accepted_article_id` = the article written.
 * The route audits the result (`mode`, and the draft it replaced when `updated`).
 * A slug taken meanwhile (P2002) or a missing category (P2003) rolls the whole thing back (the
 * claim too): an auto-made slug is tried once more with a random tail. No outside call ever runs
 * inside the transaction (it holds the issue's row lock).
 */

export interface AcceptFields {
  title: string;
  body: string;
  excerpt?: string;
  slug?: string;
  categoryId?: number;
}

export interface Accepted {
  type: string;
  mode: 'created' | 'updated';
  article: {id: number; title: string};
  /** The issue's own article (the draft replaced when `mode` is 'updated'), or null. */
  sourceArticleId: number | null;
}

/** The issue was not open any more (accepted or dismissed meanwhile), or doesn't exist. */
export class NotOpen extends Error {}
/** A new article is needed and neither the reviewer nor the old article gave a category. */
export class NeedsCategory extends Error {}
/** The reviewer's own slug is used by another article. */
export class SlugTaken extends Error {}
/** The category doesn't exist (any more). */
export class CategoryGone extends Error {}

const codeOf = (error: unknown) => (error as {code?: unknown} | null)?.code;

export async function acceptIssue(db: PrismaClient, id: number, input: AcceptFields, me: number): Promise<Accepted> {
  const max = KB_LIMITS.articleSlug;
  // A read, so it stays out of the transaction; a slug taken meanwhile is a P2002 and one retry.
  const free = input.slug ? null : await newArticleSlug(db, input.title);

  const attempt = (retrySlug: boolean) =>
    db.$transaction(async tx => {
      const claimed = await tx.$queryRaw<
        {type: string; articleId: number | null; draftAction: string | null; articleStatus: string | null; categoryId: number | null; articleUpdatedAt: Date | null; editedSince: boolean | null}[]
      >`
        UPDATE "health_issues" h
        SET "state" = 'accepted', "resolved_by" = ${me}, "resolved_at" = now(), "updated_at" = now()
        WHERE h."id" = ${id} AND h."state" = 'open'
        RETURNING h."type", h."article_id" AS "articleId", h."evidence"->>'draftAction' AS "draftAction",
          (SELECT a."status" FROM "kb_articles" a WHERE a."id" = h."article_id") AS "articleStatus",
          (SELECT a."category_id" FROM "kb_articles" a WHERE a."id" = h."article_id") AS "categoryId",
          (SELECT a."updated_at" FROM "kb_articles" a WHERE a."id" = h."article_id") AS "articleUpdatedAt",
          (SELECT a."updated_at" > h."created_at" FROM "kb_articles" a WHERE a."id" = h."article_id") AS "editedSince"`;
      const issue = claimed[0];
      if (!issue) throw new NotOpen();

      let mode: Accepted['mode'] = 'created';
      let article: {id: number; title: string} | null = null;
      // A draft written as a whole new article (a conflict that points at its cited article) never
      // replaces that article: it is always a new draft.
      const inPlace = issue.draftAction !== 'new';
      if (inPlace && issue.articleId && issue.articleStatus === 'draft' && issue.editedSince === false && issue.articleUpdatedAt) {
        try {
          // The KB's draft update (kb/articles.ts updateDraftArticle), plus "nobody saved it since".
          const row = await tx.kbArticle.update({
            where: {id: issue.articleId, status: 'draft', updatedAt: issue.articleUpdatedAt},
            data: {
              title: input.title,
              body: input.body,
              excerpt: input.excerpt || excerptOf(input.body),
              // The reviewer's category, when they picked one (a missing one is a P2003 → CategoryGone).
              ...(input.categoryId ? {categoryId: input.categoryId} : {}),
              lastReviewedAt: new Date(),
              updatedBy: me,
            },
            select: {id: true, title: true},
          });
          article = row;
          mode = 'updated';
        } catch (error) {
          // Saved, published or deleted since the claim: a new draft instead (P2025 is Prisma's own
          // "no row matched", raised without any SQL error, so the transaction is still usable).
          if (codeOf(error) !== 'P2025') throw error;
        }
      }
      if (!article) {
        const categoryId = input.categoryId ?? issue.categoryId;
        if (!categoryId) throw new NeedsCategory();
        const slug = input.slug ?? (retrySlug ? randomSlug(free!.base, max) : free!.slug);
        const row = await insertArticle(
          tx,
          {title: input.title, body: input.body, categoryId, excerpt: input.excerpt, status: 'draft'},
          me,
          slug
        );
        article = {id: row.id, title: row.title};
      }

      await tx.$executeRaw`UPDATE "health_issues" SET "accepted_article_id" = ${article.id} WHERE "id" = ${id}`;
      return {type: issue.type, mode, article, sourceArticleId: issue.articleId};
    });

  try {
    try {
      return await attempt(false);
    } catch (error) {
      // An auto-made slug taken meanwhile: everything rolled back; one more try with a random tail.
      if (codeOf(error) !== 'P2002' || !free) throw error;
      return await attempt(true);
    }
  } catch (error) {
    const code = codeOf(error);
    if (code === 'P2002') throw new SlugTaken();
    // P2025 here can only come from the insert (the draft update's own P2025 is handled above).
    if (code === 'P2003' || code === 'P2025') throw new CategoryGone();
    throw error;
  }
}
