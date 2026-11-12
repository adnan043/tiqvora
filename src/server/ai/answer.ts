import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {aiModelOf, costMicros, costMicrosFor} from '../../lib/ai-models';
import type {AskCitation, AskResult, AskRole, Confidence} from '../../lib/helpdesk-types';
import {monthKey, recordAiCost, reserveAiCall} from './usage';
import {takeRateWindow} from '../rate-window';
import {callAnthropic} from './provider';
import {buildPrompt, parseAnswer, type Source} from './prompt';
import type {Retrieved} from './retrieve';

/**
 * One customer question → one answer, from the help center only (Phase 2 contract, steps 1–6):
 *   1. They ask for a person, or it's a human-only topic → `handoff` (no AI call).
 *   2. Nothing in the help center matches → `no_source` (no AI call).
 *   3. No key, cap 0, the per-minute AI limits, or the monthly cap → `off` (links only).
 *   4. The model answers from the numbered sources; any failure → `handoff` (fail closed).
 *   5. Below the owner's confidence threshold, or the model says a person is needed → `handoff`.
 *   6. Otherwise `answered`, citing articles only (a snippet has no page).
 *
 * The provider sees ONLY the fixed system prompt, the retrieved help-center text and this
 * customer's own words (question + this conversation): never a user id, an IP or a cookie
 * (nothing here has them), and emails, phone numbers and card numbers the customer typed are
 * masked first (`maskPersonalData`), for the prompt AND the log. The caller writes the ONE
 * `question_logs` row with `writeQuestionLog`, which also settles the money held by
 * `reserveAiCall`, in the month the hold was taken.
 */

/** Per minute: one client's AI calls, and the whole site's (a ceiling on spend speed). */
const AI_PER_CLIENT = 10;
const AI_SITE_WIDE = 30;
/** 1 cent = 10,000 micro-dollars. */
const MICROS_PER_CENT = 10_000;
/** The worst case for one call, held against the cap while it runs (usage.ts). */
const HOLD_INPUT_TOKENS = 8000;
/** = the provider's MAX_TOKENS (provider.ts): the reply can't be longer. */
const HOLD_OUTPUT_TOKENS = 3000;
/** Article links shown with a hand-off or when the assistant is off. */
const MAX_LINKS = 3;

const RANK: Record<string, number> = {low: 0, medium: 1, high: 2};

export interface AnswerSettings {
  assistantName: string;
  tone: string;
  /** `low`, `medium` or `high`: hand off below it. */
  confidenceThreshold: string;
  /** From the allow-list (`aiModelOf` falls back to the default). */
  model: string;
}

export interface AnswerInput {
  db: PrismaClient;
  /** The owner's ANTHROPIC_API_KEY, or null. */
  key: string | null;
  settings: AnswerSettings;
  /** The monthly cap, read from the DATABASE by the caller (money: never the cache). */
  capCents: number;
  /** Lower-case keywords that always go to a person. */
  humanTopics: string[];
  question: string;
  /** `retrieve(db, question)`, run by the caller in parallel with its other reads. */
  retrieved: Retrieved;
  history: {role: AskRole; text: string}[];
  /** For the log only: a BCP 47 tag or ''. */
  language: string;
  /** For the log only: a path, no query string. */
  page: string;
  /** `clientRateKey(c)`: the per-client AI limit; null → only the site-wide one. */
  clientKey: string | null;
}

/** What `writeQuestionLog` stores (no user id, no IP: the table has neither). */
export interface QuestionLogEntry {
  question: string;
  language: string;
  pagePath: string;
  topArticleId: number | null;
  confidence: Confidence;
  outcome: 'answered' | 'no_source' | 'handed_off' | 'ai_off';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** Held against the cap by `reserveAiCall`; settled when the row is written. 0 = nothing held. */
  heldMicros: number;
  /** `monthKey()` taken once for this question: the month the hold was taken in and is settled in. */
  month: string;
}

export type AnswerOutcome = Omit<AskResult, 'logId'> & {log: QuestionLogEntry};

/* ------------------------------ asking for a person ------------------------------ */

/** Lower-case, accents dropped ("señor" → "senor", "à" → "a"), so one pattern fits every spelling. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

const WHO_EN = '(?:a |an |the |some |your |one of your )?(?:someone|somebody|person|people|human|humans|agent|agents|rep|representative|operator|staff|team|employee)';
/**
 * The customer asks for a person, in English, Spanish, French, German or Portuguese (accents
 * folded). Bare "person" is NOT one ("can I pick it up in person?"); "a person", "real person",
 * "talk to someone" are.
 */
