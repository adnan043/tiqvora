import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {AI_MODELS, AI_SECRET_NAMES, aiModelOf} from '../../lib/ai-models';
import {ASK_LIMITS, type HelpdeskSettingsAdmin, type HelpdeskSettingsInput} from '../../lib/helpdesk-types';
import {canonicalTimeZone} from '../../lib/time-zone';
import {audit} from '../../platform/auth';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {monthUsage} from '../ai/usage';
import {HELPDESK_SETTINGS_KEY, KB_CACHE_PREFIX} from '../kb/keys';
import {HELPDESK_DEFAULTS} from '../kb/settings';
import {PERMISSIONS} from '../permissions';

/**
 * The assistant's settings, for holders of `site:helpdesk:settings` (the Assistant screen).
 * Mounted at `/site-api/helpdesk/settings` (src/server/app.ts), BEFORE the public `/helpdesk`.
 *
 *   GET   /   HelpdeskSettingsAdmin: the row, quick replies, human-only topics, whether the
 *             AI key is set (a boolean, NEVER the key) and this month's spend.
 *   PATCH /   HelpdeskSettingsInput (every field optional; `timeZone` is checked with Intl and
 *             stored canonical, for the weekly Knowledge health check): one transaction (the row, and the
 *             quick replies / topics replaced when sent), then the caches the public side reads
 *             (`HELPDESK_SETTINGS_KEY`, `helpdesk:widget`, the `kb:` group: /help/ shows the
 *             help title and intro) are cleared after commit, and the change is audited
 *             (`helpdesk_settings_updated`, the changed field names only).
 *
 * Edit screens read the database, never the cache. The key itself is an owner secret the owner
 * adds in the site's settings: this route never accepts, stores or returns it.
 */

/** The chat widget's cache entry (src/server/routes/helpdesk.ts GET /widget). */
const WIDGET_CACHE_KEY = 'helpdesk:widget';

const canManage = requirePermission(PERMISSIONS.HELPDESK_SETTINGS);

const TONES = ['friendly', 'neutral', 'formal'] as const;
const THRESHOLDS = ['low', 'medium', 'high'] as const;
const MODEL_IDS = new Set(AI_MODELS.map(model => model.id));

type Fields = Record<string, string>;
type Input = Required<HelpdeskSettingsInput>;

const objectOf = (value: unknown) =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const given = (v: Record<string, unknown>, key: string) => v[key] !== undefined && v[key] !== null;
/** One line of text: trimmed, inner whitespace (newlines included) collapsed to single spaces. */
const line = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null);

/** Checks a text field (`min` 0 allows it empty): sets `out[key]` or `fields[key]`. */
function text(
  v: Record<string, unknown>,
  out: Partial<Input>,
  fields: Fields,
  key: keyof Input & string,
  label: string,
  min: 0 | 1,
  max: number
) {
  if (!given(v, key)) return;
  const value = line(v[key]);
  if (value === null || value.length < min || value.length > max) {
    fields[key] = min ? `${label} needs 1 to ${max} characters.` : `${label} is at most ${max} characters.`;
  } else (out as Record<string, unknown>)[key] = value;
}

/**
 * A list of short lines: each trimmed, 1..`max` characters, at most `count`. Quick replies must
 * each be there once (422); topics are lower-cased and a repeat is simply dropped.
 */
function list(value: unknown, count: number, max: number, lower: boolean, noun: [string, string]): string[] | string {
  const [one, many] = noun;
  if (!Array.isArray(value) || value.length > count * 2) return `Add at most ${count} ${many}.`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let entry = line(item);
    if (!entry || entry.length > max) return `Each ${one} needs 1 to ${max} characters.`;
    if (lower) entry = entry.toLowerCase();
    const key = entry.toLowerCase();
    if (seen.has(key)) {
      if (lower) continue;
      return `"${entry}" is in the list twice. Keep it once.`;
    }
    seen.add(key);
    out.push(entry);
  }
  return out.length > count ? `Add at most ${count} ${many}.` : out;
}

