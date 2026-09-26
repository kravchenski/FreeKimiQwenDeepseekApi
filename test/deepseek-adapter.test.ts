import { describe, expect, test } from 'bun:test';

import { AccountPool } from '../src/core/accounts/account-pool.ts';
import { ProviderError } from '../src/core/providers/errors.ts';
import { openDatabase } from '../src/core/store/database.ts';
import { createDeepSeekProvider } from '../src/providers/deepseek/provider.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const event = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;

function provider(body: string, overrides: Parameters<typeof createDeepSeekProvider>[0] = {}) {
  return createDeepSeekProvider({
    complete: async () => ({ response: new Response(body), sessionId: 'session-1' }),
    listModels: async () => ['deepseek-default'],
    hasAccount: () => true,
    accounts: () => [],
    fallbackAccount: () => null,
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

  test('rotates to another account on rate limits and records account health', async () => {
    let now = 1_000_000;
    const pool = new AccountPool(openDatabase(':memory:'), 'deepseek', () => now);
    const used: string[] = [];
    const invalid: string[] = [];
    const accounts = [
      { id: 'ds-a', token: 'a', cookies: [] },
      { id: 'ds-b', token: 'b', cookies: [] },
    ];
    const replies: Record<string, () => Promise<{ response: Response; sessionId: string }>> = {
      a: async () => { throw new ProviderError('slow down', 'rate_limit', 429, 30); },
      b: async () => ({ response: new Response(event({ p: 'response/content', v: 'ok' })), sessionId: 's' }),
    };
    const deepseek = provider('', {
      accounts: () => accounts,
      pool: () => pool,
      now: () => now,
      markInvalid: id => invalid.push(id),
      complete: async request => {
        used.push(request.account!.id);
        return replies[request.account!.token]!();
      },
    });

    const first = await deepseek.stream({ model: 'deepseek-default', messages: [] });
    expect(await collectChunks(first.chunks)).toEqual({ content: 'ok', reasoning: '' });
    expect(used.sort()).toEqual(['ds-a', 'ds-b']);
    const status = () => Object.fromEntries(pool.list().map(state => [state.accountId, state.status]));
    expect(status()).toEqual({ 'ds-a': 'cooldown', 'ds-b': 'healthy' });

    replies.b = async () => { throw new ProviderError('DeepSeek completion failed: 401', 'auth', 401); };
    used.length = 0;
    await expect(deepseek.stream({ model: 'deepseek-default', messages: [] })).rejects.toThrow('401');
    expect(used).toEqual(['ds-b']);
    expect(status()).toEqual({ 'ds-a': 'cooldown', 'ds-b': 'unauthorized' });
    expect(invalid).toEqual(['ds-b']);

    now += 30_000;
    replies.a = replies.b;
    await expect(deepseek.stream({ model: 'deepseek-default', messages: [] })).rejects.toThrow('401');

    replies.a = async () => { throw new Error('socket hang up'); };
    const fresh = new AccountPool(openDatabase(':memory:'), 'deepseek', () => now);
    const failing = provider('', { accounts: () => [accounts[0]!], pool: () => fresh, complete: async () => replies.a!() });
    await expect(failing.stream({ model: 'deepseek-default', messages: [] })).rejects.toThrow('socket hang up');
    expect(fresh.list()[0]!.status).toBe('cooldown');
  });

  test('falls back to the DEEPSEEK_TOKEN account when no saved account is usable', async () => {
    const used: Array<string | undefined> = [];
    const deepseek = provider('', {
      accounts: () => [],
      fallbackAccount: () => ({ id: 'env', token: 'env-token', cookies: [] }),
      complete: async request => {
        used.push(request.account?.id);
        return { response: new Response(''), sessionId: 's' };
      },
    });
    await deepseek.stream({ model: 'deepseek-default', messages: [] });
    expect(used).toEqual(['env']);
  });
});

