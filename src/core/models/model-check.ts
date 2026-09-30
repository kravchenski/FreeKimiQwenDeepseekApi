import { ProviderError } from '../providers/errors.ts';
import type { Provider } from '../providers/provider.ts';
import type { ModelAvailability } from './availability.ts';
import type { ModelStats } from './stats.ts';

export interface ModelCheckResult {
  model: string;
  ok: boolean;
  hidden?: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ModelCheckReport {
  provider: string;
  results: ModelCheckResult[];
  stopped?: string;
}

export interface ModelCheckOptions {
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

const PROMPT = 'Reply with one word: ok';
const LIMIT_KINDS = new Set(['rate_limit', 'quota_exhausted']);
const LIMITS_BEFORE_STOP = 3;

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

async function firstChunk(provider: Provider, model: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderError(`no answer within ${Math.round(timeoutMs / 1000)}s`, 'unavailable')), timeoutMs);
  try {
    const { chunks } = await provider.stream({ model, messages: [{ role: 'user', content: PROMPT }] }, { signal: controller.signal });
    const iterator = chunks[Symbol.asyncIterator]();
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      if (next.done) throw new ProviderError('empty answer', 'upstream');
    } finally {
      await iterator.return?.();
    }
  } catch (error) {
    throw controller.signal.aborted && !(error instanceof ProviderError) ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkProviderModels(
  provider: Provider,
  models: string[],
  track: { availability: ModelAvailability; stats: ModelStats },
  options: ModelCheckOptions = {},
): Promise<ModelCheckReport> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results: ModelCheckResult[] = [];
  const queue = [...models];
  let stopped: string | undefined;
  let limitsInARow = 0;
  track.availability.clear(models);

  async function worker() {
    for (let model = queue.shift(); model !== undefined && !stopped; model = queue.shift()) {
      const startedAt = now();
      try {
        await firstChunk(provider, model, timeoutMs);
        const latencyMs = now() - startedAt;
        track.stats.recordSuccess(model, latencyMs);
        results.push({ model, ok: true, latencyMs });
        limitsInARow = 0;
      } catch (error) {
        const message = errorText(error);
        if (error instanceof ProviderError && error.kind === 'model_unavailable') {
          track.availability.markUnavailable(model, message);
          results.push({ model, ok: false, hidden: true, error: message });
        } else if (error instanceof ProviderError && error.kind === 'auth') {
          stopped ??= message;
          queue.unshift(model);
        } else if (error instanceof ProviderError && LIMIT_KINDS.has(error.kind) && ++limitsInARow >= LIMITS_BEFORE_STOP) {
          stopped ??= message;
          results.push({ model, ok: false, error: message });
        } else {
          if (!(error instanceof ProviderError && LIMIT_KINDS.has(error.kind))) limitsInARow = 0;
          track.stats.recordFailure(model);
          results.push({ model, ok: false, error: message });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  return { provider: provider.id, results, ...(stopped ? { stopped } : {}) };
}
