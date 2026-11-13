import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';

import {isPreview} from '../platform/api';
import {adminRoutes, authRoutes, getAccess, getViewer} from '../platform/auth';
import {config} from '../platform/config';
import {csrf, previewCookies, problem, sameOrigin} from '../platform/guards';
import {syncPermissions} from '../platform/permission-sync';
import {authSettings} from './auth-settings';
import {checkoutRoutes, membershipRoutes} from './routes/checkout';
import {abilitiesFor, CATALOGUE} from './permissions';
import {cannedRoutes} from './routes/canned';
import {helpdeskRoutes} from './routes/helpdesk';
import {helpdeskReportRoutes} from './routes/helpdesk-reports';
import {helpdeskSettingsRoutes} from './routes/helpdesk-settings';
import {inboxRoutes} from './routes/inbox';
import {kbRoutes} from './routes/kb';
import {kbFileRoutes} from './routes/kb-files';
import {kbManageRoutes} from './routes/kb-manage';
import {knowledgeHealthRoutes} from './routes/knowledge-health';
import {siteRoutes} from './routes/site';
import {conversationRoutes, myTicketRoutes} from './routes/support';
import {testLabRoutes} from './routes/test-lab';

/**
 * The Site API: this site's ONLY backend, one Hono app at `/site-api/*`.
 *
 * Everything reads and writes through it: the Astro pages call it IN-PROCESS
 * (`src/server/backend.ts`), the portal and the `/account` pages call it from
 * the browser (`siteFetch` / the typed `hc` client, `src/portal/api.ts`).
 * Mounted by ONE catch-all page, `src/pages/site-api/[...path].ts`.
 *
 *   GET  /health        what this site has been given (booleans only)
 *   GET  /me            the visitor + what the UI may show them
 *   *    /auth/...      sign-up, sign-in, sessions, passwords   platform/auth/routes.ts
 *   *    /admin/...     users, roles, audit log (admins)        platform/auth/admin.ts
 *   GET  /site          the site's brand                        routes/site.ts
 *   *    /kb/files/...  knowledge files → draft articles (editors) routes/kb-files.ts
 *   *    /kb/manage/... the knowledge base, for its editors     routes/kb-manage.ts
 *   *    /kb/...        the public help center's data           routes/kb.ts
 *   *    /helpdesk/settings the assistant's settings (its managers) routes/helpdesk-settings.ts
 *   POST /helpdesk/conversations  hand-off to a person (signed in)  routes/support.ts
 *   *    /helpdesk/my/...  My support: my tickets, replies, rating   routes/support.ts
 *   *    /helpdesk/tickets/... the inbox: queues, tickets, replies   routes/inbox.ts
 *   *    /helpdesk/canned/...  agents' saved replies                 routes/canned.ts
 *   GET  /helpdesk/reports/... assistant analytics (report holders)    routes/helpdesk-reports.ts
 *   *    /helpdesk/health/...  Knowledge health issues (report holders)  routes/knowledge-health.ts
 *   *    /helpdesk/test-lab/... Test Lab: cases and runs (its managers)  routes/test-lab.ts
 *   *    /helpdesk/...  the chat assistant: ask, helpful, widget routes/helpdesk.ts
 *   *    /checkout/...  start and confirm a payment             routes/checkout.ts
 *   *    /memberships/... the member's memberships               routes/checkout.ts
 *
 * Add a feature as a new `routes/<name>.ts` and one `.route()` line below,
 * CHAINED so `AppType` carries every route to the typed client. Errors are
 * JSON `{error, message}`. `sameOrigin` + `csrf` refuse every cross-site or
 * token-less write; keep them, with `previewCookies` before them (a webhook
 * that must accept a cross-site write gets its own app, mounted before them,
 * with its own authentication).
 */
export const app = new Hono()
  .basePath('/site-api')
  // The editor Preview only: auth cookies carried in headers (its gateway drops cookies).
  .use(previewCookies)
  .use(sameOrigin)
  // The Buy button posts here as a plain form too (no JavaScript): BEFORE `csrf`, with its own
  // `formCsrf` (the token, or a same-origin form post). Keep it here (docs/agent/payments.md).
  .route('/checkout', checkoutRoutes)
  .use(csrf)
  // No route here takes a big body; uploads never pass through the Worker.
  .use(bodyLimit({maxSize: 64 * 1024, onError: c => c.json(problem('too_large', 'That request is too large.'), 413)}))
  // New catalogue codenames reach the `permissions` table (once per isolate; no migration).
  .use(syncPermissions(CATALOGUE))

  .get('/health', c =>
    c.json({
      ok: true,
      preview: isPreview(),
      database: Boolean(config.databaseUrl),
      auth: Boolean(config.jwtSecret && config.databaseUrl),
      siteKey: Boolean(config.siteKey),
    })
  )

  // `abilities` only decides what the UI SHOWS; every guarded route checks again.
  .get('/me', async c => {
    const [viewer, access] = await Promise.all([getViewer(c.req.raw), getAccess(c.req.raw)]);
    c.header('Cache-Control', 'private, no-store');
    // One flag per catalogue entry with an `ability` (src/server/permissions.ts).
    const abilities = abilitiesFor(new Set(access.permissions));
    return c.json({viewer, roles: access.roles, abilities});
  })

  .route('/auth', authRoutes(authSettings))
  .route('/admin', adminRoutes)
  .route('/site', siteRoutes)
  // `/kb/files` and `/kb/manage` BEFORE `/kb`, so no editor path is read as a public one.
  .route('/kb/files', kbFileRoutes)
  .route('/kb/manage', kbManageRoutes)
  .route('/kb', kbRoutes)
  // Every `/helpdesk/<name>` BEFORE `/helpdesk`, so none of their paths is read as a public one.
  .route('/helpdesk/settings', helpdeskSettingsRoutes)
  .route('/helpdesk/conversations', conversationRoutes)
  .route('/helpdesk/my', myTicketRoutes)
  .route('/helpdesk/tickets', inboxRoutes)
  .route('/helpdesk/canned', cannedRoutes)
  .route('/helpdesk/reports', helpdeskReportRoutes)
  .route('/helpdesk/health', knowledgeHealthRoutes)
  .route('/helpdesk/test-lab', testLabRoutes)
  .route('/helpdesk', helpdeskRoutes)
  .route('/memberships', membershipRoutes)

  .notFound(c => c.json(problem('not_found', 'No such Site API route.'), 404))
  .onError((err, c) => {
    // A request Hono itself could not read (malformed JSON in a validator): its own 4xx status.
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      c.header('Cache-Control', 'no-store');
      return c.json(problem('bad_request', 'That request could not be read.'), err.status);
    }
    // The message only: an error object can carry request details.
    console.error(`site-api ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json(problem('internal_error', 'Something went wrong.'), 500);
  });

export type AppType = typeof app;
