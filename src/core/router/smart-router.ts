import { ProviderError } from '../providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../providers/provider.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

export const AUTO_MODEL = 'auto';
export const DEFAULT_AUTO_MODELS = [
  'qwen3.7-plus',
  'deepseek-default',
  'glm-chat',
  'kimi-chat',
  'deepseek-ai/deepseek-v4.1-flash',
  'moonshotai/kimi-k3',
  'z-ai/glm-5.3',
];

const PROVIDER_COOLDOWN_MS = 30_000;
const MODEL_TIMEOUT_COOLDOWN_MS = 10 * 60_000;

export interface SmartRouterOptions {
  firstChunkTimeoutMs?: number;
}

export interface Route {
  provider: Provider;
  model: string;
}

export interface RoutedStream extends ProviderStream {
  route: Route;
}

class FirstChunkTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number | undefined, onTimeout: () => void) {
  if (!ms) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new FirstChunkTimeout(`no response within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function primeChunks(chunks: AsyncIterable<ChatChunk>) {
  const iterator = chunks[Symbol.asyncIterator]();
  const first = await iterator.next();
  return (async function* () {
    try {
      if (first.done) return;
      yield first.value;
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
    } finally {
      await iterator.return?.();
    }
  })();
}

export class SmartRouter {
  private readonly cooldownUntil = new Map<string, number>();
  private readonly modelCooldownUntil = new Map<string, number>();

  constructor(
    private readonly registry: ProviderRegistry,
    private autoModels: string[] = DEFAULT_AUTO_MODELS,
    private readonly now: () => number = Date.now,
    private readonly options: SmartRouterOptions = {},
  ) {}

  setAutoModels(models: string[]) {
    if (models.length) this.autoModels = [...models];
  }

  autoChain(): readonly string[] {
    return this.autoModels;
  }

  knows(model: string) {
    return model === AUTO_MODEL || Boolean(this.registry.resolve(model));
  }

  routes(model: string, preferredModel?: string): Route[] {
    if (model !== AUTO_MODEL) {
      const provider = this.registry.resolve(model);
      return provider ? [{ provider, model }] : [];
    }
    const now = this.now();
    const candidates = preferredModel && this.autoModels.includes(preferredModel)
      ? [preferredModel, ...this.autoModels.filter(candidate => candidate !== preferredModel)]
      : this.autoModels;
    return candidates.flatMap(candidate => {
      const provider = this.registry.resolve(candidate);
      if (!provider || !provider.health().available) return [];
      if (!this.registry.availability.isAvailable(candidate)) return [];
      if ((this.cooldownUntil.get(provider.id) ?? 0) > now) return [];
      if ((this.modelCooldownUntil.get(candidate) ?? 0) > now) return [];
      return [{ provider, model: candidate }];
    });
  }

  async open(model: string, build: (route: Route) => ChatRequest, preferredModel?: string): Promise<RoutedStream> {
    const routes = this.routes(model, preferredModel);
    if (!routes.length) throw new ProviderError(`No available provider for model ${model}`, 'unavailable');
    const failures: string[] = [];
    for (const route of routes) {
      try {
        const controller = new AbortController();
        const timeoutMs = routes.length > 1 ? this.options.firstChunkTimeoutMs : undefined;
        const pending = (async () => {
          const stream = await route.provider.stream(build(route), { signal: controller.signal });
          return { stream, chunks: await primeChunks(stream.chunks) };
        })();
        const { stream, chunks } = await withTimeout(pending, timeoutMs, () => {
          controller.abort();
          pending.then(late => late.chunks.return(undefined), () => undefined);
        });
        this.cooldownUntil.delete(route.provider.id);
        return { ...stream, chunks, route };
      } catch (error) {
        const modelMissing = error instanceof ProviderError && error.kind === 'model_unavailable';
        if (modelMissing) this.registry.availability.markUnavailable(route.model, error.message);
        if (routes.length === 1) throw error;
        if (error instanceof FirstChunkTimeout) this.modelCooldownUntil.set(route.model, this.now() + MODEL_TIMEOUT_COOLDOWN_MS);
        else if (!modelMissing) this.cooldownUntil.set(route.provider.id, this.now() + PROVIDER_COOLDOWN_MS);
        failures.push(`${route.model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new ProviderError(`All routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable');
  }
}

export function parseAutoModels(value: string | undefined) {
  const models = (value ?? '').split(',').map(model => model.trim()).filter(Boolean);
  return models.length ? models : DEFAULT_AUTO_MODELS;
}