const ASKS_FOR_PERSON: RegExp[] = [
  // English
  /\b(?:human|humans|representative|operator)\b/,
  /\b(?:agent|agents)\b/,
  /\b(?:real|live|actual)\s+(?:person|people|human|agent|support)\b/,
  /\b(?:a|another)\s+person\b/,
  new RegExp(`\\b(?:talk|speak|chat|connect|transfer|put)\\s+(?:me\\s+)?(?:to|with|through to)\\s+${WHO_EN}\\b`),
  /\bcustomer\s+(?:service|support)\s+(?:agent|rep|representative|person)\b/,
  // Spanish
  /\b(?:hablar|comunicarme|contactar)\s+con\s+(?:una?\s+)?(?:persona|alguien|agente|humano|asesor|representante)\b/,
  /\b(?:persona\s+real|un\s+humano|un\s+agente|representante)\b/,
  // French
  /\bparler\s+(?:a|avec)\s+(?:une?\s+|quelqu'?un|quelqu un)\s*(?:personne|agent|conseiller|conseillere|humain)?\b/,
  /\b(?:vraie\s+personne|personne\s+reelle|un\s+humain|un\s+conseiller|une\s+conseillere)\b/,
  // German
  /\b(?:mit\s+(?:einem|einer|jemandem)\s*(?:menschen|mitarbeiter|mitarbeiterin|person|berater)?\s*sprechen)\b/,
  /\b(?:echte[nr]?\s+(?:person|menschen|mensch)|kundenberater|mitarbeiter)\b/,
  // Portuguese
  /\bfalar\s+com\s+(?:uma?\s+|alguem\b|o\s+)?(?:pessoa|atendente|humano|agente|alguem)\b/,
  /\b(?:pessoa\s+real|atendente|um\s+humano)\b/,
];

export function asksForPerson(question: string): boolean {
  const text = fold(question);
  return ASKS_FOR_PERSON.some(re => re.test(text));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A human-only topic keyword starts a word (lower-case; accents folded on both sides), and only
 * letters may follow it: "refund" matches "refunds" and "refunded", not "prerefund" or
 * "refund2". The keywords are the owner's, so a short one ("allerg") is theirs to choose.
 */
export function matchesHumanTopic(question: string, topics: readonly string[]): boolean {
  const text = fold(question);
  return topics.some(topic => {
    const keyword = fold(topic).trim();
    if (!keyword) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}\\p{L}*(?![\\p{L}\\p{N}])`, 'u').test(text);
  });
}

/* --------------------------------- personal data --------------------------------- */

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/** 13–19 digits, single spaces or dashes allowed between them (a card number as typed). */
const CARD_RE = /(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}])/gu;
/** A run of digits with separators; it is a phone number when it holds 7+ digits. */
const PHONE_RE = /(?<![\p{L}\p{N}+])\+?\(?\d[\d ().-]{4,}\d(?![\p{L}\p{N}])/gu;
/** Dates are not phone numbers: 2026-11-12, 12/11/2026, 12.11.2026. */
const DATE_RE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;

/**
 * Masks what the customer may have typed about themselves: emails → "[email]", card-like digit
 * runs (13–19 digits) → "[card]", phone numbers (7+ digits, separators allowed) → "[phone]".
 * Run on the question and the history BEFORE the prompt and the log: neither the provider nor
 * the question log ever holds them. Shorter numbers (order numbers up to 6 digits, prices,
 * dates) are kept.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(CARD_RE, '[card]')
    .replace(PHONE_RE, match => {
      const digits = match.replace(/\D/g, '').length;
      if (digits < 7 || DATE_RE.test(match.trim())) return match;
      return '[phone]';
    });
}

/* ----------------------------------- citations ----------------------------------- */

/** Article sources as links: snippets dropped (no page), deduped by URL, best first. */
function articleLinks(sources: readonly Source[], max = MAX_LINKS): AskCitation[] {
  const seen = new Set<string>();
  const out: AskCitation[] = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push({title: source.title, url: source.url});
    if (out.length >= max) break;
  }
  return out;
}

/** The model's `citations` numbers → article links; nothing usable → the top article. */
function citedLinks(sources: readonly Source[], numbers: readonly number[]): AskCitation[] {
  const cited = articleLinks(
    numbers.map(n => sources[n - 1]).filter((s): s is Source => Boolean(s)),
    MAX_LINKS
  );
  return cited.length ? cited : articleLinks(sources, 1);
}

/* ------------------------------------ the AI ------------------------------------ */

/**
 * Both per-minute AI windows in ONE statement (one round trip): the client's (`a:<hash>`), then
 * the site's (`ai-ask`) only if the client's had room, exactly as `takeRateWindows` would in two.
 * The same conditional upsert as src/server/rate-window.ts; a write (never re-sent).
 */
async function takeAiWindows(db: PrismaClient, clientKey: string | null): Promise<boolean> {
  if (!clientKey) return takeRateWindow(db, 'ai-ask', AI_SITE_WIDE);
  const client = `a:${clientKey}`.slice(0, 40);
  const rows = await db.$queryRaw<{client: boolean; site: boolean}[]>`
    WITH a AS (
      INSERT INTO "rate_windows" ("bucket", "minute", "count")
      VALUES (${client}, date_trunc('minute', now()), 1)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
      WHERE "rate_windows"."count" < ${AI_PER_CLIENT}
      RETURNING 1
    ), s AS (
      INSERT INTO "rate_windows" ("bucket", "minute", "count")
      SELECT 'ai-ask', date_trunc('minute', now()), 1 WHERE EXISTS (SELECT 1 FROM a)
      ON CONFLICT ("bucket", "minute") DO UPDATE SET "count" = "rate_windows"."count" + 1
      WHERE "rate_windows"."count" < ${AI_SITE_WIDE}
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM a) AS "client", EXISTS (SELECT 1 FROM s) AS "site"`;
  return Boolean(rows[0]?.client && rows[0]?.site);
}

// Fixed texts, English for now (the model's answers follow the customer's language; these don't yet).
const PERSON_ANSWER = 'Of course. A person from our team can help you with this.';
const TOPIC_ANSWER = 'Our team handles this personally. A person can help you with it.';
const NO_SOURCE_ANSWER = "I couldn't find this in our help center.";
const UNSURE_ANSWER = "I'm not sure about this one. A person from our team can help.";

export async function answerQuestion(input: AnswerInput): Promise<AnswerOutcome> {
  const {db, settings} = input;
  const model = aiModelOf(settings.model);
  // Once per question: the hold and its settle land on the same month row (usage.ts).
  const month = monthKey();
  // Masked once: what the prompt and the log see.
  const question = maskPersonalData(input.question);
  const history = input.history.map(item => ({role: item.role, text: maskPersonalData(item.text)}));

  const baseLog = {
    question,
    language: input.language,
    pagePath: input.page,
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    heldMicros: 0,
    month,
  };
  const done = (
    result: Omit<AskResult, 'logId'>,
    log: Partial<QuestionLogEntry> & Pick<QuestionLogEntry, 'outcome' | 'topArticleId'>
  ): AnswerOutcome => ({
    ...result,
    log: {...baseLog, confidence: result.confidence, ...log},
  });

  const {sources, topArticleId} = input.retrieved;

  // 1. A person, asked for or required by the topic, now or earlier in this conversation (the
  // customer's own messages only): no AI call. A person asked for → no article pushed at them.
  const customerTexts = [input.question, ...input.history.filter(item => item.role === 'customer').map(item => item.text)];
  const wantsPerson = customerTexts.some(asksForPerson);
  if (wantsPerson || customerTexts.some(text => matchesHumanTopic(text, input.humanTopics))) {
    return done(
      {
        status: 'handoff',
        answer: wantsPerson ? PERSON_ANSWER : TOPIC_ANSWER,
        citations: wantsPerson ? [] : articleLinks(sources, 1),
        confidence: 'none',
        offerHuman: true,
        followUps: [],
      },
      {outcome: 'handed_off', topArticleId: wantsPerson ? null : topArticleId}
    );
  }

  // 2. Nothing to answer from: no AI call.
  if (!sources.length) {
    return done(
      {status: 'no_source', answer: NO_SOURCE_ANSWER, citations: [], confidence: 'none', offerHuman: true, followUps: []},
      {outcome: 'no_source', topArticleId: null}
    );
  }

  // 3. The assistant is off, busy or out of budget: the help center's links only.
  const off = () =>
    done(
      {status: 'off', answer: '', citations: articleLinks(sources), confidence: 'none', offerHuman: true, followUps: []},
      {outcome: 'ai_off', topArticleId}
    );
  const capMicros = Math.max(0, Math.floor(input.capCents)) * MICROS_PER_CENT;
  if (!input.key || capMicros <= 0) return off();
  if (!(await takeAiWindows(db, input.clientKey))) return off();
  // Held against the cap while the call runs, so asks at once can't all pass it (usage.ts).
  const hold = costMicros(model, HOLD_INPUT_TOKENS, HOLD_OUTPUT_TOKENS);
  if (!(await reserveAiCall(db, capMicros, hold, month))) return off();

  // 4. The call. From here on the hold is ALWAYS settled: `writeQuestionLog` settles it with the
  // log row (one statement), and settles it alone if that write fails before it commits.
  const prompt = buildPrompt({
    assistantName: settings.assistantName,
    tone: settings.tone,
    sources,
    history,
    question,
  });
  const result = await callAnthropic(input.key, {
    model: model.id,
    system: prompt.system,
    messages: prompt.messages,
    serverFallback: model.serverFallback,
  }).catch(() => ({ok: false, reason: 'network'}) as const);
  const aiLog = {model: model.id, heldMicros: hold, ...billing(result, hold)};
  const parsed =
    result.ok && !result.refused && result.stopReason !== 'max_tokens' ? parseAnswer(result.text, sources.length) : null;
  if (!parsed) {
    return done(
      {status: 'handoff', answer: UNSURE_ANSWER, citations: articleLinks(sources), confidence: 'none', offerHuman: true, followUps: []},
      {...aiLog, outcome: 'handed_off', topArticleId}
    );
  }

  // 5–6. Confident enough, and no person needed → answered; else a hand-off that keeps the answer.
  const threshold = RANK[settings.confidenceThreshold] ?? RANK.medium;
  const handOff = parsed.needsHuman || RANK[parsed.confidence] < threshold;
  return done(
    {
      status: handOff ? 'handoff' : 'answered',
      answer: parsed.answer,
      citations: citedLinks(sources, parsed.citations),
      confidence: parsed.confidence,
      offerHuman: handOff,
      followUps: handOff ? [] : parsed.followUps,
    },
    {...aiLog, outcome: handOff ? 'handed_off' : 'answered', topArticleId}
  );
}

/**
 * What one call cost, for the log and the cap:
 * - a reply: every attempt (`usage.iterations`, a refused one included) at the price of the
 *   model that ran it (a server-side fallback bills at its own rate);
 * - a timeout or a lost connection: the provider may have run and billed it, and we can't know,
 *   so the hold stays as the cost (fails safe: the cap is never under-counted);
 * - an HTTP error or an unreadable reply: nothing reported as billed → 0 (the hold is released).
 */
function billing(
  result: Awaited<ReturnType<typeof callAnthropic>>,
  hold: number
): Pick<QuestionLogEntry, 'inputTokens' | 'outputTokens' | 'costMicros'> {
  if (result.ok) {
    return {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros: result.attempts.reduce((sum, a) => sum + costMicrosFor(a.model, a.inputTokens, a.outputTokens), 0),
    };
  }
  if (result.reason === 'timeout' || result.reason === 'network') return {inputTokens: 0, outputTokens: 0, costMicros: hold};
  return {inputTokens: 0, outputTokens: 0, costMicros: 0};
}

/* ------------------------------------ the log ------------------------------------ */

/**
 * Writes the question's ONE `question_logs` row and, in the SAME statement, settles this call's
 * money on `ai_usage` (spent += real cost − hold, as `recordAiCost` does; usage.ts) — one round
 * trip instead of two, on the month the hold was taken in (`log.month`). A write: never re-sent.
 * If it fails with an error the database raised BEFORE committing (a Prisma P20xx known request
 * error: a constraint, a bad value, a failed raw query), nothing was settled, so the hold is
 * settled alone with `recordAiCost`. Any other failure (a lost connection) may have committed:
 * the hold stays as spent (fails safe: never settled twice), and the error goes on.
 * Returns the row's id (a string: it is a BigInt).
 */
export async function writeQuestionLog(db: PrismaClient, log: QuestionLogEntry): Promise<string> {
  const cost = BigInt(Math.max(0, Math.ceil(log.costMicros)));
  const held = BigInt(Math.max(0, Math.ceil(log.heldMicros)));
  const month = log.month;
  // Nothing to settle (no call, or it cost exactly the hold): the plain insert.
  const settle =
    cost === held
      ? Prisma.empty
      : Prisma.sql`WITH settled AS (
          UPDATE "ai_usage"
          SET "spent_micros" = GREATEST(0, "spent_micros" + ${cost} - ${held}), "updated_at" = now()
          WHERE "month" = ${month}::date
          RETURNING 1
        )`;
  try {
    const rows = await db.$queryRaw<{id: bigint}[]>`
      ${settle}
      INSERT INTO "question_logs"
        ("question", "language", "page_path", "top_article_id", "confidence", "outcome", "model",
         "input_tokens", "output_tokens", "cost_micros", "created_at")
      VALUES (${log.question}, ${log.language}, ${log.pagePath}, ${log.topArticleId}, ${log.confidence}, ${log.outcome},
        ${log.model}, ${Math.round(log.inputTokens)}, ${Math.round(log.outputTokens)}, ${Number(cost)}, now())
      RETURNING "id"`;
    return String(rows[0].id);
  } catch (err) {
    const rejectedBeforeCommit = err instanceof Prisma.PrismaClientKnownRequestError && /^P20\d\d$/.test(err.code);
    if (cost !== held && rejectedBeforeCommit) await recordAiCost(db, Number(cost), Number(held), month).catch(() => undefined);
    throw err;
  }
}
