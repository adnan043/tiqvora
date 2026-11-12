import type {PrismaClient} from '../../generated/prisma/client';
import {cache} from '../../platform/cache';
import {HELPDESK_SETTINGS_KEY} from './keys';

/**
 * The help desk's settings row (`helpdesk_settings`, id = 1), as every visitor sees it.
 *
 * Cached 7 days under `HELPDESK_SETTINGS_KEY`: read on every help-center and chat request, the
 * same for everyone, and changed only by the settings screen, which must call
 * `cache.del(HELPDESK_SETTINGS_KEY)` and `cache.delPrefix(KB_CACHE_PREFIX)` after it saves.
 * The monthly spending cap is NOT here (a money decision never comes from the cache): read it
 * from the database where it's enforced. Edit screens read the database too.
 */
export interface HelpdeskSettingsView {
  assistantName: string;
  greeting: string;
  /** `friendly`, `neutral` or `formal`. */
  tone: string;
  /** `low`, `medium` or `high`. */
  confidenceThreshold: string;
  /** `anthropic` or `openai`. */
  provider: string;
  model: string;
  launcherLabel: string;
  businessHours: string;
  helpTitle: string;
  helpIntro: string;
}

/** The schema's defaults (prisma/schema.prisma), used when the row is missing. */
export const HELPDESK_DEFAULTS: Readonly<HelpdeskSettingsView> = {
  assistantName: 'Assistant',
  greeting: 'Hi! Ask me anything about our products and orders.',
  tone: 'friendly',
  confidenceThreshold: 'medium',
  provider: 'anthropic',
  model: '',
  launcherLabel: 'Support',
  businessHours: '',
  helpTitle: 'How can we help?',
  helpIntro: 'Search our guides, or ask the assistant.',
};

const select = {
  assistantName: true,
  greeting: true,
  tone: true,
  confidenceThreshold: true,
  provider: true,
  model: true,
  launcherLabel: true,
  businessHours: true,
  helpTitle: true,
  helpIntro: true,
} as const;

const WEEK = 7 * 24 * 3600;

export async function getHelpdeskSettings(db: PrismaClient): Promise<HelpdeskSettingsView> {
  const row = await cache.getOrSet(HELPDESK_SETTINGS_KEY, WEEK, () =>
    db.helpdeskSettings.findUnique({where: {id: 1}, select})
  );
  return row ? {...HELPDESK_DEFAULTS, ...row} : {...HELPDESK_DEFAULTS};
}
