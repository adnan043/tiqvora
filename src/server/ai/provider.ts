/**
 * The assistant's one call to an AI provider: Anthropic's Messages API, with a raw `fetch`
 * (no SDK, no dependency) to a FIXED origin. The key comes only from the caller, who reads it
 * with `config.ownerSecret('ANTHROPIC_API_KEY')` (docs/agent/security.md › Calling other services).
 *
 * What is sent: the fixed system prompt, the customer's own words in this conversation and the
 * retrieved help-center text (src/server/ai/prompt.ts), or (knowledge files) one uploaded PDF as
 * a base64 `document` block. Never an email, name, user id, IP or cookie. Nothing here logs the
 * key, the request body (a document's base64 included) or the reply text: on a failure only a
 * short reason code.
 *
 * Fails closed: anything unexpected in the reply is `{ok: false, reason: 'shape'}`, and the
 * caller hands the customer to a person instead of showing it.
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2026-10-21';
/** Only sent with `fallbacks` (the `"default"` scalar form needs this beta). */
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const TIMEOUT_MS = 10_000;
/** An answer is ≤ 120 words of JSON; this leaves room and bounds the cost (answer.ts holds it). */
export const MAX_TOKENS = 3000;
/** A reply this large is not an answer of ≤ 3,000 tokens: refuse to parse it. */
const MAX_RESPONSE_CHARS = 200_000;

/** The JSON the model must answer with (structured outputs: `output_config.format`). */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'citations', 'confidence', 'needsHuman', 'followUps'],
  properties: {
    answer: {type: 'string'},
    citations: {type: 'array', items: {type: 'integer'}},
    confidence: {type: 'string', enum: ['high', 'medium', 'low']},
    needsHuman: {type: 'boolean'},
    followUps: {type: 'array', items: {type: 'string'}},
  },
} as const;

/** One content block of a message: text, or a PDF sent inline as base64 (no newlines in `data`). */
export type ContentBlock =
  | {type: 'text'; text: string}
  | {type: 'document'; source: {type: 'base64'; media_type: 'application/pdf'; data: string}};

export interface ProviderMessage {
  role: 'user' | 'assistant';
  /** A plain string, or blocks (a document block goes before the text that asks about it). */
  content: string | ContentBlock[];
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  /** Send `fallbacks` (+ its beta header): only for a model that has them (`AiModel.serverFallback`). */
  serverFallback: boolean;
  /** The JSON schema the reply must follow. Default: the assistant's ANSWER_SCHEMA. */
  schema?: object;
  /** The reply's token ceiling (bounds the cost: the caller's hold uses the same number). Default: MAX_TOKENS. */
  maxTokens?: number;
  /** How long to wait for the provider, in ms. Default: TIMEOUT_MS (10 s). */
  timeoutMs?: number;
  /**
   * Default: omitted (the model's default: adaptive on every current model). Extraction sends
   * `{type: 'disabled'}` (Claude Haiku 5.5 accepts it at effort ≤ high; we send `low`).
   * Never `disabled` on Claude Opus 5.5 or Sonnet 5.5: a 400 there.
   */
  thinking?: {type: 'disabled'} | {type: 'adaptive'};
}

/** One model run inside the call: the requested one, then each server-side fallback. */
export interface ProviderAttempt {
  /** The model that ran it (priced at its own rate: src/lib/ai-models.ts `costMicrosFor`). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type ProviderFailure = 'timeout' | 'http' | 'shape' | 'network';

export type ProviderResult =
  | {
      ok: true;
      text: string;
      /** Totals over every attempt (a refused one included). */
      inputTokens: number;
      outputTokens: number;
      /** Per attempt, for pricing: `usage.iterations` when present, else the one reply. */
      attempts: ProviderAttempt[];
      /** `end_turn`, `max_tokens`, `refusal`, … (null when the reply had none). */
      stopReason: string | null;
      refused: boolean;
    }
  | {ok: false; reason: ProviderFailure};

export type AiProviderFn = (key: string, req: ProviderRequest) => Promise<ProviderResult>;

