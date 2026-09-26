import { describe, expect, test } from 'bun:test';

import { createNvidiaProvider, isNvidiaChatModel } from '../src/providers/catalog.ts';
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
  test('streams chunks from NVIDIA with the api key', async () => {
    const { calls, fetchFn } = recordingFetch(() =>
      sseResponse([delta({ content: 'Hel' }), delta({ content: 'lo' }), 'data: [DONE]', delta({ content: 'ignored' })])
    );
    const nvidia = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'n' }, fetch: fetchFn });

    const { chunks } = await nvidia.stream({ model: 'moonshotai/kimi-k3', messages: [{ role: 'user', content: 'hi' }] });

    expect(await collectChunks(chunks)).toEqual({ content: 'Hello', reasoning: '' });
    expect(calls[0]!.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer n');
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
    const nvidia = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'n' }, fetch: fetchFn });

    await expect(nvidia.stream({ model: 'z-ai/glm-5.3', messages: [] })).rejects.toThrow('NVIDIA completion failed: 429');
  });

  test('reports unavailable and refuses to call upstream without an api key', async () => {
    const { calls, fetchFn } = recordingFetch(() => sseResponse([]));
    const nvidia = createNvidiaProvider({ env: {}, fetch: fetchFn });

    expect(nvidia.health()).toEqual({ available: false, reason: 'NVIDIA_API_KEY is not set' });
    await expect(nvidia.stream({ model: 'moonshotai/kimi-k3', messages: [] })).rejects.toThrow('NVIDIA_API_KEY');
    expect(calls).toHaveLength(0);
  });

  test('routes NVIDIA model families by prefix', () => {
    const nvidia = createNvidiaProvider();
    expect(nvidia.supports('moonshotai/kimi-k3')).toBeTrue();
    expect(nvidia.supports('z-ai/glm-5.3')).toBeTrue();
    expect(nvidia.supports('deepseek-ai/deepseek-v4.1-flash')).toBeTrue();
    expect(nvidia.supports('deepseek-default')).toBeFalse();
    expect(nvidia.supports('kimi-k2.7-code-free')).toBeFalse();
  });

  test('lists NVIDIA chat models from upstream and drops non-chat ones', async () => {
    const { fetchFn } = recordingFetch(() => Response.json({ data: [
      { id: 'deepseek-ai/deepseek-v4.1-flash' },
      { id: 'nvidia/llama-3.2-nv-embedqa-1b-v1' },
      { id: 'nvidia/nemotron-3.5-content-safety' },
      { id: 'z-ai/glm-5.3' },
      { id: 'meta/llama-4' },
    ] }));
    const nvidia = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'n' }, fetch: fetchFn });
    expect(await nvidia.listModels()).toEqual(['deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3']);
    expect(isNvidiaChatModel('nvidia/nemotron-3-super-120b-a12b')).toBeTrue();
    expect(isNvidiaChatModel('nvidia/llama-3.1-nemotron-safety-guard-8b-v3')).toBeFalse();
  });
});

