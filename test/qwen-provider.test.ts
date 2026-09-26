import { describe, expect, test } from 'bun:test';

import { collectChunks } from '../src/core/streaming/sse.ts';
import { createQwenProvider, QWEN_FALLBACK_MODELS } from '../src/providers/qwen/provider.ts';

function recordingFetch(respond: (url: string) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const noPool = { resolveApiKey: async () => undefined, hasApiKey: () => false };

describe('Qwen API provider', () => {
  test('streams chat completions from the proxy with the account token', async () => {
    const { calls, fetchFn } = recordingFetch(() =>
      new Response('data: {"choices":[{"delta":{"reasoning_content":"r","content":"Hi"}}]}\n\ndata: [DONE]\n\n')
    );
    const qwen = createQwenProvider({ ...noPool, env: { QWEN_TOKEN: 'jwt' }, fetch: fetchFn });

    const { chunks } = await qwen.stream({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }] });

    expect(await collectChunks(chunks)).toEqual({ content: 'Hi', reasoning: 'r' });
    expect(calls[0]!.url).toBe('https://qwen.aikit.club/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ model: 'qwen3.7-plus', stream: true });
  });

  test('uses a token from the account pool and a custom base url', async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response('data: [DONE]\n\n'));
    const qwen = createQwenProvider({
      env: { QWEN_API_BASE_URL: 'https://qwen.example.test/v1' },
      resolveApiKey: async () => 'pooled',
      hasApiKey: () => true,
      fetch: fetchFn,
    });

    await qwen.stream({ model: 'qwen3.8-max', messages: [] });

    expect(qwen.health()).toEqual({ available: true });
    expect(calls[0]!.url).toBe('https://qwen.example.test/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer pooled');
  });

  test('lists upstream qwen models and ignores foreign ids', async () => {
    const { fetchFn } = recordingFetch(() =>
      Response.json({ data: [{ id: 'qwen3.9-max' }, { id: 'gpt-4o' }, { id: 42 }] })
    );
    const qwen = createQwenProvider({ ...noPool, env: { QWEN_TOKEN: 'jwt' }, fetch: fetchFn });
    expect(await qwen.listModels()).toEqual(['qwen3.9-max']);
  });

  test('falls back to known models when the model list is unavailable', async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response('unauthorized', { status: 401 }));
    expect(await createQwenProvider({ ...noPool, env: { QWEN_TOKEN: 'bad' }, fetch: fetchFn }).listModels()).toEqual(QWEN_FALLBACK_MODELS);
    expect(await createQwenProvider({ ...noPool, env: {}, fetch: fetchFn }).listModels()).toEqual(QWEN_FALLBACK_MODELS);
    expect(calls).toHaveLength(1);
  });

  test('refuses to call the proxy without a token', async () => {
    const { calls, fetchFn } = recordingFetch(() => new Response(''));
    const qwen = createQwenProvider({ ...noPool, env: {}, fetch: fetchFn });
    expect(qwen.health()).toEqual({ available: false, reason: 'QWEN_TOKEN is not set' });
    await expect(qwen.stream({ model: 'qwen3.7-plus', messages: [] })).rejects.toThrow('QWEN_TOKEN');
    expect(calls).toHaveLength(0);
  });

  test('reports classified upstream outcomes with the token that was used', async () => {
    const reports: Array<[string, unknown]> = [];
    let reply = () => new Response('{"error":{"message":"Token has expired, please log in again."}}', { status: 500 });
    const { fetchFn } = recordingFetch(() => reply());
    const qwen = createQwenProvider({
      ...noPool,
      env: { QWEN_TOKEN: 'jwt' },
      fetch: fetchFn,
      reportResult: (apiKey, outcome) => reports.push([apiKey, outcome]),
    });
    const error = await qwen.stream({ model: 'qwen3.7-plus', messages: [] }).catch(caught => caught);
    expect(error.kind).toBe('auth');
    reply = () => new Response('data: [DONE]\n\n');
    await qwen.stream({ model: 'qwen3.7-plus', messages: [] });
    expect(reports).toEqual([
      ['jwt', { ok: false, kind: 'auth', status: 500, retryAfterSeconds: undefined }],
      ['jwt', { ok: true }],
    ]);
  });

});
