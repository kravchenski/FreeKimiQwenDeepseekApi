import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { DecisionLog, type RoutingDecision } from '../src/core/router/decisions.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';

function provider(id: string, behaviour: 'ok' | 'fail' | 'down', delayMs = 0): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => behaviour === 'down' ? { available: false, reason: 'no key' } : { available: true },
    async stream(request) {
      await Bun.sleep(delayMs);
      if (behaviour === 'fail') throw new ProviderError(`${id} broke`, 'upstream', 502);
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
    },
  };
}

function setup(mode: 'fallback' | 'race', providers: Provider[], models: string[]) {
  const log = new DecisionLog(3);
  const registry = new ProviderRegistry();
  for (const entry of providers) registry.register(entry);
  const router = new SmartRouter(registry, models, () => 1_000, { autoMode: () => mode, autoEnabled: id => id !== 'off', onDecision: decision => log.add(decision) });
  return { router, log };
}

const build = (route: { model: string }) => ({ model: route.model, messages: [] });

describe('routing decisions', () => {
  test('records skipped candidates, failed attempts and the chosen route', async () => {
    const { router, log } = setup('fallback', [provider('down', 'down'), provider('off', 'ok'), provider('bad', 'fail'), provider('good', 'ok')], ['down-model', 'off-model', 'bad-model', 'good-model']);
    await router.open('auto', build);
    const [decision] = log.list() as [RoutingDecision];
    expect(decision).toMatchObject({ id: 1, at: 1_000, requestedModel: 'auto', mode: 'fallback', chosen: { model: 'good-model', provider: 'good' } });
    expect(decision.skipped).toEqual([{ model: 'down-model', reason: 'down unavailable: no key' }, { model: 'off-model', reason: 'off is off in auto' }]);
    expect(decision.attempts.map(attempt => [attempt.model, attempt.outcome, attempt.error])).toEqual([['bad-model', 'failed', 'bad broke'], ['good-model', 'chosen', undefined]]);
  });

  test('records races with the winner and the routes that lost', async () => {
    const { router, log } = setup('race', [provider('slow', 'ok', 40), provider('fast', 'ok', 1), provider('bad', 'fail')], ['slow-model', 'fast-model', 'bad-model']);
    await router.open('auto', build);
    const [decision] = log.list() as [RoutingDecision];
    expect(decision.mode).toBe('race');
    expect(Object.fromEntries(decision.attempts.map(attempt => [attempt.model, attempt.outcome]))).toEqual({ 'slow-model': 'lost', 'fast-model': 'chosen', 'bad-model': 'failed' });
  });

  test('records failed direct requests and keeps only the newest decisions', async () => {
    const { router, log } = setup('fallback', [provider('bad', 'fail'), provider('good', 'ok')], ['good-model']);
    await expect(router.open('bad-model', build)).rejects.toThrow('bad broke');
    for (let index = 0; index < 3; index++) await router.open('good-model', build);
    expect(log.list().map(decision => decision.id)).toEqual([4, 3, 2]);
    expect(log.list(10, 'bad-model')).toEqual([]);
    expect(log.list(1)[0]).toMatchObject({ mode: 'direct', chosen: { model: 'good-model' } });
    const failed = setup('fallback', [provider('bad', 'fail')], []);
    await expect(failed.router.open('bad-model', build)).rejects.toThrow();
    expect(failed.log.list()[0]).toMatchObject({ mode: 'direct', error: 'bad broke', attempts: [{ model: 'bad-model', outcome: 'failed' }] });
  });
});
