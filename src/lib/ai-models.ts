/**
 * The AI models the owner may pick for the assistant (Settings › Assistant), with their
 * prices. Browser-safe: the settings screen shows the list, the server validates against it
 * and prices every call with it (src/server/ai/). Prices are USD per 1M tokens, so
 * `tokens × price` is micro-dollars exactly.
 *
 * Only Anthropic for now: the settings column allows `openai`, but no OpenAI model is listed
 * until it is built and tested.
 */
export type AiProvider = 'anthropic';

export interface AiModel {
  id: string;
  provider: AiProvider;
  label: string;
  /** Plain words for the settings screen. */
  hint: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * The provider retries a policy refusal on another model itself (Anthropic's server-side
   * `fallbacks`, beta). Claude Haiku 5.5 has none: sending `fallbacks` to it is a 400.
   */
  serverFallback: boolean;
}

export const AI_MODELS: readonly AiModel[] = [
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    label: 'Claude Opus 5.5',
    hint: 'The most careful answers. The default.',
    inputPerMTok: 4,
    outputPerMTok: 20,
    serverFallback: true,
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5.5',
    hint: 'Fast and capable, about half the cost.',
    inputPerMTok: 2,
    outputPerMTok: 10,
    serverFallback: true,
  },
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    label: 'Claude Haiku 5.5',
    hint: 'The fastest and cheapest, for simple questions.',
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    serverFallback: false,
  },
];

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

/** The owner secret holding each provider's key (`config.ownerSecret(name)`). Never the value. */
export const AI_SECRET_NAMES: Record<AiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
};

/** The model the settings name, or the default when it is empty or no longer listed. */
export function aiModelOf(id: string | null | undefined): AiModel {
  return AI_MODELS.find(m => m.id === id) ?? AI_MODELS.find(m => m.id === DEFAULT_AI_MODEL)!;
}

/** Micro-dollars for one call. */
export function costMicros(model: AiModel, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * model.inputPerMTok + outputTokens * model.outputPerMTok);
}

export interface AiPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Prices of the models that may SERVE a call: the pickable ones, plus those a server-side
 * fallback can run (the reply's `model` and `usage.iterations` name them). Used by the server
 * to price what was really billed; harmless in the browser (no secret, no call).
 */
const SERVING_PRICES: Readonly<Record<string, AiPrice>> = {
  ...Object.fromEntries(AI_MODELS.map(m => [m.id, {inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok}])),
  'claude-opus-5': {inputPerMTok: 5, outputPerMTok: 25},
  'claude-opus-4-8': {inputPerMTok: 5, outputPerMTok: 25},
  'claude-sonnet-5': {inputPerMTok: 2, outputPerMTok: 10},
};

/** The highest known price, for a model id we don't know (never under-count spend). */
const HIGHEST_PRICE: AiPrice = Object.values(SERVING_PRICES).reduce(
  (max, p) => ({inputPerMTok: Math.max(max.inputPerMTok, p.inputPerMTok), outputPerMTok: Math.max(max.outputPerMTok, p.outputPerMTok)}),
  {inputPerMTok: 0, outputPerMTok: 0}
);

/** The price of the model that served (or refused) one attempt; unknown → the highest known. */
export function priceOf(modelId: string | null | undefined): AiPrice {
  return (typeof modelId === 'string' && Object.hasOwn(SERVING_PRICES, modelId) ? SERVING_PRICES[modelId] : undefined) ?? HIGHEST_PRICE;
}

/** Micro-dollars for one attempt on the model that ran it (by id, from the provider's reply). */
export function costMicrosFor(modelId: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const price = priceOf(modelId);
  return Math.ceil(inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok);
}
