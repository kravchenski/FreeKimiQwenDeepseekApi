import { describe, expect, test } from 'bun:test';

import { ModelAvailability } from '../src/core/models/availability.ts';
import { classifyStatus, ProviderError, toHttpError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { Metrics } from '../src/observability/metrics.ts';
import { createNvidiaProvider } from '../src/providers/catalog.ts';

function modelsFetch(ids: string[], ok = true) {
  return (async () => ok
    ? Response.json({ data: ids.map(id => ({ id })) })
    : new Response('down', { status: 500 })) as unknown as typeof fetch;
}

function fakeProvider(id: string, models: string[], failing: Record<string, ProviderError>, calls: string[]): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => models.includes(model),
    listModels: async () => models,
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request) {
      calls.push(request.model);
      const failure = failing[request.model];
      if (failure) throw failure;
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
    },
  };
}

describe('model availability', () => {
  test('classifies missing models as model_unavailable and maps them to 404', () => {
    expect(classifyStatus(404, 'Function "abc": Not found for account \'xyz\'')).toBe('model_unavailable');
    expect(classifyStatus(410, 'Gone')).toBe('model_unavailable');
    expect(classifyStatus(404, 'The model `x` does not exist')).toBe('model_unavailable');
    expect(classifyStatus(404, 'route missing')).toBe('upstream');
    const http = toHttpError(new ProviderError('gone', 'model_unavailable', 410));
    expect(http.status).toBe(404);
    expect(http.type).toBe('model_not_found');
  });

  test('hides a model until the ttl passes', () => {
    let now = 0;
    const availability = new ModelAvailability(1_000, () => now);
    let changes = 0;
    availability.onChange(() => { changes += 1; });
    availability.markUnavailable('m', 'gone');
    expect(availability.isAvailable('m')).toBeFalse();
    expect(availability.list().map(entry => entry.model)).toEqual(['m']);
    expect(changes).toBe(1);
    now = 1_001;
    expect(availability.isAvailable('m')).toBeTrue();
    expect(availability.list()).toEqual([]);
  });

  test('NVIDIA lists every chat model upstream returns and supports them', async () => {
    const provider = createNvidiaProvider({
      env: { NVIDIA_API_KEY: 'k' },
      fetch: modelsFetch(['meta/llama-4-maverick', 'mistralai/mistral-large-3', 'nvidia/nv-embed-v2', 'z-ai/glm-5.3']),
    });
    expect(provider.supports('meta/llama-4-maverick')).toBeFalse();
    expect(await provider.listModels()).toEqual(['meta/llama-4-maverick', 'mistralai/mistral-large-3', 'z-ai/glm-5.3']);
    expect(provider.supports('meta/llama-4-maverick')).toBeTrue();
    expect(provider.supports('nvidia/nv-embed-v2')).toBeTrue();
    expect(provider.supports('google/unlisted')).toBeFalse();
  });

  test('NVIDIA keeps fallback models and prefixes when discovery fails', async () => {
    const provider = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'k' }, fetch: modelsFetch([], false) });
    expect(await provider.listModels()).toContain('moonshotai/kimi-k3');
    expect(provider.supports('meta/llama-4-maverick')).toBeFalse();
    expect(provider.supports('deepseek-ai/deepseek-v4.1-flash')).toBeTrue();
  });

  test('registry hides unavailable models from listings but still resolves them', async () => {
    const registry = new ProviderRegistry().register(fakeProvider('p', ['a', 'b'], {}, []));
    registry.availability.markUnavailable('a', 'gone');
    expect((await registry.listModels()).map(entry => entry.id)).toEqual(['b']);
    expect(registry.resolve('a')?.id).toBe('p');
  });

  test('auto skips a missing model without cooling down its provider', async () => {
    const calls: string[] = [];
    const registry = new ProviderRegistry().register(fakeProvider('p', ['gone', 'works'], {
      gone: new ProviderError('Not found for account', 'model_unavailable', 404),
    }, calls));
    const router = new SmartRouter(registry, ['gone', 'works']);
    const opened = await router.open('auto', route => ({ model: route.model, messages: [] }));
    expect(opened.route.model).toBe('works');
    expect(registry.availability.isAvailable('gone')).toBeFalse();
    expect(router.routes('auto').map(route => route.model)).toEqual(['works']);
    expect((await collectChunks(opened.chunks)).content).toBe('works');
    await router.open('auto', route => ({ model: route.model, messages: [] }));
    expect(calls).toEqual(['gone', 'works', 'works']);
  });

  test('an explicit request for a missing model marks it and rethrows', async () => {
    const registry = new ProviderRegistry().register(fakeProvider('p', ['gone'], {
      gone: new ProviderError('Gone', 'model_unavailable', 410),
    }, []));
    const router = new SmartRouter(registry, ['gone']);
    await expect(router.open('gone', route => ({ model: route.model, messages: [] }))).rejects.toThrow('Gone');
    expect(registry.availability.isAvailable('gone')).toBeFalse();
  });

  test('metrics expose unavailable models', () => {
    const text = new Metrics().render({ providers: [], accounts: [], unavailableModels: [{ model: 'moonshotai/kimi-k2.6' }] });
    expect(text).toContain('gateway_model_unavailable{model="moonshotai/kimi-k2.6"} 1');
  });
});
