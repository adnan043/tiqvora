import type {Context} from 'hono';
import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {type CannedReply, TICKET_LIMITS} from '../../lib/helpdesk-tickets';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

/**
 * Saved replies: short answers agents insert into the inbox composer. The agents' own shared
 * list: read AND written by inbox holders (`site:helpdesk:inbox`). At most 100.
 * Mounted at `/site-api/helpdesk/canned` (src/server/app.ts).
 *
 *   GET    /              every saved reply (≤ 100, position then id)
 *   POST   /              {title, body, position?} → 201 (409 at 100)
 *   PATCH  /:id           {title?, body?, position?}
 *   DELETE /:id
 *
 * Placeholders such as `{{customer.firstName}}` are filled in by the dashboard when a reply is
 * inserted, never here. Not cached: read by a few agents when they open the picker (~3 ms);
 * every answer, a validator's 422 too, is `no-store`. Audited after commit:
 * `helpdesk_canned_created|updated|deleted` with the id only (never the title or text).
 */

const MAX_POSITION = 1000;
const canWork = requirePermission(PERMISSIONS.HELPDESK_INBOX);
/** C0 control characters except tab and line feed (NUL included). */
const CONTROL_EXCEPT_TAB_LF_RE = /[\u0000-\u0008\u000b-\u001f]/;
const ID_RE = /^\d{1,9}$/;
/** A UTF-16 surrogate without its pair (linear: one character of lookaround each side). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

type Fields = Record<string, string>;
type Input = {title?: string; body?: string; position?: number};

const select = {id: true, title: true, body: true, position: true} as const;
const toReply = (row: CannedReply): CannedReply => ({id: row.id, title: row.title, body: row.body, position: row.position});

/** Lone surrogates → U+FFFD, so a broken pair can't reach the validators or the database. */
const wellFormed = (text: string): string => text.replace(LONE_SURROGATE_RE, '\uFFFD');

/** Every answer here, a validator's 422 too, is never cached (withViewer makes it `private, no-store`). */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const given = (v: Record<string, unknown>, key: string) => v[key] !== undefined && v[key] !== null;
const idOf = (value: string | undefined) => (value && ID_RE.test(value) && Number(value) > 0 ? Number(value) : undefined);

const invalid = (c: Context, fields: Fields) =>
  c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422);

const notFound = (c: Context) => c.json(problem('not_found', 'No such saved reply.'), 404);

function readReply(v: Record<string, unknown>, partial: boolean): {out: Input; fields: Fields} {
  const out: Input = {};
  const fields: Fields = {};
  if (given(v, 'title') || !partial) {
    const title = typeof v.title === 'string' ? wellFormed(v.title).replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > TICKET_LIMITS.cannedTitle) fields.title = `A title needs 1 to ${TICKET_LIMITS.cannedTitle} characters.`;
    else if (CONTROL_EXCEPT_TAB_LF_RE.test(title)) fields.title = 'Remove the special characters from the title.';
    else out.title = title;
  }
  if (given(v, 'body') || !partial) {
    const body = typeof v.body === 'string' ? wellFormed(v.body).replace(/\r\n?/g, '\n').trim() : '';
    if (!body || body.length > TICKET_LIMITS.cannedBody) fields.body = `A reply needs 1 to ${TICKET_LIMITS.cannedBody} characters.`;
    else if (CONTROL_EXCEPT_TAB_LF_RE.test(body)) fields.body = 'Remove the special characters from the reply.';
    else out.body = body;
  }
  if (given(v, 'position')) {
    const position = v.position;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > MAX_POSITION) {
      fields.position = `A position is a whole number from 0 to ${MAX_POSITION}.`;
    } else out.position = position;
  }
  if (partial && !Object.keys(fields).length && !Object.keys(out).length) fields.title = 'Change the title, the text or the position.';
  return {out, fields};
}

const replyBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const {out, fields} = readReply(objectOf(value), partial);
    return Object.keys(fields).length ? invalid(c, fields) : out;
  });

export const cannedRoutes = new Hono()
  .use(noStore)
  // Index: helpdesk_canned_replies(position, id); the table holds at most 100 rows (the
  // dashboard filters them itself).
  .get('/', withViewer, requireAuth, canWork, withDb, async c => {
    const rows = await c.var.db.helpdeskCannedReply.findMany({
      select,
      orderBy: [{position: 'asc'}, {id: 'asc'}],
      take: TICKET_LIMITS.cannedMax,
    });
    return c.json({replies: rows.map(toReply)});
  })

  // The cap is decided by the database: a short lock on "the saved replies", then an insert that
  // only happens while there are fewer than 100 (two agents adding the 100th can't both win).
  .post('/', replyBody(false), withViewer, requireAuth, canWork, withDb, async c => {
    const input = c.req.valid('json') as Required<Pick<Input, 'title' | 'body'>> & Input;
    const db = c.var.db;
    const me = c.var.viewer.id!;
    const position = input.position ?? 0;
    const [, rows] = await db.$transaction([
      db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('helpdesk:canned', 0))`,
      db.$queryRaw<CannedReply[]>`
        INSERT INTO helpdesk_canned_replies (title, body, position, created_by, updated_by, updated_at)
        SELECT ${input.title}::text, ${input.body}::text, ${position}::int, ${me}::int, ${me}::int, now()
        WHERE (SELECT count(*) FROM helpdesk_canned_replies) < ${TICKET_LIMITS.cannedMax}::int
        RETURNING id, title, body, position`,
    ]);
    const row = rows[0];
    if (!row) {
      return c.json(problem('too_many', `You can keep up to ${TICKET_LIMITS.cannedMax} saved replies. Delete one first.`), 409);
    }
    await audit(db, {actorUserId: me, action: 'helpdesk_canned_created', target: ['canned_reply', row.id], meta: {id: row.id}});
    return c.json({reply: toReply(row)}, 201);
  })

  .patch('/:id', replyBody(true), withViewer, requireAuth, canWork, withDb, async c => {
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c);
    const input = c.req.valid('json');
    let row: CannedReply;
    try {
      row = await c.var.db.helpdeskCannedReply.update({
        where: {id},
        data: {
          ...(input.title !== undefined ? {title: input.title} : {}),
          ...(input.body !== undefined ? {body: input.body} : {}),
          ...(input.position !== undefined ? {position: input.position} : {}),
          updatedBy: c.var.viewer.id!,
        },
        select,
      });
    } catch (error) {
      if ((error as {code?: unknown} | null)?.code === 'P2025') return notFound(c);
      throw error;
    }
    await audit(c.var.db, {actorUserId: c.var.viewer.id!, action: 'helpdesk_canned_updated', target: ['canned_reply', id], meta: {id}});
    return c.json({reply: toReply(row)});
  })

  .delete('/:id', withViewer, requireAuth, canWork, withDb, async c => {
    const id = idOf(c.req.param('id'));
    const {count} = id ? await c.var.db.helpdeskCannedReply.deleteMany({where: {id}}) : {count: 0};
    if (!count || !id) return notFound(c);
    await audit(c.var.db, {actorUserId: c.var.viewer.id!, action: 'helpdesk_canned_deleted', target: ['canned_reply', id], meta: {id}});
    return c.json({ok: true});
  });
