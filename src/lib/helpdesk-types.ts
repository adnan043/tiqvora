/**
 * The assistant's JSON shapes, shared by the Site API (src/server/routes/helpdesk*.ts),
 * the chat widget (src/lib/helpdesk-widget.ts) and the dashboard. Browser-safe.
 */
import type {Confidence} from './helpdesk-tones';

export type {Confidence};

export const ASK_LIMITS = {
  /** The question: 2–500 characters after trimming. */
  questionMin: 2,
  questionMax: 500,
  /** Earlier messages sent with a question: at most 10, 4,000 characters in all. */
  historyCount: 10,
  historyChars: 4000,
  pagePath: 300,
  /** Settings. */
  assistantName: 60,
  greeting: 300,
  launcherLabel: 30,
  businessHours: 200,
  quickReplies: 6,
  quickReplyLabel: 60,
  humanTopics: 30,
  humanTopic: 60,
  helpTitle: 120,
  helpIntro: 300,
  /** The monthly cap, in cents (0 = the assistant is off). */
  monthlyCapCentsMax: 1_000_000,
} as const;

export type AskRole = 'customer' | 'assistant';

/** POST /site-api/helpdesk/ask */
export interface AskInput {
  question: string;
  history?: {role: AskRole; text: string}[];
  /** The page path the widget is on (`/help/articles/x/`), never a query string. */
  page?: string;
}

/**
 * - `answered`: the assistant answered from the sources.
 * - `no_source`: nothing in the help center matched; no AI call was made.
 * - `handoff`: low confidence, a human-only topic, or the customer asked for a person.
 * - `off`: no AI key, the monthly cap is reached, or the site is busy: search results only.
 */
export type AskStatus = 'answered' | 'no_source' | 'handoff' | 'off';

export interface AskCitation {
  title: string;
  /** `/help/articles/<slug>/` */
  url: string;
}

/** `<log id>.<signature>`: the vote handle for one answer (unguessable; only its asker has it). */
export const LOG_ID_RE = /^\d{1,18}\.[A-Za-z0-9_-]{16}$/;

export interface AskResult {
  /** Use it for POST /helpdesk/ask/:logId/helpful. Matches LOG_ID_RE. */
  logId: string;
  status: AskStatus;
  /** Plain text (never HTML). Empty when there is nothing to say beyond the links. */
  answer: string;
  citations: AskCitation[];
  confidence: Confidence;
  /** Show "Talk to a person" first. */
  offerHuman: boolean;
  /** Up to 3 short follow-up questions for chips. */
  followUps: string[];
}

/** GET /site-api/helpdesk/widget: what the chat panel needs. Public, cached. */
export interface WidgetConfig {
  /** An AI key is set and the cap is above 0. The panel still works without it (search + person). */
  assistant: boolean;
  name: string;
  greeting: string;
  launcherLabel: string;
  quickReplies: string[];
  businessHours: string;
}

/** GET /site-api/helpdesk/settings (site:helpdesk:settings). */
export interface HelpdeskSettingsAdmin {
  assistantName: string;
  greeting: string;
  tone: 'friendly' | 'neutral' | 'formal';
  confidenceThreshold: 'low' | 'medium' | 'high';
  provider: 'anthropic';
  model: string;
  monthlyCapCents: number;
  launcherLabel: string;
  businessHours: string;
  helpTitle: string;
  helpIntro: string;
  quickReplies: string[];
  humanTopics: string[];
  /** Whether each provider's owner secret is set: booleans only, never the key. */
  keys: {anthropic: boolean};
  /** The secret name to add when it is missing (`ANTHROPIC_API_KEY`). */
  secretName: string;
  usage: {month: string; spentCents: number; requests: number};
}

/** PATCH /site-api/helpdesk/settings: every field optional. */
export type HelpdeskSettingsInput = Partial<
  Omit<HelpdeskSettingsAdmin, 'keys' | 'secretName' | 'usage'>
>;
