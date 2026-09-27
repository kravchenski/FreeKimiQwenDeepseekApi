import { describe, expect, test } from 'bun:test';

import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { ModelStats, rankModels } from '../src/core/models/stats.ts';
import { buildAutoChain } from '../src/core/router/auto-chain.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const web = (provider: string, ids: string[]) => ids.map(id => ({ id, provider, fallback: false }));
const nvidia = (ids: string[]) => ids.map(id => ({ id, provider: 'nvidia', fallback: true }));

function measured(entries: Record<string, number | 'fail'>) {
  const stats = new ModelStats(() => 0);
  for (const [model, latency] of Object.entries(entries)) {
    if (latency === 'fail') stats.recordFailure(model);
    else stats.recordSuccess(model, latency);
  }
  return stats;
}

describe('buildAutoChain', () => {
  test('without measurements keeps one default model per web provider, then fallback models in listed order', () => {
    const chain = buildAutoChain([
      ...nvidia(['n1', 'n2']),
      ...web('qwen', ['qwen-a', 'qwen-b']),
      ...web('deepseek', ['ds-default', 'ds-reasoner']),
      ...web('glm-chat', ['glm-chat']),
    ], new ModelStats());
    expect(chain).toEqual(['qwen-a', 'ds-default', 'glm-chat', 'n1', 'n2']);
  });

  test('orders by measured first-chunk latency, then unmeasured, then failing models', () => {
    const stats = measured({ n1: 'fail', n2: 900, n4: 200, 'glm-chat': 27_000, 'ds-default': 1_000, 'qwen-b': 500 });
    const chain = buildAutoChain([
      ...nvidia(['n1', 'n2', 'n3', 'n4']),
      ...web('qwen', ['qwen-a', 'qwen-b']),
      ...web('deepseek', ['ds-default']),
      ...web('glm-chat', ['glm-chat']),
    ], stats);
    expect(chain).toEqual(['qwen-b', 'ds-default', 'glm-chat', 'n4', 'n2', 'n3', 'n1']);
  });

  test('skips unavailable models and caps fallback models', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
    const chain = buildAutoChain(nvidia(ids), new ModelStats(), model => model !== 'n0');
    expect(chain).toEqual(ids.slice(1, 9));
  });

  test('returns an empty chain when nothing is listed', () => {
    expect(buildAutoChain([], new ModelStats())).toEqual([]);
  });
});

describe('ModelStats', () => {
  test('smooths latency and remembers the last outcome', () => {
    const stats = new ModelStats(() => 5);
    const seen: string[] = [];
    stats.onChange(stat => seen.push(`${stat.model}:${stat.lastOutcome}`));
    stats.recordSuccess('m', 1_000);
    stats.recordSuccess('m', 2_000);
    expect(stats.get('m')).toEqual({ model: 'm', successes: 2, failures: 0, latencyMs: 1_300, lastOutcome: 'success', updatedAt: 5 });
    stats.recordFailure('m');
    expect(stats.get('m')).toMatchObject({ successes: 2, failures: 1, latencyMs: 1_300, lastOutcome: 'failure' });
    expect(seen).toEqual(['m:success', 'm:success', 'm:failure']);
  });

  test('ranks models without touching unknown ones', () => {
    expect(rankModels(['a', 'b', 'c'], measured({ c: 10, a: 'fail' }))).toEqual(['c', 'b', 'a']);
  });
});

function provider(hanging: string[], calls: string[]): Provider {
  return {
    id: 'p',
    ownedBy: 'p',
    supports: () => true,
    listModels: async () => [],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request, context) {
      calls.push(request.model);
      if (hanging.includes(request.model)) {
        await new Promise((_, reject) => context?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
    },
  };
}

describe('SmartRouter auto chain', () => {
  test('falls through a model that does not answer in time and cools only that model down', async () => {
    const calls: string[] = [];
    const registry = new ProviderRegistry().register(provider(['slow'], calls));
    const router = new SmartRouter(registry, ['slow', 'fast'], Date.now, { firstChunkTimeoutMs: 20 });
    const opened = await router.open('auto', route => ({ model: route.model, messages: [] }));
    expect((await collectChunks(opened.chunks)).content).toBe('fast');
    expect(router.routes('auto').map(route => route.model)).toEqual(['fast']);
    expect(calls).toEqual(['slow', 'fast']);
    expect(registry.stats.get('slow')?.lastOutcome).toBe('failure');
    expect(registry.stats.get('fast')).toMatchObject({ successes: 1, lastOutcome: 'success' });
  });

  test('does not time out an explicit single-model request', async () => {
    const registry = new ProviderRegistry().register(provider([], []));
    const router = new SmartRouter(registry, ['a'], Date.now, { firstChunkTimeoutMs: 1 });
    const opened = await router.open('a', route => ({ model: route.model, messages: [] }));
    expect((await collectChunks(opened.chunks)).content).toBe('a');
  });

  test('replaces the chain but keeps the current one when the new chain is empty', () => {
    const router = new SmartRouter(new ProviderRegistry().register(provider([], [])), ['a']);
    router.setAutoModels(['b', 'c']);
    expect(router.autoChain()).toEqual(['b', 'c']);
    router.setAutoModels([]);
    expect(router.autoChain()).toEqual(['b', 'c']);
  });
});
