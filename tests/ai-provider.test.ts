import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ANSWER_SCHEMA, callAnthropic, MAX_TOKENS, type ProviderRequest, setAiProviderForTests} from '../src/server/ai/provider';

/**
 * The real Messages API call (src/server/ai/provider.ts) with a stubbed global `fetch`: the
 * request it sends (body and headers) and how it reads replies, refusals and fallbacks.
 */
const KEY = 'fake-anthropic-key-unit-test';

type Sent = {url: string; init: RequestInit};

const reply = (extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {input_tokens: 100, output_tokens: 50}) => ({
  type: 'message',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{type: 'text', text: '{"answer":"Hi"}'}],
  usage,
  ...extra,
});

const req = (serverFallback: boolean, model = 'claude-opus-5-5'): ProviderRequest => ({
  model,
  system: 'SYSTEM',
  messages: [{role: 'user', content: '<question>Hi</question>'}],
  serverFallback,
});

describe('callAnthropic (real call, stubbed fetch)', () => {
  let sent: Sent[];
  let respond: () => Response | Promise<Response>;

  beforeEach(() => {
    setAiProviderForTests(null);
    sent = [];
    respond = () => new Response(JSON.stringify(reply()), {status: 200});
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({url, init});
      return respond();
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const body = () => JSON.parse(String(sent[0]!.init.body)) as Record<string, unknown>;
  const headers = () => sent[0]!.init.headers as Record<string, string>;

  it('sends the fixed shape: effort low, json_schema, max_tokens 3000, no temperature or thinking; fallbacks when the model has them', async () => {
    const result = await callAnthropic(KEY, req(true));
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.redirect).toBe('manual');
    const b = body();
    expect(MAX_TOKENS).toBe(3000);
    expect(b.max_tokens).toBe(3000);
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.system).toBe('SYSTEM');
    expect(b.messages).toEqual([{role: 'user', content: '<question>Hi</question>'}]);
    expect(b.output_config).toEqual({effort: 'low', format: {type: 'json_schema', schema: ANSWER_SCHEMA}});
    expect(b).not.toHaveProperty('temperature');
    expect(b).not.toHaveProperty('top_p');
    expect(b).not.toHaveProperty('thinking');
    expect(b.fallbacks).toBe('default');
    expect(headers()['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(headers()['x-api-key']).toBe(KEY);
    expect(headers()['content-type']).toBe('application/json');
    expect(typeof headers()['anthropic-version']).toBe('string');
  });

  it('no fallbacks key and no beta header for a model without server-side fallback (Haiku 5.5)', async () => {
    await callAnthropic(KEY, req(false, 'claude-haiku-5-5'));
    expect(body()).not.toHaveProperty('fallbacks');
    expect(headers()).not.toHaveProperty('anthropic-beta');
    expect(body().model).toBe('claude-haiku-5-5');
  });

  it('a plain reply: totals, one attempt at the served model, the stop reason', async () => {
    const result = await callAnthropic(KEY, req(true));
    expect(result).toEqual({
      ok: true,
      text: '{"answer":"Hi"}',
      inputTokens: 100,
      outputTokens: 50,
      attempts: [{model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 50}],
      stopReason: 'end_turn',
      refused: false,
    });
  });

  it('a server-side fallback: every attempt from usage.iterations, each at the model that ran it', async () => {
    respond = () =>
      new Response(
        JSON.stringify(
          reply(
            {
              model: 'claude-opus-4-8',
              content: [
                {type: 'fallback', from: {model: 'claude-opus-5-5'}, to: {model: 'claude-opus-4-8'}},
                {type: 'text', text: '{"answer":"Hi"}'},
              ],
            },
            {
              input_tokens: 120,
              output_tokens: 60,
              iterations: [
                {type: 'message', input_tokens: 110, output_tokens: 5},
                {type: 'fallback_message', input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3},
              ],
            }
          )
        ),
        {status: 200}
      );
    const result = await callAnthropic(KEY, req(true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toEqual([
      {model: 'claude-opus-5-5', inputTokens: 110, outputTokens: 5},
      // Cache tokens count at the full input price.
      {model: 'claude-opus-4-8', inputTokens: 123, outputTokens: 60},
    ]);
    expect(result.inputTokens).toBe(233);
    expect(result.outputTokens).toBe(65);
    expect(result.refused).toBe(false);
  });

  it('a refusal is ok with refused; max_tokens is returned and logged', async () => {
    respond = () => new Response(JSON.stringify(reply({stop_reason: 'refusal', content: []})), {status: 200});
    const refused = await callAnthropic(KEY, req(false));
    expect(refused.ok && refused.refused).toBe(true);

    respond = () => new Response(JSON.stringify(reply({stop_reason: 'max_tokens'})), {status: 200});
    const cut = await callAnthropic(KEY, req(false));
    expect(cut.ok && cut.stopReason).toBe('max_tokens');
    expect(console.warn).toHaveBeenCalledWith('[ai] anthropic shape max_tokens');
  });

  it('failures: http, shape, timeout, network; never the key in a log line', async () => {
    respond = () => new Response('{"error":"x"}', {status: 529});
    expect(await callAnthropic(KEY, req(true))).toEqual({ok: false, reason: 'http'});
    respond = () => new Response('not json', {status: 200});
    expect(await callAnthropic(KEY, req(true))).toEqual({ok: false, reason: 'shape'});
    respond = () => new Response(JSON.stringify(reply({}, {input_tokens: -1, output_tokens: 1})), {status: 200});
    expect(await callAnthropic(KEY, req(true))).toEqual({ok: false, reason: 'shape'});
    respond = () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    expect(await callAnthropic(KEY, req(true))).toEqual({ok: false, reason: 'timeout'});
    respond = () => {
      throw new TypeError('fetch failed');
    };
    expect(await callAnthropic(KEY, req(true))).toEqual({ok: false, reason: 'network'});
    expect(await callAnthropic('  ', req(true))).toEqual({ok: false, reason: 'http'});
    for (const call of vi.mocked(console.warn).mock.calls) expect(String(call[0])).not.toContain(KEY);
  });
});
