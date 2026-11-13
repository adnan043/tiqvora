/**
 * The owner's time zone (helpdesk_settings.time_zone) and the weekly Knowledge health slot:
 * Mondays at 07:30 local. Worked out with Intl only (no date library). Browser-safe.
 */

/** The shape the database CHECK allows (helpdesk_settings_time_zone_check). */
export const TIME_ZONE_RE = /^[A-Za-z0-9_+/-]{1,64}$/;

/** The weekly check's local time. */
export const WEEKLY_CHECK_TIME = {hour: 7, minute: 30} as const;

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * Old names (IANA "backward" links) and the zone they point to today. Engines disagree on these:
 * ICU (Node, Chrome) still reports some old spellings as canonical ('Asia/Kolkata' resolves to
 * 'Asia/Calcutta'), others report the new one. Mapping them here gives one stored name whatever
 * the engine. POSIX-style US zones ('EST5EDT') are mapped to the city zone IANA now links them
 * to, so they are accepted, stored and listed the same way as every other alias.
 */
const ALIASES: Record<string, string> = {
  // ICU's legacy canonical names (the ones Intl.supportedValuesOf lists).
  'africa/asmera': 'Africa/Asmara',
  'america/buenos_aires': 'America/Argentina/Buenos_Aires',
  'america/catamarca': 'America/Argentina/Catamarca',
  'america/coral_harbour': 'America/Atikokan',
  'america/cordoba': 'America/Argentina/Cordoba',
  'america/godthab': 'America/Nuuk',
  'america/indianapolis': 'America/Indiana/Indianapolis',
  'america/jujuy': 'America/Argentina/Jujuy',
  'america/louisville': 'America/Kentucky/Louisville',
  'america/mendoza': 'America/Argentina/Mendoza',
  'asia/calcutta': 'Asia/Kolkata',
  'asia/katmandu': 'Asia/Kathmandu',
  'asia/rangoon': 'Asia/Yangon',
  'asia/saigon': 'Asia/Ho_Chi_Minh',
  'atlantic/faeroe': 'Atlantic/Faroe',
  'europe/kiev': 'Europe/Kyiv',
  'pacific/enderbury': 'Pacific/Kanton',
  'pacific/ponape': 'Pacific/Pohnpei',
  'pacific/truk': 'Pacific/Chuuk',
  // Other common old names.
  'asia/dacca': 'Asia/Dhaka',
  'asia/thimbu': 'Asia/Thimphu',
  'asia/ulan_bator': 'Asia/Ulaanbaatar',
  'asia/macao': 'Asia/Macau',
  'asia/ashkhabad': 'Asia/Ashgabat',
  'asia/chongqing': 'Asia/Shanghai',
  'asia/chungking': 'Asia/Shanghai',
  'asia/ujung_pandang': 'Asia/Makassar',
  'asia/tel_aviv': 'Asia/Jerusalem',
  'europe/uzhgorod': 'Europe/Kyiv',
  'europe/zaporozhye': 'Europe/Kyiv',
  // US/* links.
  'us/alaska': 'America/Anchorage',
  'us/aleutian': 'America/Adak',
  'us/arizona': 'America/Phoenix',
  'us/central': 'America/Chicago',
  'us/east-indiana': 'America/Indiana/Indianapolis',
  'us/eastern': 'America/New_York',
  'us/hawaii': 'Pacific/Honolulu',
  'us/indiana-starke': 'America/Indiana/Knox',
  'us/michigan': 'America/Detroit',
  'us/mountain': 'America/Denver',
  'us/pacific': 'America/Los_Angeles',
  'us/samoa': 'Pacific/Pago_Pago',
  // POSIX-style zones (links since tzdata 2024b).
  est5edt: 'America/New_York',
  cst6cdt: 'America/Chicago',
  mst7mdt: 'America/Denver',
  pst8pdt: 'America/Los_Angeles',
  est: 'America/Panama',
  mst: 'America/Phoenix',
  hst: 'Pacific/Honolulu',
  // UTC under other names.
  'etc/utc': 'UTC',
  'etc/uct': 'UTC',
  uct: 'UTC',
  'etc/universal': 'UTC',
  universal: 'UTC',
  'etc/zulu': 'UTC',
  zulu: 'UTC',
  'etc/gmt': 'UTC',
  gmt: 'UTC',
  'etc/gmt0': 'UTC',
  'etc/gmt+0': 'UTC',
  'etc/gmt-0': 'UTC',
  gmt0: 'UTC',
  'gmt+0': 'UTC',
  'gmt-0': 'UTC',
  'etc/greenwich': 'UTC',
  greenwich: 'UTC',
};

