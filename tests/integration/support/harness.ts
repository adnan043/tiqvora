import {createHmac} from 'node:crypto';

import type {Hono} from 'hono';

import {resetOwnerSeatForTests} from '../../../src/platform/auth/owner-seat';
import {PREVIEW_COOKIE_HEADER, PREVIEW_SET_COOKIE_HEADER} from '../../../src/platform/auth/preview-cookies';
import {createDb, getDb} from '../../../src/platform/db';
import {inRequestScope} from '../../../src/platform/request-scope';
import {env} from './cloudflare-workers';

/**
 * Drives the REAL Site API (`src/server/app.ts`) in Node, against a real
 * Postgres, the way a browser would: an origin, cookies kept in a jar, the
 * CSRF cookie echoed in `x-csrf-token`, a client IP (`cf-connecting-ip`).
 * Each request runs in its own request scope with an execution context, and
 * its background work (`waitUntil`: relayed emails) finishes before it returns.
 *
 * Emails to the platform (`POST {SITE_URL}/api/site/v1/emails`) are
 * captured here. With `TEST_PLATFORM_URL` + `TEST_SITE_KEY` set, they are ALSO
 * sent to that real platform API, and its status is recorded.
 */

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const ORIGIN = 'https://shop.example.test';
const PLATFORM = process.env.TEST_PLATFORM_URL?.replace(/\/+$/, '') || 'https://platform.example.test';

export function configureEnv() {
  env.DATABASE_URL = DATABASE_URL;
  env.JWT_SECRET = 'integration-test-secret-0123456789-abcdefghijklmnop';
  env.SITE_URL = PLATFORM;
  env.SITE_KEY = process.env.TEST_SITE_KEY ?? 'stk_test_stub';
  env.SITE_PREVIEW = '';
  env.SITE_OWNER_ID = OWNER_ID;
}

export interface SentEmail {
  kind: string;
  to: string;
  path?: string;
  expiresInMinutes?: number;
  /** `sign_in_code` only: the 6 digits. */
  code?: string;
  /** The real platform's answer, when TEST_PLATFORM_URL is set. */
  platformStatus?: number;
}

/** The platform's opaque id for this site's owner. */
export const OWNER_ID = Buffer.alloc(32, 1).toString('base64url');
export const NEXT_OWNER_ID = Buffer.alloc(32, 2).toString('base64url');

export const emails: SentEmail[] = [];
const realFetch = globalThis.fetch;

/**
 * The platform's contract for `POST /api/site/v1/emails`, copied from
 * `api/app/modules/site_api/site_api.validator.ts`: a payload the real API
 * would refuse fails the test here.
 */
const KINDS = [
  'password_reset',
  'verify_email',
  'password_changed',
  'account_exists',
  'notification',
  'confirm_email_change',
  'email_changed',
  'sign_in_code',
  'sign_up_code',
  'email_change_requested',
  'two_factor_on',
  'two_factor_off',
  'recovery_codes_new',
];
const LINK_REQUIRED = ['password_reset', 'verify_email', 'confirm_email_change', 'sign_up_code', 'email_change_requested'];
// eslint-disable-next-line no-control-regex
const SITE_PATH = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

function assertContract(body: Record<string, unknown>) {
  const fail = (why: string) => {
    throw new Error(`email payload breaks the platform contract: ${why} ${JSON.stringify(body)}`);
  };
  const allowed = new Set(['kind', 'to', 'path', 'expiresInMinutes', 'subject', 'text', 'code']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) fail(`unknown field ${key}`);
  if (!KINDS.includes(String(body.kind))) fail('kind');
  if (typeof body.to !== 'string' || body.to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) fail('to');
  if (body.path !== undefined && (typeof body.path !== 'string' || body.path.length > 512 || !SITE_PATH.test(body.path))) {
    fail('path');
  }
  if (LINK_REQUIRED.includes(String(body.kind)) && body.path === undefined) fail('path required');
  if ((body.kind === 'sign_in_code' || body.kind === 'sign_up_code') && (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code))) fail('code');
  if (body.kind !== 'sign_in_code' && body.kind !== 'sign_up_code' && body.code !== undefined) fail('code only for code kinds');
  if (
    body.expiresInMinutes !== undefined &&
    (!Number.isInteger(body.expiresInMinutes) || (body.expiresInMinutes as number) < 1 || (body.expiresInMinutes as number) > 7 * 24 * 60)
  ) {
    fail('expiresInMinutes');
  }
}

