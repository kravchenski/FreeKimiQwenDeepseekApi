import { describe, expect, test } from 'bun:test';

import { createDeepSeekProvider } from '../src/providers/deepseek/provider.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const event = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;

function provider(body: string, overrides: Parameters<typeof createDeepSeekProvider>[0] = {}) {
  return createDeepSeekProvider({
    complete: async () => ({ response: new Response(body), sessionId: 'session-1' }),
    listModels: async () => ['deepseek-default'],
    hasAccount: () => true,
    ...overrides,
  });
}

describe('DeepSeek provider adapter', () => {
  test('streams thinking and content fragments and exposes the chat id', async () => {
    const body = [
      event({ p: 'response/fragments/-1/type', v: 'THINK' }),
      event({ p: 'response/fragments/-1/content', v: 'plan' }),
      event({ p: 'response/fragments/-1/type', v: 'RESPONSE' }),
      event({ p: 'response/fragments/-1/content', v: 'Hi' }),
      event({ p: 'response/status', v: 'FINISHED' }),
      event({ p: 'response/fragments/-1/content', v: 'ignored' }),
    ].join('');

    const result = await provider(body).stream({ model: 'deepseek-reasoner', messages: [] });

    expect(result.responseFields).toEqual({ x_deepseek_chat_id: 'session-1' });
    expect(await collectChunks(result.chunks)).toEqual({ content: 'Hi', reasoning: 'plan' });
  });

  test('propagates upstream failures before streaming', async () => {
    const failing = provider('', {
      complete: async () => {
        throw new Error('DeepSeek completion failed: 401 unauthorized');
      },
    });
    await expect(failing.stream({ model: 'deepseek-default', messages: [] })).rejects.toThrow('401');
  });

  test('leaves deepseek-ai models to NVIDIA and reports reasoning capability', () => {
    const deepseek = provider('');
    expect(deepseek.supports('deepseek-default')).toBeTrue();
    expect(deepseek.supports('deepseek-ai/deepseek-v4-pro')).toBeFalse();
    expect(deepseek.capabilities('deepseek-reasoner').reasoning).toBeTrue();
    expect(deepseek.capabilities('deepseek-default').reasoning).toBeFalse();
  });

  test('reports unavailable without accounts', () => {
    expect(provider('', { hasAccount: () => false }).health()).toEqual({
      available: false,
      reason: 'No active DeepSeek accounts',
    });
  });
});
