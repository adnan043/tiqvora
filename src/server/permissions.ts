import {abilitiesOf, type AbilitiesOf, codenamesOf, CORE_PERMISSIONS, definePermissions} from '../platform/auth/codenames';

/**
 * THE permission catalogue: every codename this site checks, declared ONCE.
 * Adding a permission is one entry here, plus its line in tests/permissions.test.ts
 * (docs/agent/roles-and-permissions.md):
 *
 *   - `PERMISSIONS.<KEY>` is its codename, for `requirePermission` / `can`;
 *   - `ability` adds a flag to `/me` `abilities` (and to the `Abilities` type)
 *     for the UI: portal nav items, buttons, `pageContext()` pages;
 *   - the row reaches the `permissions` table (the roles screen) on the next
 *     signed-in request after deploy, and `roles` get it that first time only
 *     (`src/platform/permission-sync.ts`). No migration.
 *   - tests/permissions.test.ts lists every shipped codename and ability, so
 *     `npm test` fails until you add the new one there too (on purpose: a
 *     renamed or lost permission never slips through).
 *
 * Never rename or reuse a shipped codename: roles hold it by name. Browser-safe
 * (no server imports): the portal reads the `Abilities` type from here.
 */
export const CATALOGUE = definePermissions({
  ...CORE_PERMISSIONS,
  // The help desk. `agent` is the "Support agent" role (migration
  // 20261112110356_helpdesk_knowledge_base). The job board's `site:job:manage`
  // is retired: the job board was removed, and nothing checks it any more.
  /** The inbox: tickets, replies, assignment and status (`/dashboard/inbox`). */
  HELPDESK_INBOX: {
    codename: 'site:helpdesk:inbox',
    title: 'Work the help desk inbox',
    description: 'See and answer tickets, assign them and change their status.',
    group: 'Help desk',
    ability: 'useInbox',
    roles: ['admin', 'agent'],
  },
  /** Categories, articles, snippets, imports, approving AI drafts (`/dashboard/articles`…). */
  KB_EDIT: {
    codename: 'site:kb:edit',
    title: 'Edit the knowledge base',
    description: 'Write, publish and archive help articles, categories and snippets, and import them.',
    group: 'Help desk',
    ability: 'editKnowledge',
    roles: ['admin', 'agent'],
  },
  /** Assistant settings, branding, human-only topics, Test Lab. */
  HELPDESK_SETTINGS: {
    codename: 'site:helpdesk:settings',
    title: 'Manage the help desk',
    description: 'Change the assistant, the help center words, human-only topics and the Test Lab.',
    group: 'Help desk',
    ability: 'manageHelpdesk',
    roles: ['admin'],
  },
  /** Analytics and Knowledge Health. */
  HELPDESK_REPORTS: {
    codename: 'site:helpdesk:reports',
    title: 'See help desk reports',
    description: 'Open the help desk analytics and Knowledge Health.',
    group: 'Help desk',
    ability: 'seeHelpdeskReports',
    roles: ['admin'],
  },
});

/** Codenames by key: `PERMISSIONS.KB_EDIT` is `'site:kb:edit'`. */
export const PERMISSIONS = codenamesOf(CATALOGUE);

export type Codename = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** What the UI may SHOW the visitor (`/me`); every route checks again. */
export type Abilities = AbilitiesOf<typeof CATALOGUE>;

/** The abilities a set of granted codenames gives (`/me`). */
export const abilitiesFor = (permissions: ReadonlySet<string>): Abilities => abilitiesOf(CATALOGUE, permissions);

/** A guest's abilities: every flag false. */
export const NO_ABILITIES: Abilities = abilitiesFor(new Set());