/**
 * One-click owner sign-in tickets the fake platform will redeem ONCE
 * (`POST /api/site/v1/owner-sign-in`, apps/api owner_sign_in.service.ts): ticket → answer.
 */
export const ownerTickets = new Map<string, {ownerId: string}>();

/** Who the fake platform says owns the site now (`POST /api/site/v1/owner-current`). Null: it can't be reached. Undefined: nobody. */
export const platformOwner: {current: string | null | undefined} = {current: null};

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${PLATFORM}/api/site/v1/owner-sign-in`) {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${env.SITE_KEY}`) throw new Error('owner sign-in without the Site Key');
    const {ticket} = JSON.parse(String(init?.body ?? '{}')) as {ticket?: string};
    const answer = ticket ? ownerTickets.get(ticket) : undefined;
    if (!answer || !ticket) return new Response(JSON.stringify({errors: [{code: 'E_OWNER_TICKET_INVALID'}]}), {status: 404});
    ownerTickets.delete(ticket);
    return new Response(JSON.stringify({data: answer}), {status: 200});
  }
  if (url === `${PLATFORM}/api/site/v1/owner-current`) {
    if (platformOwner.current === undefined) return new Response(JSON.stringify({data: {ownerId: null}}), {status: 200});
    return platformOwner.current ? new Response(JSON.stringify({data: {ownerId: platformOwner.current}}), {status: 200}) : new Response('{}', {status: 503});
  }
  if (url === `${PLATFORM}/api/site/v1/emails`) {
    const body = JSON.parse(String(init?.body ?? '{}')) as SentEmail;
    assertContract(body as unknown as Record<string, unknown>);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${env.SITE_KEY}`) throw new Error('email relay without the Site Key');
    if (process.env.TEST_PLATFORM_URL) {
      const res = await realFetch(input, init);
      body.platformStatus = res.status;
      emails.push(body);
      return res;
    }
    emails.push(body);
    return new Response(JSON.stringify({data: {queued: true}}), {status: 202});
  }
  if (url.startsWith(PLATFORM)) return new Response('{}', {status: 404});
  return realFetch(input, init);
};

/** The 6-digit code in the last sign-in code email to `to`. */
export function codeFrom(to: string): string {
  const mail = [...emails].reverse().find(e => e.kind === 'sign_in_code' && e.to === to);
  if (!mail?.code) throw new Error(`no sign-in code email to ${to}`);
  return mail.code;
}

/** The token in the last email of `kind` to `to`. */
export function tokenFrom(kind: string, to: string): string {
  const mail = [...emails].reverse().find(e => e.kind === kind && e.to === to);
  const token = mail?.path ? new URL(mail.path, ORIGIN).searchParams.get('token') : null;
  if (!token) throw new Error(`no ${kind} email to ${to}`);
  return token;
}

/** A direct client for setup and assertions (never the code under test). */
export const db = createDb(DATABASE_URL || 'postgresql://unused@localhost/unused');

export async function resetDatabase() {
  await db.$executeRawUnsafe(
    'TRUNCATE "pending_sign_ups", "users", "user_roles", "refresh_tokens", "password_resets", "email_verifications", "email_changes", "recovery_codes", "sign_in_codes", "login_attempts", "audit_events", "jobs", "job_deliveries", "kb_chunks", "kb_articles", "kb_categories", "kb_snippets", "helpdesk_quick_replies", "helpdesk_human_topics", "rate_windows", "question_logs", "ai_usage", "idempotency_keys", "conversations", "messages", "tickets", "ticket_views", "helpdesk_counters", "helpdesk_canned_replies", "question_stats_daily" RESTART IDENTITY CASCADE'
  );
  // Ticket numbers start at #1001 (the migration's RESTART; TRUNCATE ... RESTART IDENTITY puts them back to 1).
  await db.$executeRawUnsafe('ALTER SEQUENCE "tickets_number_seq" RESTART WITH 1001');
  // The two tile counters the migration inserts (state.ts upserts them anyway).
  await db.$executeRawUnsafe(`INSERT INTO "helpdesk_counters" ("name", "value") VALUES ('unsolved', 0), ('waiting_on_us', 0) ON CONFLICT ("name") DO NOTHING`);
  await db.$executeRawUnsafe('DELETE FROM "roles" WHERE NOT "is_system"');
  await db.$executeRawUnsafe('UPDATE "auth_state" SET "owner_user_id" = NULL, "owner_env_id" = NULL');
  emails.length = 0;
  ownerTickets.clear();
  platformOwner.current = null;
  resetOwnerSeatForTests();
}

type App = Pick<Hono, 'request'>;

/**
 * One browser: a cookie jar, an IP, a user agent. `gateway: 'preview'` is a
 * browser behind the editor Preview's gateway, which drops `Cookie` and
 * `Set-Cookie`: the jar then travels only in the Preview's cookie headers
 * (`src/platform/auth/preview-cookies.ts`), as `src/platform/browser.ts` does.
 */
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly app: App,
    readonly ip = '203.0.113.10',
    readonly gateway: 'direct' | 'preview' = 'direct'
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(`__Host-${name}`);
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers = new Headers({
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': this.ip,
      'user-agent': 'integration-test',
      ...extra,
    });
    if (method !== 'GET') {
      if (!this.cookie('site_csrf')) await this.request('GET', '/site-api/auth/csrf');
      if (!('x-csrf-token' in extra)) headers.set('x-csrf-token', this.cookie('site_csrf') ?? '');
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const jar = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.jar.size) headers.set(this.gateway === 'preview' ? PREVIEW_COOKIE_HEADER : 'cookie', jar);

    const res = await inRequestScope(async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
      const response = await this.app.request(
        `${ORIGIN}${path}`,
        {method, headers, body: body === undefined ? undefined : JSON.stringify(body)},
        {},
        ctx as never
      );
      // Background work can start more background work (register → verify email): drain it all.
      while (pending.length) await pending.shift();
      await getDb()?.$disconnect();
      return response;
    });

    if (this.gateway === 'preview') {
      // The gateway dropped Set-Cookie; the Preview hands the cookies over in a header.
      const mirrored = JSON.parse(res.headers.get(PREVIEW_SET_COOKIE_HEADER) ?? '[]') as [string, string, number][];
      for (const [name, value, maxAge] of mirrored) {
        if (maxAge > 0) this.jar.set(name, value);
        else this.jar.delete(name);
      }
    } else {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';').map(part => part.trim());
        const eq = pair!.indexOf('=');
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        const maxAge = attrs.find(a => a.startsWith('Max-Age='));
        if (maxAge === 'Max-Age=0') this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {text};
    }
    return {status: res.status, json, headers: res.headers};
  }

  get = (path: string) => this.request('GET', path);
  delete = (path: string) => this.request('DELETE', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body ?? {});
}

/** Register, confirm and sign in: a ready signed-in browser. */
export async function signedIn(app: App, email: string, password = 'a long test passphrase', ip?: string) {
  const browser = new Browser(app, ip);
  const reg = await browser.post('/site-api/auth/register', {email, name: email.split('@')[0], password});
  if (reg.status !== 202) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`);
  const verify = await browser.post('/site-api/auth/register/verify', {email, code: signUpCodeFrom(email)});
  if (verify.status !== 201) throw new Error(`verify ${verify.status} ${JSON.stringify(verify.json)}`);
  // A new account's sign-up email shouldn't hold back what a test asks for next.
  await mailGateOpen();
  return browser;
}

