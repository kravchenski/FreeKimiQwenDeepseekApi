import { describe, expect, test } from 'bun:test';

import { KeyPool, parseKeyList } from '../src/core/accounts/key-pool.ts';
import { buildOverview } from '../src/cli/overview.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { API_KEY_PROVIDERS, apiKeyProvider, createApiProvider } from '../src/providers/catalog.ts';

function upstream(behaviour: Record<string, number>, retryAfter?: string) {
  const used: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit = {}) => {
    const key = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    used.push(key);
    const status = behaviour[key] ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: `status ${status}` } }), { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: key } }] })}\n\ndata: [DONE]\n\n`);
  }) as unknown as typeof fetch;
  return { fetchFn, used };
}

describe('key lists', () => {
  test('reads one key, comma or line separated keys and JSON arrays', () => {
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList(' only ')).toEqual(['only']);
    expect(parseKeyList('k1, k2,,k3\nk4')).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(parseKeyList('["k1", "k2", "k1"]')).toEqual(['k1', 'k2']);
    expect(parseKeyList("['k1', 'k2']")).toEqual(['k1', 'k2']);
  });

  test('sticks to the working key and pauses keys that hit limits', () => {
    let clock = 0;
    const pool = new KeyPool(() => clock);
    expect(pool.order(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    pool.succeeded('b');
    expect(pool.order(['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    pool.failed('b', 'rate_limit');
    pool.failed('a', 'auth');
    pool.failed('c', 'upstream');
    expect(pool.order(['a', 'b', 'c'])).toEqual(['c']);
    clock = 61_000;
    expect(pool.order(['a', 'b', 'c'])).toEqual(['b', 'c']);
    pool.failed('c', 'quota_exhausted', 5);
    expect(pool.secondsUntilReady(['a', 'c'])).toBe(5);
  });
});

describe('providers with several keys', () => {
  test('moves to the next key in the same request and remembers the one that worked', async () => {
    const { fetchFn, used } = upstream({ k1: 429, k2: 401 }, '30');
    const provider = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'k1,k2,k3' }, fetch: fetchFn });
    const first = await collectChunks((await provider.stream({ model: 'groq/llama', messages: [] })).chunks);
    expect(first.content).toBe('k3');
    expect(used).toEqual(['k1', 'k2', 'k3']);
    used.length = 0;
    await collectChunks((await provider.stream({ model: 'groq/llama', messages: [] })).chunks);
    expect(used).toEqual(['k3']);
  });

  test('lists models with the next key when the first one is rejected', async () => {
    const used: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit = {}) => {
      const key = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      used.push(key);
      return key === 'bad' ? new Response('no', { status: 401 }) : Response.json({ data: [{ id: 'llama' }] });
    }) as unknown as typeof fetch;
    const provider = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'bad,good' }, fetch: fetchFn });
    expect(await provider.listModels()).toEqual(['groq/llama']);
    expect(used).toEqual(['bad', 'good']);
  });

  test('combines keys from the environment with saved keys', async () => {
    const { fetchFn, used } = upstream({ env1: 429 });
    const credentials = { list: () => [{ id: 'groq-1', provider: 'groq', email: 'main', password: '', method: 'api-key' as const, token: 'saved1' }] };
    const provider = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: '["env1"]' }, fetch: fetchFn }, credentials);
    expect((await collectChunks((await provider.stream({ model: 'groq/llama', messages: [] })).chunks)).content).toBe('saved1');
    expect(used).toEqual(['env1', 'saved1']);
  });

  test('reports the provider as unavailable while every key is paused and does not rotate on other errors', async () => {
    const limited = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'k1,k2' }, fetch: upstream({ k1: 429, k2: 429 }).fetchFn });
    await expect(limited.stream({ model: 'groq/llama', messages: [] })).rejects.toThrow('status 429');
    expect(limited.health()).toMatchObject({ available: false });
    expect(limited.health().reason).toContain('all 2 Groq keys');
    const broken = upstream({ k1: 500 });
    const failing = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'k1,k2' }, fetch: broken.fetchFn });
    await expect(failing.stream({ model: 'groq/llama', messages: [] })).rejects.toThrow('status 500');
    expect(broken.used).toEqual(['k1']);
  });

  test('counts every key in the overview', () => {
    const rows = buildOverview({
      env: { GROQ_API_KEY: 'k1,k2', GEMINI_API_KEY: 'g1' },
      credentials: () => [{ id: 'groq-1', provider: 'groq', email: 'main', password: '', method: 'api-key', token: 's1' }],
      deepseekAccounts: () => [],
      accountStates: () => [],
      signIn: () => undefined,
      webSites: [],
      apiKeyProviders: API_KEY_PROVIDERS,
    });
    expect(rows.find(row => row.id === 'groq')?.detail).toBe('3 API keys (2 environment, 1 saved), rotated on limits');
    expect(rows.find(row => row.id === 'gemini')?.detail).toBe('API key (environment)');
  });
});
