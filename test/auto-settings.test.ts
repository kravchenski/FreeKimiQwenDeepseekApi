import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { ModelStats } from '../src/core/models/stats.ts';
import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { buildAutoChain } from '../src/core/router/auto-chain.ts';
import { focusPreference } from '../src/core/router/focus.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { GatewaySettings } from '../src/core/settings/gateway-settings.ts';
import { loadGatewaySetting, openDatabase, saveGatewaySetting } from '../src/core/store/database.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const nvidia = (ids: string[]) => ids.map(id => ({ id, provider: 'nvidia', fallback: true }));

describe('auto focus', () => {
  test('moves models that match the focus ahead inside each group', () => {
    const stats = new ModelStats(() => 0);
    stats.recordSuccess('meta/llama-4', 100);
    stats.recordSuccess('qwen/qwen3-coder-480b', 900);
    stats.recordSuccess('deepseek-ai/deepseek-r1', 500);
    const candidates = nvidia(['meta/llama-4', 'qwen/qwen3-coder-480b', 'deepseek-ai/deepseek-r1', 'mistralai/codestral-22b', 'nvidia/nemotron-flash']);
    expect(buildAutoChain(candidates, stats)).toEqual(['meta/llama-4', 'deepseek-ai/deepseek-r1', 'qwen/qwen3-coder-480b', 'mistralai/codestral-22b', 'nvidia/nemotron-flash']);
    expect(buildAutoChain(candidates, stats, () => true, focusPreference('coding')))
      .toEqual(['qwen/qwen3-coder-480b', 'meta/llama-4', 'deepseek-ai/deepseek-r1', 'mistralai/codestral-22b', 'nvidia/nemotron-flash']);
    expect(buildAutoChain(candidates, stats, () => true, focusPreference('reasoning'))[0]).toBe('deepseek-ai/deepseek-r1');
    expect(buildAutoChain(candidates, stats, () => true, focusPreference('fast')).slice(3)).toEqual(['nvidia/nemotron-flash', 'mistralai/codestral-22b']);
  });

  test('picks the focused model of a web chat provider', () => {
    const web = ['deepseek-default', 'deepseek-reasoner', 'deepseek-search'].map(id => ({ id, provider: 'deepseek', fallback: false }));
    expect(buildAutoChain(web, new ModelStats())).toEqual(['deepseek-default']);
    expect(buildAutoChain(web, new ModelStats(), () => true, focusPreference('reasoning'))).toEqual(['deepseek-reasoner']);
  });
});

describe('gateway settings', () => {
  test('defaults to general fallback, validates changes and persists them', () => {
    const db = openDatabase(':memory:');
    const settings = new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: (key, value) => saveGatewaySetting(db, key, value) });
    expect(settings.autoFocus()).toBe('general');
    expect(settings.autoMode()).toBe('fallback');
    settings.setAutoFocus('coding');
    settings.setAutoMode('race');
    expect(loadGatewaySetting(db, 'auto.focus')).toBe('coding');
    expect(new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: () => {} }).autoMode()).toBe('race');
    expect(() => settings.setAutoFocus('poetry')).toThrow('Unknown focus: poetry');
    expect(() => settings.setAutoMode('parallel')).toThrow('Unknown mode: parallel');
  });

  test('ignores unknown stored values and store failures', () => {
    expect(new GatewaySettings({ load: () => 'weird', save: () => {} }).autoFocus()).toBe('general');
    expect(new GatewaySettings({ load: () => { throw new Error('locked'); }, save: () => {} }).autoMode()).toBe('fallback');
  });
});

function racer(id: string, delayMs: number, events: string[], fail = false): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request, context) {
      events.push(`start ${id}`);
      context?.signal?.addEventListener('abort', () => events.push(`abort ${id}`));
      await Bun.sleep(delayMs);
      if (fail) throw new ProviderError(`${id} broke`, 'upstream', 502);
      return {
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          try {
            yield { type: 'content', text: request.model };
          } finally {
            events.push(`closed ${id}`);
          }
        })(),
      };
    },
  };
}

describe('race mode', () => {
  test('sends to several routes at once, keeps the first answer and cancels the rest', async () => {
    const events: string[] = [];
    const registry = new ProviderRegistry().register(racer('slow', 80, events)).register(racer('fast', 10, events)).register(racer('broken', 5, events, true));
    const router = new SmartRouter(registry, ['slow-model', 'fast-model', 'broken-model'], Date.now, { autoMode: () => 'race' });
    const opened = await router.open('auto', route => ({ model: route.model, messages: [] }));
    expect(opened.route.model).toBe('fast-model');
    expect((await collectChunks(opened.chunks)).content).toBe('fast-model');
    expect(events.slice(0, 3).sort()).toEqual(['start broken', 'start fast', 'start slow']);
    expect(events).toContain('abort slow');
    await Bun.sleep(120);
    expect(events).toContain('closed slow');
    expect(registry.stats.get('fast-model')?.lastOutcome).toBe('success');
    expect(registry.stats.get('broken-model')?.lastOutcome).toBe('failure');
    expect(registry.stats.get('slow-model')).toBeUndefined();
  });

  test('reports every failure when all raced routes fail and ignores race mode for explicit models', async () => {
    const events: string[] = [];
    const registry = new ProviderRegistry().register(racer('a', 5, events, true)).register(racer('b', 5, events, true));
    const router = new SmartRouter(registry, ['a-model', 'b-model'], Date.now, { autoMode: () => 'race' });
    await expect(router.open('auto', route => ({ model: route.model, messages: [] }))).rejects.toThrow(/All raced routes failed for model auto: .*a broke.*b broke|All raced routes failed for model auto: .*b broke.*a broke/);
    const single = new SmartRouter(new ProviderRegistry().register(racer('c', 1, events)), ['c-model'], Date.now, { autoMode: () => 'race' });
    expect((await single.open('c-model', route => ({ model: route.model, messages: [] }))).route.model).toBe('c-model');
  });
});

describe('accounts CLI auto command', () => {
  test('shows and changes the focus and mode', async () => {
    const lines: string[] = [];
    let current = { focus: 'general', mode: 'fallback' };
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      autoSettings: change => {
        current = { focus: change.focus ?? current.focus, mode: change.mode ?? current.mode };
        return current;
      },
    };
    await runAccountsCommand(['auto', '--focus', 'coding', '--mode', 'race'], deps);
    expect(lines).toEqual(['auto focus: coding', 'auto mode: race']);
  });
});