/** Checks the PATCH body field by field; unknown keys are ignored. */
function readInput(raw: unknown): {out: Partial<Input>; fields: Fields} {
  const v = objectOf(raw);
  const out: Partial<Input> = {};
  const fields: Fields = {};
  text(v, out, fields, 'assistantName', "The assistant's name", 1, ASK_LIMITS.assistantName);
  text(v, out, fields, 'greeting', 'The greeting', 1, ASK_LIMITS.greeting);
  text(v, out, fields, 'launcherLabel', "The button's label", 1, ASK_LIMITS.launcherLabel);
  text(v, out, fields, 'businessHours', 'Business hours', 0, ASK_LIMITS.businessHours);
  text(v, out, fields, 'helpTitle', "The help center's title", 1, ASK_LIMITS.helpTitle);
  text(v, out, fields, 'helpIntro', "The help center's intro", 0, ASK_LIMITS.helpIntro);
  if (given(v, 'tone')) {
    if ((TONES as readonly unknown[]).includes(v.tone)) out.tone = v.tone as Input['tone'];
    else fields.tone = 'Pick friendly, neutral or formal.';
  }
  if (given(v, 'confidenceThreshold')) {
    if ((THRESHOLDS as readonly unknown[]).includes(v.confidenceThreshold)) {
      out.confidenceThreshold = v.confidenceThreshold as Input['confidenceThreshold'];
    } else fields.confidenceThreshold = 'Pick low, medium or high.';
  }
  if (given(v, 'provider')) {
    if (v.provider === 'anthropic') out.provider = 'anthropic';
    else fields.provider = 'Only Anthropic is available for now.';
  }
  if (given(v, 'model')) {
    if (typeof v.model === 'string' && MODEL_IDS.has(v.model)) out.model = v.model;
    else fields.model = 'Pick one of the models in the list.';
  }
  if (given(v, 'timeZone')) {
    // Stored in the canonical form Intl gives ('utc' → 'UTC'); the weekly check reads it.
    const zone = canonicalTimeZone(v.timeZone);
    if (zone) out.timeZone = zone;
    else fields.timeZone = 'Pick a time zone from the list.';
  }
  if (given(v, 'monthlyCapCents')) {
    const cap = v.monthlyCapCents;
    if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 && cap <= ASK_LIMITS.monthlyCapCentsMax) {
      out.monthlyCapCents = cap;
    } else {
      fields.monthlyCapCents = `Enter an amount from $0 to $${(ASK_LIMITS.monthlyCapCentsMax / 100).toLocaleString('en-US')}.`;
    }
  }
  if (given(v, 'quickReplies')) {
    const replies = list(v.quickReplies, ASK_LIMITS.quickReplies, ASK_LIMITS.quickReplyLabel, false, ['quick reply', 'quick replies']);
    if (typeof replies === 'string') fields.quickReplies = replies;
    else out.quickReplies = replies;
  }
  if (given(v, 'humanTopics')) {
    const topics = list(v.humanTopics, ASK_LIMITS.humanTopics, ASK_LIMITS.humanTopic, true, ['topic', 'topics']);
    if (typeof topics === 'string') fields.humanTopics = topics;
    else out.humanTopics = topics;
  }
  return {out, fields};
}

const settingsBody = validator('json', (value, c) => {
  const {out, fields} = readInput(value);
  return Object.keys(fields).length
    ? c.json({...problem('invalid_input', Object.values(fields)[0] ?? 'Check the form.'), fields}, 422)
    : out;
});

const rowSelect = {
  assistantName: true,
  greeting: true,
  tone: true,
  confidenceThreshold: true,
  provider: true,
  model: true,
  monthlyCapCents: true,
  launcherLabel: true,
  businessHours: true,
  helpTitle: true,
  helpIntro: true,
  timeZone: true,
} as const;

/** The schema's default cap (prisma/schema.prisma), used when the row is missing. */
const DEFAULT_CAP_CENTS = 2000;

type Row = {
  assistantName: string;
  greeting: string;
  tone: string;
  confidenceThreshold: string;
  provider: string;
  model: string;
  monthlyCapCents: number;
  launcherLabel: string;
  businessHours: string;
  helpTitle: string;
  helpIntro: string;
  timeZone: string;
};
type Current = {row: Row; quickReplies: string[]; humanTopics: string[]};

/** The settings as stored now: the row (or the defaults), quick replies, topics. One round trip. */
async function readCurrent(db: PrismaClient): Promise<Current> {
  const [row, replies, topics] = await Promise.all([
    db.helpdeskSettings.findUnique({where: {id: 1}, select: rowSelect}),
    db.helpdeskQuickReply.findMany({
      select: {label: true},
      orderBy: [{position: 'asc'}, {id: 'asc'}],
      take: ASK_LIMITS.quickReplies,
    }),
    db.helpdeskHumanTopic.findMany({select: {keyword: true}, orderBy: {id: 'asc'}, take: ASK_LIMITS.humanTopics}),
  ]);
  return {
    row: row ?? {...HELPDESK_DEFAULTS, monthlyCapCents: DEFAULT_CAP_CENTS, timeZone: 'UTC'},
    quickReplies: replies.map(reply => reply.label),
    humanTopics: topics.map(topic => topic.keyword),
  };
}

