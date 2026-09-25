import { describe, expect, test } from 'bun:test';

import { createNvidiaProvider, createZenMuxProviders } from '../src/providers/catalog.ts';
import { parseOpenAIEvent } from '../src/providers/openai-compatible.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

function sseResponse(lines: string[], status = 200) {
  return new Response(lines.map(line => `${line}\n\n`).join(''), { status });
}

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const delta = (value: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: value }] })}`;

describe('parseOpenAIEvent', () => {
  test('extracts reasoning and content from one delta', () => {
    expect(parseOpenAIEvent(delta({ reasoning_content: 'hmm', content: 'hi' }))).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'content', text: 'hi' },
    ]);
  });

  test('handles done, non-data and malformed lines', () => {
    expect(parseOpenAIEvent('data: [DONE]')).toBe('done');
    expect(parseOpenAIEvent(': keep-alive')).toBeNull();
    expect(parseOpenAIEvent('data: {broken')).toBeNull();
  });
});

describe('OpenAI-compatible providers', () => {
  test('maps kimi models to the moonshot upstream name and streams chunks', async () => {
    const { calls, fetchFn } = recordingFetch(() =>
      sseResponse([delta({ content: 'Hel' }), delta({ content: 'lo' }), 'data: [DONE]', delta({ content: 'ignored' })])
    );
    const kimi = createZenMuxProviders({ env: { ZENMUX_API_KEY: 'k' }, fetch: fetchFn }).find(p => p.id === 'kimi')!;

    const { chunks } = await kimi.stream({ model: 'kimi-k2.7-code-free', messages: [{ role: 'user', content: 'hi' }] });

    expect(await collectChunks(chunks)).toEqual({ content: 'Hello', reasoning: '' });
    expect(calls[0]!.url).toBe('https://zenmux.ai/api/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ model: 'moonshotai/kimi-k2.7-code-free', stream: true });
  });

  test('nvidia sends sampling defaults but keeps the requested model', async () => {
    const { calls, fetchFn } = recordingFetch(() => sseResponse(['data: [DONE]']));
    const nvidia = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'n' }, fetch: fetchFn });

    await nvidia.stream({ model: 'deepseek-ai/deepseek-v4-pro', messages: [] });

    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      model: 'deepseek-ai/deepseek-v4-pro',
      temperature: 1,
      max_tokens: 8192,
      stream: true,
    });
  });

  test('throws before streaming when the upstream rejects the request', async () => {
    const { fetchFn } = recordingFetch(() => new Response('rate limited', { status: 429 }));
    const glm = createZenMuxProviders({ env: { ZENMUX_API_KEY: 'k' }, fetch: fetchFn }).find(p => p.id === 'glm')!;

    await expect(glm.stream({ model: 'glm-5.2-free', messages: [] })).rejects.toThrow('GLM (ZenMux) completion failed: 429');
  });

  test('reports unavailable and refuses to call upstream without an api key', async () => {
    const { calls, fetchFn } = recordingFetch(() => sseResponse([]));
    const stepfun = createZenMuxProviders({ env: {}, fetch: fetchFn }).find(p => p.id === 'stepfun')!;

    expect(stepfun.health()).toEqual({ available: false, reason: 'ZENMUX_API_KEY is not set' });
    await expect(stepfun.stream({ model: 'stepfun/step-3.7-flash-free', messages: [] })).rejects.toThrow('ZENMUX_API_KEY');
    expect(calls).toHaveLength(0);
  });

  test('routes models by prefix', () => {
    const providers = [createNvidiaProvider(), ...createZenMuxProviders()];
    const owner = (model: string) => providers.find(p => p.supports(model))?.id;
    expect(owner('moonshotai/kimi-k2.6')).toBe('nvidia');
    expect(owner('kimi-k2.7-code-free')).toBe('kimi');
    expect(owner('sapiens-ai/agnes-2.0-flash')).toBe('sapiens');
    expect(owner('deepseek-default')).toBeUndefined();
  });
});