/**
 * An account from before sign-up needed a code: a row with a password, never confirmed, and the
 * link that used to be emailed for it. Sites that upgrade have these, some of them a stranger's.
 */
export async function unconfirmedAccount(email: string, password = 'a long test passphrase') {
  const {hashPassword} = await import('../../../src/platform/auth/password');
  const {sha256Hex} = await import('../../../src/platform/auth/encoding');
  const created = await db.user.create({
    data: {email, name: email.split('@')[0]!, passwordHash: await hashPassword(password), roles: {create: {role: {connect: {slug: 'member'}}}}},
    select: {id: true},
  });
  const token = `${'t'.repeat(30)}${String(created.id).padStart(13, '0')}`;
  await db.emailVerification.create({
    data: {userId: created.id, email, tokenHash: await sha256Hex(token), expiresAt: new Date(Date.now() + 3600 * 1000)},
    select: {id: true},
  });
  return {user: {id: created.id, token}, password};
}

/** The 15-minute gap between emails to an address has passed. */
export const mailGateOpen = () => db.loginAttempt.deleteMany({where: {kind: {in: ['mail', 'notice']}}});

/** The newest sign-up code emailed to this address. */
export function signUpCodeFrom(to: string): string {
  const mail = [...emails].reverse().find(one => one.kind === 'sign_up_code' && one.to === to);
  if (!mail?.code) throw new Error(`no sign_up_code email to ${to}`);
  return mail.code;
}

