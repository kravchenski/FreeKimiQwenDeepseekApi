import { ProviderError } from '../providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../providers/provider.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

export const AUTO_MODEL = 'auto';
export const DEFAULT_AUTO_MODELS = [
  'qwen3.7-plus',
  'deepseek-default',
  'glm-5.2-free',
  'kimi-k2.7-code-free',
  'deepseek-ai/deepseek-v4-pro',
];

const PROVIDER_COOLDOWN_MS = 30_000;

export interface Route {
  provider: Provider;
  model: string;
}

export interface RoutedStream extends ProviderStream {
  route: Route;
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

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly autoModels: string[] = DEFAULT_AUTO_MODELS,
    private readonly now: () => number = Date.now,
  ) {}

  knows(model: string) {
    return model === AUTO_MODEL || Boolean(this.registry.resolve(model));
  }

  routes(model: string): Route[] {
    if (model !== AUTO_MODEL) {
      const provider = this.registry.resolve(model);
      return provider ? [{ provider, model }] : [];
    }
    const now = this.now();
    return this.autoModels.flatMap(candidate => {
      const provider = this.registry.resolve(candidate);
      if (!provider || !provider.health().available) return [];
      if ((this.cooldownUntil.get(provider.id) ?? 0) > now) return [];
      return [{ provider, model: candidate }];
    });
  }

  async open(model: string, build: (route: Route) => ChatRequest): Promise<RoutedStream> {
    const routes = this.routes(model);
    if (!routes.length) throw new ProviderError(`No available provider for model ${model}`, 'unavailable');
    const failures: string[] = [];
    for (const route of routes) {
      try {
        const stream = await route.provider.stream(build(route));
        const chunks = await primeChunks(stream.chunks);
        this.cooldownUntil.delete(route.provider.id);
        return { ...stream, chunks, route };
      } catch (error) {
        if (routes.length === 1) throw error;
        this.cooldownUntil.set(route.provider.id, this.now() + PROVIDER_COOLDOWN_MS);
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
