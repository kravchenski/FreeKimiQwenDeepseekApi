import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { DEFAULT_AUTO_MODELS, parseAutoModels, SmartRouter } from '../src/core/router/smart-router.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

type Behavior = 'ok' | 'fail-open' | 'fail-first-chunk' | 'fail-mid-stream' | 'empty';

function provider(id: string, behavior: () => Behavior, available = true, calls: string[] = []): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => model.startsWith(`${id}-`),
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available }),
    async stream(request) {
      calls.push(request.model);
      const mode = behavior();
      if (mode === 'fail-open') throw new ProviderError(`${id} limited`, 'rate_limit', 429);
      return {
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          if (mode === 'fail-first-chunk') throw new Error(`${id} reset`);
          if (mode === 'empty') return;
          yield { type: 'content', text: `${id}:1 ` };
          if (mode === 'fail-mid-stream') throw new Error(`${id} dropped`);
          yield { type: 'content', text: `${id}:2` };
        })(),
      };
    },
  };
}

function setup(behaviors: Record<string, Behavior>, unavailable: string[] = []) {
  let now = 0;
  const calls: string[] = [];
  const registry = new ProviderRegistry();
  for (const id of Object.keys(behaviors)) {
    registry.register(provider(id, () => behaviors[id]!, !unavailable.includes(id), calls));
  }
  const router = new SmartRouter(registry, Object.keys(behaviors).map(id => `${id}-model`), () => now);
  const open = (model: string) => router.open(model, route => ({ model: route.model, messages: [] }));
  return { router, calls, open, advance: (ms: number) => { now += ms; } };
}

describe('SmartRouter', () => {
  test('auto uses the first healthy route', async () => {
    const { open, calls } = setup({ a: 'ok', b: 'ok' }, ['a']);
    const routed = await open('auto');
    expect(routed.route.model).toBe('b-model');
    expect(await collectChunks(routed.chunks)).toEqual({ content: 'b:1 b:2', reasoning: '' });
    expect(calls).toEqual(['b-model']);
  });

  test('auto falls back when a provider fails to open or before the first chunk', async () => {
    const { open, calls } = setup({ a: 'fail-open', b: 'fail-first-chunk', c: 'ok' });
    const routed = await open('auto');
    expect(routed.route.model).toBe('c-model');
    expect(calls).toEqual(['a-model', 'b-model', 'c-model']);
  });

  test('does not switch providers after output has started', async () => {
    const { open } = setup({ a: 'fail-mid-stream', b: 'ok' });
    const routed = await open('auto');
    expect(routed.route.model).toBe('a-model');
    await expect(collectChunks(routed.chunks)).rejects.toThrow('a dropped');
  });

  test('keeps empty streams as valid responses', async () => {
    const { open } = setup({ a: 'empty', b: 'ok' });
    const routed = await open('auto');
    expect(routed.route.model).toBe('a-model');
    expect(await collectChunks(routed.chunks)).toEqual({ content: '', reasoning: '' });
  });

  test('cools down failed providers for auto routing', async () => {
    const behaviors: Record<string, Behavior> = { a: 'fail-open', b: 'ok' };
    const { open, calls, advance } = setup(behaviors);
    await open('auto');
    behaviors.a = 'ok';
    calls.length = 0;
    expect((await open('auto')).route.model).toBe('b-model');
    advance(30_000);
    expect((await open('auto')).route.model).toBe('a-model');
    expect(calls).toEqual(['b-model', 'a-model']);
  });

  test('explicit models never switch providers and keep the original error', async () => {
    const { open, calls } = setup({ a: 'fail-open', b: 'ok' });
    const error = await open('a-model').catch(caught => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('rate_limit');
    expect(calls).toEqual(['a-model']);
  });

  test('reports every failure when all auto routes fail', async () => {
    const { open } = setup({ a: 'fail-open', b: 'fail-first-chunk' });
    await expect(open('auto')).rejects.toThrow(/All routes failed for model auto: a-model: a limited; b-model: b reset/);
    await expect(open('auto')).rejects.toThrow('No available provider for model auto');
  });

  test('knows auto and registered models only', () => {
    const { router } = setup({ a: 'ok' });
    expect(router.knows('auto')).toBeTrue();
    expect(router.knows('a-anything')).toBeTrue();
    expect(router.knows('gpt-4')).toBeFalse();
  });
});

describe('parseAutoModels', () => {
  test('parses a comma list and falls back to defaults', () => {
    expect(parseAutoModels(' qwen3.8-max, glm-5.2-free ,')).toEqual(['qwen3.8-max', 'glm-5.2-free']);
    expect(parseAutoModels('')).toEqual(DEFAULT_AUTO_MODELS);
    expect(parseAutoModels(undefined)).toEqual(DEFAULT_AUTO_MODELS);
  });
});
