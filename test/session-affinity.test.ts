import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { conversationKey, SessionAffinity } from '../src/core/router/session-affinity.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { openDatabase } from '../src/core/store/database.ts';

describe('conversationKey', () => {
  test('stays stable while an agent session grows and differs between sessions', () => {
    const turn1 = [{ role: 'system', content: 'You are a coding agent' }, { role: 'user', content: 'fix the bug' }];
    const turn3 = [...turn1, { role: 'assistant', content: 'reading files' }, { role: 'tool', content: 'file body' }, { role: 'user', content: 'go on' }];
    expect(conversationKey(turn3)).toBe(conversationKey(turn1));
    expect(conversationKey([{ role: 'user', content: 'another task' }])).not.toBe(conversationKey(turn1));
    expect(conversationKey([{ role: 'system', content: 'only system' }])).toBeUndefined();
  });
});

describe('SessionAffinity', () => {
  test('remembers the route per conversation and requested model until it expires', () => {
    let now = 0;
    const affinity = new SessionAffinity(openDatabase(':memory:'), 1_000, () => now);
    affinity.set('c1', 'auto', { provider: 'deepseek', model: 'deepseek-default' });
    expect(affinity.get('c1', 'auto')).toEqual({ provider: 'deepseek', model: 'deepseek-default' });
    expect(affinity.get('c1', 'other')).toBeUndefined();
    affinity.set('c1', 'auto', { provider: 'glm-chat', model: 'glm-chat' });
    expect(affinity.get('c1', 'auto')?.model).toBe('glm-chat');
    now = 1_000;
    expect(affinity.get('c1', 'auto')).toBeUndefined();
    expect(affinity.prune()).toBe(1);
  });
});

describe('auto routing with session affinity', () => {
  function provider(id: string, fail: () => boolean): Provider {
    return {
      id,
      ownedBy: id,
      supports: model => model === `${id}-model`,
      listModels: async () => [`${id}-model`],
      capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
      health: () => ({ available: true }),
      async stream() {
        if (fail()) throw new ProviderError(`${id} down`, 'unavailable');
        return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: id }; })() };
      },
    };
  }

  test('keeps a session on the provider it failed over to, even after the first one recovers', async () => {
    let now = 0;
    let primaryDown = true;
    const registry = new ProviderRegistry()
      .register(provider('primary', () => primaryDown))
      .register(provider('backup', () => false));
    const router = new SmartRouter(registry, ['primary-model', 'backup-model'], () => now);
    const affinity = new SessionAffinity(openDatabase(':memory:'), 60_000, () => now);
    const turn = async (session: string) => {
      const pinned = affinity.get(session, 'auto');
      const routed = await router.open('auto', route => ({ model: route.model, messages: [] }), pinned?.model);
      affinity.set(session, 'auto', { provider: routed.route.provider.id, model: routed.route.model });
      return routed.route.model;
    };

    expect(await turn('agent-1')).toBe('backup-model');
    primaryDown = false;
    now += 31_000;
    expect(await turn('agent-1')).toBe('backup-model');
    expect(await turn('agent-2')).toBe('primary-model');
  });
});