/** The token in the newest sign-up email to this address. */
export function signUpTokenFrom(to: string): string {
  const mail = [...emails].reverse().find(one => one.kind === 'sign_up_code' && one.to === to);
  if (!mail?.path) throw new Error(`no sign_up_code email to ${to}`);
  return new URL(mail.path, ORIGIN).searchParams.get('signup')!;
}

let ticketCount = 0;

/** The account's owner pressing "View as admin": the one way to become owner. */
export async function ownerSignedIn(app: App, ownerId = OWNER_ID, ip?: string) {
  const ticket = `T${String(++ticketCount).padStart(42, '0')}`;
  ownerTickets.set(ticket, {ownerId});
  const browser = new Browser(app, ip);
  const res = await browser.get(`/site-api/auth/owner?ticket=${ticket}`);
  if (res.status !== 303 || res.headers.get('location')?.includes('notice=')) {
    throw new Error(`owner sign-in ${res.status} ${res.headers.get('location')}`);
  }
  return browser;
}

/** The owner account's `users.id`. */
export async function ownerAccountId(ownerId = OWNER_ID): Promise<number> {
  return (await db.user.findUniqueOrThrow({where: {platformOwnerId: ownerId}, select: {id: true}})).id;
}

export async function userId(email: string): Promise<number> {
  return (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
}

// ---------------------------------------------------------------------------
// Help desk, Phase 3 (hand-off, My support, inbox): shared helpers.

/** Exactly these roles, whatever sign-up gave (the first account may have become owner). */
export async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  if (roles.length !== new Set(slugs).size) throw new Error(`setRoles: unknown role in ${slugs.join(', ')}`);
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
  return id;
}

/** A role holding exactly these codenames (call after `ensurePermissions(db, CATALOGUE)`). */
export async function createRole(slug: string, codenames: string[]) {
  const role = await db.role.create({data: {slug, name: slug, description: null}, select: {id: true}});
  const perms = await db.permission.findMany({where: {codename: {in: codenames}}, select: {id: true, codename: true}});
  if (perms.length !== codenames.length) {
    const missing = codenames.filter(c => !perms.some(p => p.codename === c));
    throw new Error(`createRole ${slug}: no permission row for ${missing.join(', ')}`);
  }
  if (perms.length) await db.rolePermission.createMany({data: perms.map(p => ({roleId: role.id, permissionId: p.id}))});
  return role.id;
}