let providerForTests: AiProviderFn | null = null;

/** TESTS ONLY: replace the provider with a fake (null restores the real call). */
export function setAiProviderForTests(fn: AiProviderFn | null): void {
  providerForTests = fn;
}

/** One Messages API call. Never throws. */
export function callAnthropic(key: string, req: ProviderRequest): Promise<ProviderResult> {
  if (providerForTests) return providerForTests(key, req);
  return realCall(key, req);
}

function fail(reason: ProviderFailure, detail?: string | number): ProviderResult {
  // A reason code (and an HTTP status) only: never the key, the body or the reply.
  console.warn(`[ai] anthropic ${reason}${detail === undefined ? '' : ` ${detail}`}`);
  return {ok: false, reason};
}

/** A whole number ≥ 1, else the default (an optional limit given as 0, NaN or a fraction never weakens it). */
function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * The request body (exported for the provider's unit test). No `temperature` (a 400 on this API
 * version); `thinking` only when the caller sets it, else the model's default.
 */
export function requestBody(req: ProviderRequest): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: positiveInt(req.maxTokens, MAX_TOKENS),
    system: req.system,
    messages: req.messages,
    output_config: {effort: 'low', format: {type: 'json_schema', schema: req.schema ?? ANSWER_SCHEMA}},
    ...(req.thinking ? {thinking: req.thinking} : {}),
    // A policy refusal retried on the provider's default fallback model, in the same call.
    // Never for a model without them (Claude Haiku 5.5: a 400).
    ...(req.serverFallback ? {fallbacks: 'default'} : {}),
  };
}

function baseHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key.trim(),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

async function realCall(key: string, req: ProviderRequest): Promise<ProviderResult> {
  if (typeof key !== 'string' || key.trim() === '') return fail('http', 'no_key');

  const headers = baseHeaders(key);
  if (req.serverFallback) headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;

  let raw: string;
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(req)),
      redirect: 'manual',
      signal: AbortSignal.timeout(positiveInt(req.timeoutMs, TIMEOUT_MS)),
    });
    if (!res.ok) {
      // Drain nothing we'd log; let the connection go.
      res.body?.cancel().catch(() => {});
      return fail('http', res.status);
    }
    raw = await res.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout');
    return fail('network');
  }

  if (raw.length > MAX_RESPONSE_CHARS) return fail('shape', 'too_large');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('shape', 'json');
  }
  const result = readMessage(data, req.model);
  if (!result) return fail('shape');
  // Cut off: the JSON is incomplete. Billed (the caller records it), never shown.
  if (result.ok && result.stopReason === 'max_tokens') console.warn('[ai] anthropic shape max_tokens');
  return result;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.@:_-]{0,99}$/i;
const modelId = (v: unknown): string | null => (typeof v === 'string' && MODEL_ID_RE.test(v) ? v : null);

/**
 * Tokens of one usage object. Cache reads and writes are counted at the full input price:
 * nothing here asks for caching, so they are 0 in practice, and over-counting is the safe side.
 */
function readTokens(usage: Record<string, unknown>): {inputTokens: number; outputTokens: number} | null {
  const {input_tokens: input, output_tokens: output} = usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (!isCount(input) || !isCount(output) || !isCount(cacheRead) || !isCount(cacheWrite)) return null;
  return {inputTokens: input + cacheRead + cacheWrite, outputTokens: output};
}

