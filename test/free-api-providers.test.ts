import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { buildOverview } from '../src/cli/overview.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { API_KEY_PROVIDERS, apiKeyProvider, createApiProvider, FREE_API_PROVIDERS, verifyProviderKey } from '../src/providers/catalog.ts';

function upstream(ids: string[]) {
  const calls: Array<{ url: string; body?: any; auth?: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>)?.Authorization });
    if (url.endsWith('/models')) return Response.json({ data: ids.map(id => ({ id })) });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\ndata: [DONE]\n\n`);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const definition = (id: string) => apiKeyProvider(id)!;

describe('free API providers', () => {
  test('lists OpenRouter free models under the provider namespace and sends the plain id upstream', async () => {
    const { fetchFn, calls } = upstream(['qwen/qwen3.8-27b:free', 'openai/gpt-5', 'meta/llama-guard:free', 'nvidia/nemotron-3.5-lightning:free']);
    const provider = createApiProvider(definition('openrouter'), { env: { OPENROUTER_API_KEY: 'or-key' }, fetch: fetchFn });
    expect(await provider.listModels()).toEqual(['openrouter/qwen/qwen3.8-27b:free', 'openrouter/nvidia/nemotron-3.5-lightning:free']);
    expect(provider.supports('openrouter/qwen/qwen3.8-27b:free')).toBeTrue();
    expect(provider.supports('qwen/qwen3.8-27b:free')).toBeFalse();
    const stream = await provider.stream({ model: 'openrouter/qwen/qwen3.8-27b:free', messages: [] });
    expect((await collectChunks(stream.chunks)).content).toBe('pong');
    expect(calls.at(-1)).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', body: { model: 'qwen/qwen3.8-27b:free' }, auth: 'Bearer or-key' });
  });

  test('normalizes Gemini ids and drops non-chat models', async () => {
    const { fetchFn, calls } = upstream(['models/gemini-2.5-flash', 'models/text-embedding-004', 'models/imagen-4', 'models/gemma-3-27b-it']);
    const gemini = createApiProvider(definition('gemini'), { env: { GEMINI_API_KEY: 'g' }, fetch: fetchFn });
    expect(await gemini.listModels()).toEqual(['gemini/gemini-2.5-flash', 'gemini/gemma-3-27b-it']);
    await gemini.stream({ model: 'gemini/gemini-2.5-flash', messages: [] });
    expect(calls.at(-1)?.body.model).toBe('gemini-2.5-flash');
  });

  test('drops speech, guard and embedding models from other providers', async () => {
    const { fetchFn } = upstream(['llama-3.3-70b-versatile', 'whisper-large-v3', 'meta-llama/llama-guard-4-12b', 'playai-tts']);
    const groq = createApiProvider(definition('groq'), { env: { GROQ_API_KEY: 'k' }, fetch: fetchFn });
    expect(await groq.listModels()).toEqual(['groq/llama-3.3-70b-versatile']);
  });

  test('is unavailable without a key and uses a saved key from the registry', async () => {
    const { fetchFn, calls } = upstream(['llama3.3-70b']);
    const cerebras = createApiProvider(definition('cerebras'), { env: {}, fetch: fetchFn });
    expect(cerebras.health()).toEqual({ available: false, reason: 'CEREBRAS_API_KEY is not set; or run: bun run account add cerebras --api-key' });
    expect(await cerebras.listModels()).toEqual([]);
    const saved = createApiProvider(definition('cerebras'), { env: {}, fetch: fetchFn }, { list: () => [{ method: 'api-key', token: 'saved' }] });
    expect(saved.health()).toEqual({ available: true });
    await saved.stream({ model: 'cerebras/llama3.3-70b', messages: [] });
    expect(calls.at(-1)?.auth).toBe('Bearer saved');
  });

  test('checks a key against the provider model list', async () => {
    const { fetchFn, calls } = upstream(['a', 'b']);
    expect(await verifyProviderKey(definition('mistral'), 'k', fetchFn)).toBe(2);
    expect(calls[0]?.url).toBe('https://api.mistral.ai/v1/models');
    const denied = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(verifyProviderKey(definition('sambanova'), 'k', denied)).rejects.toThrow('SambaNova key check failed: 401');
  });

  test('every provider has a unique id, an env variable and a key page', () => {
    const ids = API_KEY_PROVIDERS.map(provider => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['nvidia', 'openrouter', 'groq', 'gemini', 'cerebras', 'mistral', 'sambanova']);
    for (const provider of FREE_API_PROVIDERS) {
      expect(provider.apiKeyEnv).toMatch(/^[A-Z]+_API_KEY$/);
      expect(provider.keyUrl).toStartWith('https://');
      expect(provider.namespace).toBeTrue();
    }
  });
});

describe('API key providers in the overview and CLI', () => {
  test('shows one row per API key provider with its key page', () => {
    const rows = buildOverview({
      env: { GROQ_API_KEY: 'x' },
      credentials: () => [{ id: 'openrouter-1', provider: 'openrouter', email: 'main', password: '', method: 'api-key', token: 't' } satisfies Credential],
      deepseekAccounts: () => [],
      accountStates: () => [],
      signIn: () => undefined,
      webSites: [],
      apiKeyProviders: API_KEY_PROVIDERS,
    });
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    expect(byId.openrouter).toMatchObject({ state: 'connected', detail: 'API key (saved)', url: 'https://openrouter.ai/keys' });
    expect(byId.groq).toMatchObject({ state: 'connected', detail: 'API key (environment)' });
    expect(byId.gemini).toMatchObject({ state: 'not-connected', fix: 'bun run account add gemini --api-key' });
  });

  test('accepts API keys for the new providers', async () => {
    const saved: Array<{ provider: string; label: string }> = [];
    const lines: string[] = [];
    const deps: AccountsCliDeps = {
      store: {
        list: () => [],
        addApiKey: input => {
          saved.push({ provider: input.provider, label: input.label });
          return { id: `${input.provider}-1`, provider: input.provider, email: input.label, password: '', method: 'api-key', token: input.apiKey };
        },
        remove: () => false,
      },
      askHidden: async () => 'key',
      log: line => lines.push(line),
      verifyApiKey: async () => 17,
    };
    expect(await runAccountsCommand(['add', 'openrouter', '--api-key'], deps)).toBe(0);
    expect(saved).toEqual([{ provider: 'openrouter', label: 'default' }]);
    expect(lines[0]).toBe('Key works: 17 models available');
    await expect(runAccountsCommand(['add', 'unknown-ai', '--api-key'], deps)).rejects.toThrow('Unknown provider: unknown-ai');
  });
});