/** The engine's name for `tz`, or null when it doesn't know the zone. */
function resolve(tz: string): string | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', {timeZone: tz}).resolvedOptions().timeZone;
    return typeof name === 'string' && TIME_ZONE_RE.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Canonical IANA name (`'utc'` → `'UTC'`, `'Asia/Calcutta'` → `'Asia/Kolkata'`, `'EST5EDT'` →
 * `'America/New_York'`), or null for anything Intl doesn't know. The same name on every engine
 * for the aliases in ALIASES; a modern name the engine doesn't know yet falls back to its own.
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !TIME_ZONE_RE.test(tz)) return null;
  const alias = ALIASES[tz.toLowerCase()];
  const resolved = (alias && resolve(alias) ? alias : null) ?? resolve(tz);
  if (!resolved) return null;
  const modern = ALIASES[resolved.toLowerCase()];
  return modern && resolve(modern) ? modern : resolved;
}

let options: string[] | null = null;

/** For the Select: 'UTC' first, then every zone the engine knows, as canonical names (no old aliases), deduped and sorted. */
export function timeZoneOptions(): string[] {
  if (options) return options;
  const intl = Intl as typeof Intl & {supportedValuesOf?: (key: 'timeZone') => string[]};
  let list: string[] = FALLBACK_ZONES;
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      list = intl.supportedValuesOf('timeZone');
    } catch {
      list = FALLBACK_ZONES;
    }
  }
  // Every name through canonicalTimeZone: old spellings ('Africa/Asmera') become the current one
  // and are listed once.
  const seen = new Set<string>();
  for (const zone of list) {
    const name = canonicalTimeZone(zone);
    if (name && name !== 'UTC') seen.add(name);
  }
  options = ['UTC', ...[...seen].sort()];
  return options;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local wall-clock parts of `at` in `tz`. Throws RangeError for an unknown zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const out: LocalParts = {year: 0, month: 0, day: 0, hour: 0, minute: 0, weekday: 0};
  for (const part of formatter(tz).formatToParts(at)) {
    switch (part.type) {
      case 'year':
        out.year = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'day':
        out.day = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24;
        break;
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'weekday':
        out.weekday = WEEKDAYS[part.value] ?? 0;
        break;
    }
  }
  return out;
}

/** The zone's offset from UTC at instant `t` (ms), to the minute. */
function offsetAt(t: number, tz: string): number {
  const p = localParts(new Date(t), tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - (t - (((t % 60_000) + 60_000) % 60_000));
}

/**
 * The instant of local `y-m-d hh:mm` in `tz`: two fixed-point passes over the offset.
 * DST-safe away from the transition hour (07:30 never falls in one).
 */
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetAt(guess, tz);
  return new Date(guess - offsetAt(first, tz));
}

export interface WeeklyCheckSlot {
  /** The owner-local Monday, 'YYYY-MM-DD'. */
  week: string;
  /** Monday 07:30 local, as an instant. */
  dueAt: Date;
  /** now ≥ dueAt. */
  due: boolean;
  /** The previous Monday 07:30 local (7 local days, so 167 or 169 h across a DST change). */
  windowStart: Date;
  /** = dueAt. */
  windowEnd: Date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The owner-local week (Monday–Sunday) that `now` is in, and its Monday 07:30 slot. */
export function weeklyCheckSlot(now: Date, tz: string): WeeklyCheckSlot {
  const p = localParts(now, tz);
  const sinceMonday = (p.weekday + 6) % 7;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - sinceMonday));
  const prev = new Date(Date.UTC(p.year, p.month - 1, p.day - sinceMonday - 7));
  const {hour, minute} = WEEKLY_CHECK_TIME;
  const dueAt = zonedInstant(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), hour, minute, tz);
  const windowStart = zonedInstant(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), hour, minute, tz);
  return {
    week: `${pad(monday.getUTCFullYear(), 4)}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`,
    dueAt,
    due: now.getTime() >= dueAt.getTime(),
    windowStart,
    windowEnd: dueAt,
  };
}
