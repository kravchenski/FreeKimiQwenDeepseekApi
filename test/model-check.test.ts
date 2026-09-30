import { describe, expect, test } from 'bun:test';

import { ModelAvailability } from '../src/core/models/availability.ts';
import { checkProviderModels } from '../src/core/models/model-check.ts';
import { ModelStats } from '../src/core/models/stats.ts';
import { classifyStatus, ProviderError } from '../src/core/providers/errors.ts';
import { loadUnavailableModels, openDatabase, replaceUnavailableModels } from '../src/core/store/database.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { createApiProvider, apiKeyProvider } from '../src/providers/catalog.ts';

function fakeProvider(behaviour: Record<string, 'ok' | 'denied' | 'slow' | 'broken' | 'limited'>, seen: string[] = []): Provider {
  return {
    id: 'fake',
    ownedBy: 'fake',
    supports: () => true,
    listModels: async () => Object.keys(behaviour),
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request, context) {
      seen.push(request.model);
      const kind = behaviour[request.model];
      if (kind === 'denied') throw new ProviderError('Model is unavailable for this key', 'model_unavailable', 404);
      if (kind === 'broken') throw new ProviderError('upstream broke', 'upstream', 502);
      if (kind === 'limited') throw new ProviderError('rate limited', 'rate_limit', 429);
      return {
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          if (kind === 'slow') await new Promise(resolve => context?.signal?.addEventListener('abort', resolve));
          yield { type: 'content', text: 'ok' };
        })(),
      };
    },
  };
}

describe('model check', () => {
  test('hides models the key cannot use and records the rest', async () => {
    const availability = new ModelAvailability();
    const stats = new ModelStats();
    availability.markUnavailable('fake/a', 'old mark');
    const report = await checkProviderModels(fakeProvider({ 'fake/a': 'ok', 'fake/b': 'denied', 'fake/c': 'slow', 'fake/d': 'broken' }), ['fake/a', 'fake/b', 'fake/c', 'fake/d'], { availability, stats }, { timeoutMs: 50 });
    const byModel = Object.fromEntries(report.results.map(result => [result.model, result]));
    expect(byModel['fake/a']).toMatchObject({ ok: true });
    expect(byModel['fake/b']).toMatchObject({ ok: false, hidden: true });
    expect(byModel['fake/c']).toMatchObject({ ok: false, error: 'no answer within 0s' });
    expect(byModel['fake/d']?.hidden).toBeUndefined();
    expect(availability.isAvailable('fake/a')).toBeTrue();
    expect(availability.isAvailable('fake/b')).toBeFalse();
    expect(availability.isAvailable('fake/c')).toBeTrue();
    expect(stats.get('fake/a')?.lastOutcome).toBe('success');
    expect(stats.get('fake/d')?.lastOutcome).toBe('failure');
  });

  test('keeps going after one model is rate limited and stops after three limits in a row', async () => {
    const seen: string[] = [];
    const single = await checkProviderModels(fakeProvider({ 'fake/a': 'limited', 'fake/b': 'ok' }, seen), ['fake/a', 'fake/b'], { availability: new ModelAvailability(), stats: new ModelStats() }, { concurrency: 1 });
    expect(single.stopped).toBeUndefined();
    expect(single.results.map(result => result.ok)).toEqual([false, true]);
    const models = { 'fake/a': 'limited', 'fake/b': 'limited', 'fake/c': 'limited', 'fake/d': 'ok' } as const;
    seen.length = 0;
    const burst = await checkProviderModels(fakeProvider(models, seen), Object.keys(models), { availability: new ModelAvailability(), stats: new ModelStats() }, { concurrency: 1 });
    expect(burst.stopped).toBe('rate limited');
    expect(seen).toEqual(['fake/a', 'fake/b', 'fake/c']);
  });

  test('treats "model not available for this key" answers as unavailable models', () => {
    expect(classifyStatus(400, '{"error":{"message":"Upstream request failed: Model is unavailable."}}')).toBe('model_unavailable');
    expect(classifyStatus(403, 'You do not have access to the model gpt-5')).toBe('model_unavailable');
    expect(classifyStatus(400, 'Invalid model. Please select a different model')).toBe('model_unavailable');
    expect(classifyStatus(402, '{"error":{"message":"this model is not included in your free usage"}}')).toBe('model_unavailable');
    expect(classifyStatus(403, 'thinkingmachines/inkling-small:free is only available to accounts with credits')).toBe('model_unavailable');
    expect(classifyStatus(402, 'Insufficient balance')).toBe('quota_exhausted');
    expect(classifyStatus(403, 'Forbidden')).toBe('auth');
    expect(classifyStatus(400, 'max_tokens is too large')).toBe('upstream');
  });

  test('a provider without a key lists no models', async () => {
    const bigmodel = createApiProvider(apiKeyProvider('bigmodel')!, { env: {} });
    expect(await bigmodel.listModels()).toEqual([]);
    const cloudflare = createApiProvider(apiKeyProvider('cloudflare')!, { env: {} }, { list: () => [] });
    expect(await cloudflare.listModels()).toEqual([]);
  });

  test('keeps unavailable models across restarts until they expire', () => {
    const db = openDatabase(':memory:');
    const availability = new ModelAvailability(1_000, () => 5_000);
    availability.markUnavailable('nvidia/old-model', 'Function not found for account');
    replaceUnavailableModels(db, availability.list());
    expect(loadUnavailableModels(db, 5_500)).toEqual([{ model: 'nvidia/old-model', reason: 'Function not found for account', until: 6_000 }]);
    expect(loadUnavailableModels(db, 6_500)).toEqual([]);
    const restarted = new ModelAvailability(1_000, () => 5_500);
    restarted.load(loadUnavailableModels(db, 5_500));
    expect(restarted.isAvailable('nvidia/old-model')).toBeFalse();
  });
});
