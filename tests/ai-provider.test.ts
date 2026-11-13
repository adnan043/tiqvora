import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {aiModelOf, AI_MODELS, EXTRACT_MODEL} from '../src/lib/ai-models';
import {
  ANSWER_SCHEMA,
  callAnthropic,
  type ContentBlock,
  countTokens,
  MAX_TOKENS,
  type ProviderRequest,
  requestBody,
  setAiProviderForTests,
  setCountTokensForTests,
} from '../src/server/ai/provider';

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

// A fake PDF's base64: the provider must pass it through unchanged and never log it.
const PDF_B64 = 'JVBERi0xLjcKU0VDUkVULURPQ1VNRU5ULUJPRFk=';
const docBlocks = (): ContentBlock[] => [
  {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: PDF_B64}},
  {type: 'text', text: 'Transcribe pages 1 to 4 only.'},
];

describe('EXTRACT_MODEL', () => {
  it('is a listed model, Claude Haiku 5.5, with no server-side fallback', () => {
    expect(EXTRACT_MODEL).toBe('claude-haiku-5-5');
    expect(AI_MODELS.map(m => m.id)).toContain(EXTRACT_MODEL);
    expect(aiModelOf(EXTRACT_MODEL).id).toBe(EXTRACT_MODEL);
    expect(aiModelOf(EXTRACT_MODEL).serverFallback).toBe(false);
  });
});

describe('requestBody: content blocks and thinking', () => {
  it('passes block arrays unchanged and sends thinking only when set', () => {
    const blocks = docBlocks();
    const withThinking = requestBody({
      model: EXTRACT_MODEL,
      system: 'S',
      messages: [{role: 'user', content: blocks}],
      serverFallback: false,
      thinking: {type: 'disabled'},
      maxTokens: 5000,
    });
    expect(withThinking.messages).toEqual([{role: 'user', content: docBlocks()}]);
    expect(withThinking.thinking).toEqual({type: 'disabled'});
    expect(withThinking.max_tokens).toBe(5000);
    expect(withThinking).not.toHaveProperty('fallbacks');

    const plain = requestBody({model: 'claude-opus-5-5', system: 'S', messages: [{role: 'user', content: 'Hi'}], serverFallback: true});
    expect(plain).not.toHaveProperty('thinking');
    expect(plain.messages).toEqual([{role: 'user', content: 'Hi'}]);

    expect(requestBody({...req(false), thinking: {type: 'adaptive'}}).thinking).toEqual({type: 'adaptive'});
  });
});

describe('callAnthropic with a document block (stubbed fetch)', () => {
  let sent: Sent[];
  beforeEach(() => {
    setAiProviderForTests(null);
    sent = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({url, init});
      return new Response('{"error":"x"}', {status: 400});
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the document and disabled thinking; a failure never logs the base64', async () => {
    const result = await callAnthropic(KEY, {
      model: EXTRACT_MODEL,
      system: 'S',
      messages: [{role: 'user', content: docBlocks()}],
      serverFallback: false,
      thinking: {type: 'disabled'},
    });
    expect(result).toEqual({ok: false, reason: 'http'});
    const b = JSON.parse(String(sent[0]!.init.body)) as Record<string, unknown>;
    expect(b.messages).toEqual([{role: 'user', content: docBlocks()}]);
    expect(b.thinking).toEqual({type: 'disabled'});
    expect(b).not.toHaveProperty('fallbacks');
    for (const call of vi.mocked(console.warn).mock.calls) {
      expect(String(call[0])).not.toContain(PDF_B64);
      expect(String(call[0])).not.toContain(KEY);
    }
  });
});

describe('countTokens (real call, stubbed fetch)', () => {
  let sent: Sent[];
  let respond: () => Response | Promise<Response>;
  const countReq = () => ({
    model: EXTRACT_MODEL,
    system: 'SYSTEM',
    messages: [{role: 'user' as const, content: docBlocks()}],
    thinking: {type: 'disabled' as const},
  });

  beforeEach(() => {
    setCountTokensForTests(null);
    sent = [];
    respond = () => new Response(JSON.stringify({input_tokens: 4321}), {status: 200});
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({url, init});
      return respond();
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    setCountTokensForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts model, system, messages and thinking (no output_config) to the fixed URL', async () => {
    expect(await countTokens(KEY, countReq())).toEqual({ok: true, inputTokens: 4321});
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.redirect).toBe('manual');
    expect(sent[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const h = sent[0]!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['content-type']).toBe('application/json');
    expect(typeof h['anthropic-version']).toBe('string');
    expect(h).not.toHaveProperty('anthropic-beta');
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      model: EXTRACT_MODEL,
      system: 'SYSTEM',
      messages: [{role: 'user', content: docBlocks()}],
      thinking: {type: 'disabled'},
    });

    const {thinking: _omit, ...noThinking} = countReq();
    await countTokens(KEY, noThinking);
    expect(JSON.parse(String(sent[1]!.init.body))).not.toHaveProperty('thinking');
  });

  it('validates the reply shape', async () => {
    for (const bad of ['not json', '{}', '{"input_tokens":-1}', '{"input_tokens":1.5}', '{"input_tokens":"9"}', '[1]']) {
      respond = () => new Response(bad, {status: 200});
      expect(await countTokens(KEY, countReq())).toEqual({ok: false, reason: 'shape'});
    }
  });

  it('http, timeout and network failures; no key → failure without fetch; never logs the key or the base64', async () => {
    respond = () => new Response('{"error":"x"}', {status: 413});
    expect(await countTokens(KEY, countReq())).toEqual({ok: false, reason: 'http'});
    respond = () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    expect(await countTokens(KEY, countReq())).toEqual({ok: false, reason: 'timeout'});
    respond = () => {
      throw new TypeError('fetch failed');
    };
    expect(await countTokens(KEY, countReq())).toEqual({ok: false, reason: 'network'});

    const before = sent.length;
    expect(await countTokens('  ', countReq())).toEqual({ok: false, reason: 'http'});
    expect(await countTokens('', countReq())).toEqual({ok: false, reason: 'http'});
    expect(sent.length).toBe(before);

    for (const call of vi.mocked(console.warn).mock.calls) {
      expect(String(call[0])).not.toContain(KEY);
      expect(String(call[0])).not.toContain(PDF_B64);
    }
  });

  it('a real timeout aborts a slow reply', async () => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      sent.push({url, init});
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    expect(await countTokens(KEY, {...countReq(), timeoutMs: 20})).toEqual({ok: false, reason: 'timeout'});
  });

  it('the test hook replaces the call and null restores it', async () => {
    const fake = vi.fn(async () => ({ok: true as const, inputTokens: 7}));
    setCountTokensForTests(fake);
    expect(await countTokens(KEY, countReq())).toEqual({ok: true, inputTokens: 7});
    expect(fake).toHaveBeenCalledWith(KEY, countReq());
    expect(sent).toHaveLength(0);
    setCountTokensForTests(null);
    expect(await countTokens(KEY, countReq())).toEqual({ok: true, inputTokens: 4321});
  });
});