/** `n` calls at once (the real Postgres decides who wins). */
export const inParallel = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> => Promise.all(Array.from({length: n}, (_, i) => fn(i)));

/** A fresh idempotency key (IDEMPOTENCY_KEY shape: 16–64 of [A-Za-z0-9_-]). */
export const newKey = () => `k${crypto.randomUUID().replaceAll('-', '')}`;

export interface Tiles {
  unsolved: number;
  waitingOnUs: number;
  solvedThisWeek: number;
}

/** The tiles recounted from the tickets themselves (the truth the kept counters must equal). */
export async function groundTruthCounters(): Promise<Tiles> {
  const [row] = await db.$queryRaw<{unsolved: number; waiting: number; solved: number}[]>`
    SELECT count(*) FILTER (WHERE c."status" IN ('waiting', 'open', 'pending'))::int AS unsolved,
           count(*) FILTER (WHERE c."status" IN ('waiting', 'open'))::int AS waiting,
           count(*) FILTER (WHERE c."status" = 'solved'
             AND t."solved_at" >= (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::int AS solved
    FROM "conversations" c JOIN "tickets" t ON t."conversation_id" = c."id"`;
  return {unsolved: row!.unsolved, waitingOnUs: row!.waiting, solvedThisWeek: row!.solved};
}

/** The kept counter rows, read straight from the table (missing row = 0). */
export async function storedCounters(): Promise<Tiles> {
  const rows = await db.$queryRaw<{name: string; value: number}[]>`
    SELECT "name", "value" FROM "helpdesk_counters"
    WHERE "name" IN ('unsolved', 'waiting_on_us', 'solved:' || to_char(date_trunc('week', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD'))`;
  const of = (pick: (name: string) => boolean) => rows.find(r => pick(r.name))?.value ?? 0;
  return {unsolved: of(n => n === 'unsolved'), waitingOnUs: of(n => n === 'waiting_on_us'), solvedThisWeek: of(n => n.startsWith('solved:'))};
}

/** Fails with the offending needle and where it sits when any needle is in the JSON of `value`. */
export function expectNoLeak(value: unknown, needles: (string | RegExp)[], what = 'response') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  for (const needle of needles) {
    const at = typeof needle === 'string' ? text.indexOf(needle) : text.search(needle);
    if (at >= 0) throw new Error(`${what} leaks ${String(needle)}: …${text.slice(Math.max(0, at - 80), at + 80)}…`);
  }
}

/** A rate window row as if `count` requests already used it (`hour` = this hour's bucket, `prev-hour` = the last one, `minute` = this minute). */
export async function setRateWindow(bucket: string, count: number, at: 'hour' | 'prev-hour' | 'minute' = 'hour') {
  const name = bucket.slice(0, 40);
  if (at === 'minute') {
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count") VALUES (${name}, date_trunc('minute', now()), ${count})
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = EXCLUDED."count"`;
  } else if (at === 'hour') {
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count") VALUES (${name}, date_trunc('hour', now()), ${count})
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = EXCLUDED."count"`;
  } else {
    await db.$executeRaw`INSERT INTO "rate_windows" ("bucket", "minute", "count") VALUES (${name}, date_trunc('hour', now()) - interval '1 hour', ${count})
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = EXCLUDED."count"`;
  }
}

/**
 * Tickets straight into the tables (no routes, no counters, no limits): for paging and filters.
 * Returns the ticket numbers in insert order. One statement per table.
 */
