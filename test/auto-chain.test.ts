import { describe, expect, test } from 'bun:test';

import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { buildAutoChain } from '../src/core/router/auto-chain.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const web = [
  { id: 'qwen-web-dev', provider: 'qwen' },
  { id: 'qwen3.6-plus', provider: 'qwen' },
  { id: 'qwen3.7-plus', provider: 'qwen' },
  { id: 'deepseek-reasoner', provider: 'deepseek' },
  { id: 'deepseek-default', provider: 'deepseek' },
  { id: 'glm-chat', provider: 'glm-chat' },
  { id: 'kimi-chat', provider: 'kimi-chat' },
];

const nvidia = [
  'google/gemma-4', 'meta/llama-4-maverick', 'mistralai/mistral-large-3', 'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b', 'nvidia/cosmos', 'z-ai/glm-5.3', 'deepseek-ai/deepseek-v4.1-flash',
  'deepseek-ai/deepseek-v4', 'deepseek-ai/deepseek-r2', 'moonshotai/kimi-k3', 'qwen/qwen3-coder-480b',
].map(id => ({ id, provider: 'nvidia' }));

describe('buildAutoChain', () => {
  test('puts web chats first, then NVIDIA by family with at most two per family', () => {
    expect(buildAutoChain([...nvidia, ...web])).toEqual([
      'qwen3.7-plus', 'deepseek-default', 'glm-chat', 'kimi-chat',
      'deepseek-ai/deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4', 'moonshotai/kimi-k3', 'z-ai/glm-5.3',
      'qwen/qwen3-coder-480b', 'nvidia/nemotron-3-super-120b-a12b', 'nvidia/llama-3.1-nemotron-70b', 'meta/llama-4-maverick',
    ]);
  });

  test('skips unavailable models and missing providers', () => {
    const chain = buildAutoChain(
      [{ id: 'qwen3.6-plus', provider: 'qwen' }, ...nvidia],
      model => model !== 'deepseek-ai/deepseek-v4.1-flash',
    );
    expect(chain[0]).toBe('qwen3.6-plus');
    expect(chain).not.toContain('deepseek-ai/deepseek-v4.1-flash');
    expect(chain).not.toContain('glm-chat');
    expect(chain[1]).toBe('deepseek-ai/deepseek-v4');
  });

  test('returns an empty chain when nothing is listed', () => {
    expect(buildAutoChain([])).toEqual([]);
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