/** Validates every field it reads; null = not a Messages API reply we understand. */
function readMessage(data: unknown, requestedModel: string): ProviderResult | null {
  if (!isObject(data) || data.type !== 'message') return null;
  const {content, usage, stop_reason: stopReason} = data;
  if (!Array.isArray(content) || !isObject(usage)) return null;
  if (stopReason !== null && stopReason !== undefined && typeof stopReason !== 'string') return null;
  // The model that produced the returned message (a fallback's, when one served).
  const served = modelId(data.model) ?? requestedModel;

  let text = '';
  // The models in the order they ran: the requested one, then each fallback block's `to`.
  const chain = [requestedModel];
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== 'string') return null;
    if (block.type === 'fallback') {
      const to = isObject(block.to) ? modelId(block.to.model) : null;
      if (to) chain.push(to);
      continue;
    }
    // `thinking` and any other block types are not the answer: skip them.
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') return null;
    text += block.text;
  }

  // Billing: `usage.iterations` is per attempt (a refused attempt included); top-level `usage`
  // covers only the attempt that produced this message. Each attempt at its own model's price.
  const attempts: ProviderAttempt[] = [];
  const iterations = usage.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    if (iterations.length > 10) return null;
    for (const [i, entry] of iterations.entries()) {
      if (!isObject(entry)) return null;
      const tokens = readTokens(entry);
      if (!tokens) return null;
      const model = modelId(entry.model) ?? (entry.type === 'fallback_message' ? served : (chain[i] ?? served));
      attempts.push({model, ...tokens});
    }
  } else {
    const tokens = readTokens(usage);
    if (!tokens) return null;
    attempts.push({model: served, ...tokens});
  }

  return {
    ok: true,
    text,
    inputTokens: attempts.reduce((sum, a) => sum + a.inputTokens, 0),
    outputTokens: attempts.reduce((sum, a) => sum + a.outputTokens, 0),
    attempts,
    stopReason: typeof stopReason === 'string' ? stopReason : null,
    refused: stopReason === 'refusal',
  };
}

// ---------------------------------------------------------------------------------------------
// Token counting (free): `POST /v1/messages/count_tokens`, the same model / system / messages /
// thinking as the call that will follow. No `output_config` (not verified on this endpoint): the
// caller adds a margin for the schema. Same fixed origin, headers, no-redirect and no-log rules.

export type CountTokensRequest = {
  model: string;
  system: string;
  messages: ProviderMessage[];
  thinking?: ProviderRequest['thinking'];
  /** Default: TIMEOUT_MS (10 s). */
  timeoutMs?: number;
};

export type CountTokensResult = {ok: true; inputTokens: number} | {ok: false; reason: ProviderFailure};

export type CountTokensFn = (key: string, req: CountTokensRequest) => Promise<CountTokensResult>;

let countTokensForTests: CountTokensFn | null = null;

/** TESTS ONLY: replace token counting with a fake (null restores the real call). */
export function setCountTokensForTests(fn: CountTokensFn | null): void {
  countTokensForTests = fn;
}

/** Input tokens of a request, as the provider counts them. Never throws. */
export function countTokens(key: string, req: CountTokensRequest): Promise<CountTokensResult> {
  if (countTokensForTests) return countTokensForTests(key, req);
  return realCount(key, req);
}

function countFail(reason: ProviderFailure, detail?: string | number): CountTokensResult {
  console.warn(`[ai] anthropic count_tokens ${reason}${detail === undefined ? '' : ` ${detail}`}`);
  return {ok: false, reason};
}

/** The count_tokens body (exported for the provider's unit test). */
export function countTokensBody(req: CountTokensRequest): Record<string, unknown> {
  return {
    model: req.model,
    system: req.system,
    messages: req.messages,
    ...(req.thinking ? {thinking: req.thinking} : {}),
  };
}

async function realCount(key: string, req: CountTokensRequest): Promise<CountTokensResult> {
  if (typeof key !== 'string' || key.trim() === '') return countFail('http', 'no_key');

  let raw: string;
  try {
    const res = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
      method: 'POST',
      headers: baseHeaders(key),
      body: JSON.stringify(countTokensBody(req)),
      redirect: 'manual',
      signal: AbortSignal.timeout(positiveInt(req.timeoutMs, TIMEOUT_MS)),
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return countFail('http', res.status);
    }
    raw = await res.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return countFail('timeout');
    return countFail('network');
  }

  if (raw.length > 10_000) return countFail('shape', 'too_large');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return countFail('shape', 'json');
  }
  if (!isObject(data) || !isCount(data.input_tokens)) return countFail('shape');
  return {ok: true, inputTokens: data.input_tokens};
}