/** Field by field, never the row as is. `keys` says only WHETHER a key is set. */
function toAdmin(current: Current, usage: HelpdeskSettingsAdmin['usage']): HelpdeskSettingsAdmin {
  const {row} = current;
  return {
    assistantName: row.assistantName,
    greeting: row.greeting,
    tone: (TONES as readonly string[]).includes(row.tone) ? (row.tone as HelpdeskSettingsAdmin['tone']) : 'friendly',
    confidenceThreshold: (THRESHOLDS as readonly string[]).includes(row.confidenceThreshold)
      ? (row.confidenceThreshold as HelpdeskSettingsAdmin['confidenceThreshold'])
      : 'medium',
    provider: 'anthropic',
    model: aiModelOf(row.model).id,
    monthlyCapCents: row.monthlyCapCents,
    launcherLabel: row.launcherLabel,
    businessHours: row.businessHours,
    helpTitle: row.helpTitle,
    helpIntro: row.helpIntro,
    timeZone: row.timeZone,
    quickReplies: current.quickReplies,
    humanTopics: current.humanTopics,
    keys: {anthropic: Boolean(config.ownerSecret(AI_SECRET_NAMES.anthropic))},
    secretName: AI_SECRET_NAMES.anthropic,
    usage,
  };
}

const ROW_FIELDS = Object.keys(rowSelect) as (keyof Row)[];
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i]);

export const helpdeskSettingsRoutes = new Hono()
  .get('/', withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const [current, usage] = await Promise.all([readCurrent(db), monthUsage(db)]);
    c.header('Cache-Control', 'private, no-store');
    return c.json(toAdmin(current, usage));
  })

  .patch('/', settingsBody, withViewer, requireAuth, canManage, withDb, async c => {
    const db = c.var.db;
    const input = c.req.valid('json') as Partial<Input>;
    const me = c.var.viewer.id;
    c.header('Cache-Control', 'private, no-store');
    const current = await readCurrent(db);

    // Only what really changes is written and audited.
    const data: Partial<Row> = {};
    for (const key of ROW_FIELDS) {
      const next = input[key];
      if (next !== undefined && next !== current.row[key]) (data as Record<string, unknown>)[key] = next;
    }
    const replies = input.quickReplies && !sameList(input.quickReplies, current.quickReplies) ? input.quickReplies : null;
    const topics = input.humanTopics && !sameList(input.humanTopics, current.humanTopics) ? input.humanTopics : null;
    const changed = [...Object.keys(data), ...(replies ? ['quickReplies'] : []), ...(topics ? ['humanTopics'] : [])];
    if (!changed.length) return c.json(toAdmin(current, await monthUsage(db)));

    try {
      await db.$transaction(async tx => {
        // Row 1 exists from the migration; the upsert also covers a database emptied by hand.
        await tx.helpdeskSettings.upsert({
          where: {id: 1},
          create: {id: 1, ...data, updatedBy: me},
          update: {...data, updatedBy: me},
          select: {id: true},
        });
        if (replies) {
          await tx.helpdeskQuickReply.deleteMany({});
          if (replies.length) {
            await tx.helpdeskQuickReply.createMany({data: replies.map((label, position) => ({label, position}))});
          }
        }
        if (topics) {
          await tx.helpdeskHumanTopic.deleteMany({});
          if (topics.length) await tx.helpdeskHumanTopic.createMany({data: topics.map(keyword => ({keyword}))});
        }
      });
    } catch (error) {
      // Two saves at the same moment: the other one's topics landed first (unique keyword).
      if ((error as {code?: unknown} | null)?.code === 'P2002') {
        return c.json(problem('changed', 'These settings were changed meanwhile. Reload the page and try again.'), 409);
      }
      throw error;
    }

    // After commit: what visitors see (the widget, /help/, the assistant's words) is fresh at once.
    const [usage] = await Promise.all([
      monthUsage(db),
      cache.del(HELPDESK_SETTINGS_KEY).catch(() => false),
      cache.del(WIDGET_CACHE_KEY).catch(() => false),
      cache.delPrefix(KB_CACHE_PREFIX).catch(() => false),
      audit(db, {actorUserId: me, action: 'helpdesk_settings_updated', meta: {fields: changed}}),
    ]);
    return c.json(
      toAdmin(
        {row: {...current.row, ...data}, quickReplies: replies ?? current.quickReplies, humanTopics: topics ?? current.humanTopics},
        usage
      )
    );
  });
