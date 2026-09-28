import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { ProviderSettings, type ProviderSetting } from '../src/core/providers/settings.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { loadProviderSetting, openDatabase, saveProviderSetting } from '../src/core/store/database.ts';

function provider(id: string): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => model.startsWith(`${id}-`),
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request) {
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
    },
  };
}

describe('provider settings', () => {
  test('providers are in auto by default and can be switched off and on', () => {
    let now = 0;
    const saved = new Map<string, ProviderSetting>();
    const settings = new ProviderSettings({ load: id => saved.get(id), save: setting => { saved.set(setting.provider, setting); } }, () => now);
    expect(settings.autoEnabled('nvidia')).toBeTrue();
    settings.setAuto('nvidia', false);
    expect(settings.autoEnabled('nvidia')).toBeFalse();
    expect(saved.get('nvidia')).toEqual({ provider: 'nvidia', auto: false, updatedAt: 0 });
    saved.set('nvidia', { provider: 'nvidia', auto: true, updatedAt: 1 });
    expect(settings.autoEnabled('nvidia')).toBeFalse();
    now = 30_000;
    expect(settings.autoEnabled('nvidia')).toBeTrue();
  });

  test('a failing store keeps providers in auto', () => {
    const settings = new ProviderSettings({ load: () => { throw new Error('locked'); }, save: () => {} });
    expect(settings.autoEnabled('glm-chat')).toBeTrue();
  });

  test('persists settings in the gateway database', () => {
    const db = openDatabase(':memory:');
    saveProviderSetting(db, { provider: 'kimi-chat', auto: false, updatedAt: 5 });
    saveProviderSetting(db, { provider: 'kimi-chat', auto: true, updatedAt: 6 });
    expect(loadProviderSetting(db, 'kimi-chat')).toEqual({ provider: 'kimi-chat', auto: true, updatedAt: 6 });
    expect(loadProviderSetting(db, 'nvidia')).toBeUndefined();
  });

  test('auto skips providers that are switched off but explicit requests still work', async () => {
    const registry = new ProviderRegistry().register(provider('a')).register(provider('b'));
    const off = new Set(['a']);
    const router = new SmartRouter(registry, ['a-model', 'b-model'], Date.now, { autoEnabled: id => !off.has(id) });
    expect(router.routes('auto').map(route => route.model)).toEqual(['b-model']);
    expect((await router.open('a-model', route => ({ model: route.model, messages: [] }))).route.model).toBe('a-model');
    off.clear();
    expect(router.routes('auto').map(route => route.model)).toEqual(['a-model', 'b-model']);
  });
});

describe('accounts CLI provider command', () => {
  test('shows and changes the auto setting', async () => {
    const lines: string[] = [];
    const values = new Map<string, boolean>();
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      providerAuto: (id, auto) => {
        if (auto !== undefined) values.set(id, auto);
        return values.get(id) ?? true;
      },
    };
    expect(await runAccountsCommand(['provider', 'nvidia'], deps)).toBe(0);
    expect(await runAccountsCommand(['provider', 'nvidia', '--auto', 'off'], deps)).toBe(0);
    await expect(runAccountsCommand(['provider', 'nvidia', '--auto', 'maybe'], deps)).rejects.toThrow('--auto on or --auto off');
    expect(lines).toEqual(['nvidia auto: on', 'nvidia auto: off']);
  });
});