export async function seedTickets(
  n: number,
  opts: {userId: number | null; status?: string; priority?: string; assigneeId?: number | null; lastMessageAt?: Date; solvedAt?: Date | null; subject?: string}
): Promise<number[]> {
  const status = opts.status ?? 'waiting';
  const at = opts.lastMessageAt ?? new Date();
  const solvedAt = opts.solvedAt !== undefined ? opts.solvedAt : status === 'solved' ? new Date() : null;
  const rows = await db.$queryRaw<{number: number}[]>`
    WITH c AS (
      INSERT INTO "conversations" ("user_id", "status", "request_key", "last_message_at", "updated_at")
      SELECT ${opts.userId}::int, ${status}, 'seed' || md5(random()::text || g::text), ${at}::timestamptz, now()
      FROM generate_series(1, ${n}::int) g
      RETURNING "id"
    ), t AS (
      INSERT INTO "tickets" ("conversation_id", "subject", "priority", "assignee_id", "solved_at", "ai_summary_state", "updated_at")
      SELECT c."id", ${opts.subject ?? 'Seeded ticket'}, ${opts.priority ?? 'normal'}, ${opts.assigneeId ?? null}::int, ${solvedAt}::timestamptz, 'unavailable', now()
      FROM c ORDER BY c."id"
      RETURNING "number", "conversation_id"
    ), m AS (
      INSERT INTO "messages" ("conversation_id", "sender", "author_user_id", "body")
      SELECT c."id", 'customer', ${opts.userId}::int, ${'Seeded message'} FROM c
    )
    SELECT "number" FROM t ORDER BY "number"`;
  return rows.map(r => r.number);
}

/** The secret the fake platform signs job deliveries with (set `env.SITE_JOBS_SECRET` to it). */
export const JOBS_SECRET = 'jobs-secret-for-integration-0123456789abcdef';

/** A job delivery exactly as the platform signs it (api site_jobs.rules.ts signDelivery). */
export function jobDelivery(job: {id: string; list: string; attempt?: number; maxAttempts?: number; data: unknown}, secret = JOBS_SECRET) {
  const text = JSON.stringify({attempt: 1, maxAttempts: 4, scheduledFor: new Date().toISOString(), ...job});
  const at = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret).update(`${at}.${text}`).digest('hex');
  return new Request(`${ORIGIN}/site-api/_platform/jobs`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-site-signature': `t=${at},v1=${mac}`},
    body: text,
  });
}

/** The help desk settings row back to known values (it is never truncated). */
export async function resetHelpdeskSettings(model = 'claude-opus-5-5', monthlyCapCents = 2000) {
  const settings = {
    assistantName: 'Assistant',
    greeting: 'Hi! Ask me anything about our products and orders.',
    tone: 'friendly',
    confidenceThreshold: 'medium',
    provider: 'anthropic',
    model,
    monthlyCapCents,
    launcherLabel: 'Support',
    businessHours: '',
    helpTitle: 'How can we help?',
    helpIntro: 'Search our guides, or ask the assistant.',
    updatedBy: null,
  };
  await db.helpdeskSettings.upsert({where: {id: 1}, create: {id: 1, ...settings}, update: settings, select: {id: true}});
}

/** Test roles for the help desk (resetDatabase removes non-system roles, the shipped `agent` too). */
export const HD_ROLE = {agent: 'p3-agent', admin: 'p3-admin', kb: 'p3-kb'} as const;
export const HD_CODENAMES = {
  inbox: 'site:helpdesk:inbox',
  delete: 'site:helpdesk:delete',
  kbEdit: 'site:kb:edit',
  userRead: 'site:user:read',
} as const;

export interface HelpdeskCast {
  guest: Browser;
  alice: Browser;
  bob: Browser;
  agentA: Browser;
  agentB: Browser;
  admin: Browser;
  kbOnly: Browser;
  ids: {alice: number; bob: number; agentA: number; agentB: number; admin: number; kbOnly: number};
}

/**
 * The cast every Phase 3 file uses: customers alice and bob (`member`), agents A and B (inbox + KB, NOT
 * site:user:read), an admin (inbox + delete + site:user:read), a KB-only editor. Distinct IPs (sign-in limits).
 * `only` signs up just those (sign-ups cost a scrypt each).
 */
export async function helpdeskCast(app: App, only?: (keyof HelpdeskCast['ids'])[]): Promise<HelpdeskCast> {
  const {ensurePermissions} = await import('../../../src/platform/permission-sync');
  const {CATALOGUE} = await import('../../../src/server/permissions');
  await ensurePermissions(db, CATALOGUE);
  await createRole(HD_ROLE.agent, [HD_CODENAMES.inbox, HD_CODENAMES.kbEdit]);
  await createRole(HD_ROLE.admin, [HD_CODENAMES.inbox, HD_CODENAMES.delete, HD_CODENAMES.kbEdit, HD_CODENAMES.userRead]);
  await createRole(HD_ROLE.kb, [HD_CODENAMES.kbEdit]);
  const people: [keyof HelpdeskCast['ids'], string, string, string[]][] = [
    ['alice', 'alice@example.test', '203.0.113.101', ['member']],
    ['bob', 'bob@example.test', '203.0.113.102', ['member']],
    ['agentA', 'agent-a@example.test', '203.0.113.103', ['member', HD_ROLE.agent]],
    ['agentB', 'agent-b@example.test', '203.0.113.104', ['member', HD_ROLE.agent]],
    ['admin', 'boss@example.test', '203.0.113.105', ['member', HD_ROLE.admin]],
    ['kbOnly', 'writer@example.test', '203.0.113.106', ['member', HD_ROLE.kb]],
  ];
  const cast = {guest: new Browser(app, '203.0.113.100'), ids: {}} as HelpdeskCast;
  for (const [who, email, ip, roles] of people) {
    if (only && !only.includes(who)) continue;
    (cast as unknown as Record<string, Browser>)[who] = await signedIn(app, email, undefined, ip);
    cast.ids[who] = await setRoles(email, ...roles);
  }
  return cast;
}

export type FakeCall = {key: string; req: {model: string; system: string; messages: {role: string; content: string}[]; maxTokens?: number; timeoutMs?: number; schema?: unknown}};

/** A customer hands off one conversation (the widget's POST); returns the ticket number. */
export async function openTicket(browser: Browser, text = 'My grinder stopped working.', key = newKey()): Promise<number> {
  // Setup, not the case under test: the 5-a-minute hand-off window per connection is tested on its own.
  await db.$executeRaw`DELETE FROM "rate_windows" WHERE "bucket" LIKE 'hd-handoff:%'`;
  const res = await browser.request('POST', '/site-api/helpdesk/conversations', {key, transcript: [{role: 'customer', text}], note: '', page: '/'}, {'idempotency-key': key});
  if (res.status !== 201) throw new Error(`hand-off ${res.status} ${JSON.stringify(res.json)}`);
  return (res.json.ticket as {number: number}).number;
}

/** The conversation's status, straight from the table. */
export async function statusOf(number: number): Promise<string> {
  const row = await db.ticket.findUniqueOrThrow({where: {number}, select: {conversation: {select: {status: true}}}});
  return row.conversation.status;
}

/** An agent's reply or note (the staff composer). */
export const agentSay = (browser: Browser, number: number, body: string, opts: {kind?: 'reply' | 'note'; expectedStatus?: string; setStatus?: string; key?: string} = {}) =>
  browser.post(`/site-api/helpdesk/tickets/${number}/messages`, {
    kind: opts.kind ?? 'reply',
    body,
    key: opts.key ?? newKey(),
    expectedStatus: opts.expectedStatus ?? 'waiting',
    ...(opts.setStatus ? {setStatus: opts.setStatus} : {}),
  });

/** A customer's reply from My support. */
export const customerSay = (browser: Browser, number: number, body: string, key = newKey()) =>
  browser.post(`/site-api/helpdesk/my/tickets/${number}/messages`, {body, key});

/** An agent moves the status (conditional on `from`). */
export const setStatus = (browser: Browser, number: number, from: string, to: string) =>
  browser.post(`/site-api/helpdesk/tickets/${number}/status`, {from, to});
