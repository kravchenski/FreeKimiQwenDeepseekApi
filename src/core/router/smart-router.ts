import { ProviderError, type ProviderErrorKind } from '../providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../providers/provider.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { primeChunks } from '../streaming/sse.ts';

export const AUTO_MODEL = 'auto';

const PROVIDER_COOLDOWN_MS = 30_000;
const NOT_MODEL_FAULTS: ProviderErrorKind[] = ['rate_limit', 'quota_exhausted', 'auth', 'unavailable', 'invalid_request'];
const MODEL_TIMEOUT_COOLDOWN_MS = 10 * 60_000;

export interface SmartRouterOptions {
  firstChunkTimeoutMs?: number;
  autoEnabled?: (providerId: string) => boolean;
  autoMode?: () => 'fallback' | 'race';
  raceWidth?: number;
  prepareAuto?: () => void;
}

const DEFAULT_RACE_WIDTH = 3;

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

export class SmartRouter {
  private readonly cooldownUntil = new Map<string, number>();
  private readonly modelCooldownUntil = new Map<string, number>();

  constructor(
    private readonly registry: ProviderRegistry,
    private autoModels: string[] = [],
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
    if (model === AUTO_MODEL) this.options.prepareAuto?.();
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
      if (this.options.autoEnabled && !this.options.autoEnabled(provider.id)) return [];
      if (!this.registry.availability.isAvailable(candidate)) return [];
      if ((this.cooldownUntil.get(provider.id) ?? 0) > now) return [];
      if ((this.modelCooldownUntil.get(candidate) ?? 0) > now) return [];
      return [{ provider, model: candidate }];
    });
  }

  private async attempt(route: Route, build: (route: Route) => ChatRequest, controller: AbortController, timeoutMs: number | undefined) {
    const startedAt = this.now();
    const pending = (async () => {
      const stream = await route.provider.stream(build(route), { signal: controller.signal });
      return { stream, chunks: await primeChunks(stream.chunks) };
    })();
    const result = await withTimeout(pending, timeoutMs, () => {
      controller.abort();
      pending.then(late => late.chunks.return(undefined), () => undefined);
    });
    return { ...result, latencyMs: this.now() - startedAt };
  }

  private succeeded(route: Route, latencyMs: number) {
    this.cooldownUntil.delete(route.provider.id);
    this.registry.stats.recordSuccess(route.model, latencyMs);
  }

  private recordFailure(route: Route, error: unknown, coolDown: boolean) {
    const modelMissing = error instanceof ProviderError && error.kind === 'model_unavailable';
    if (!(error instanceof ProviderError && NOT_MODEL_FAULTS.includes(error.kind))) this.registry.stats.recordFailure(route.model);
    if (modelMissing) this.registry.availability.markUnavailable(route.model, error.message);
    if (!coolDown) return;
    if (error instanceof FirstChunkTimeout) this.modelCooldownUntil.set(route.model, this.now() + MODEL_TIMEOUT_COOLDOWN_MS);
    else if (!modelMissing) this.cooldownUntil.set(route.provider.id, this.now() + PROVIDER_COOLDOWN_MS);
  }

  async open(model: string, build: (route: Route) => ChatRequest, preferredModel?: string): Promise<RoutedStream> {
    const routes = this.routes(model, preferredModel);
    if (!routes.length) throw new ProviderError(`No available provider for model ${model}`, 'unavailable');
    if (model === AUTO_MODEL && routes.length > 1 && this.options.autoMode?.() === 'race') return this.race(model, routes, build);
    const failures: string[] = [];
    for (const route of routes) {
      try {
        const timeoutMs = routes.length > 1 ? this.options.firstChunkTimeoutMs : undefined;
        const { stream, chunks, latencyMs } = await this.attempt(route, build, new AbortController(), timeoutMs);
        this.succeeded(route, latencyMs);
        return { ...stream, chunks, route };
      } catch (error) {
        this.recordFailure(route, error, routes.length > 1);
        if (routes.length === 1) throw error;
        failures.push(`${route.model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new ProviderError(`All routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable');
  }

  private async race(model: string, routes: Route[], build: (route: Route) => ChatRequest): Promise<RoutedStream> {
    const contenders = routes.slice(0, this.options.raceWidth ?? DEFAULT_RACE_WIDTH);
    const controllers = contenders.map(() => new AbortController());
    const failures: string[] = [];
    let settled = false;
    const attempts = contenders.map((route, index) => this.attempt(route, build, controllers[index]!, this.options.firstChunkTimeoutMs).then(
      result => {
        if (settled) {
          void result.chunks.return(undefined);
          throw new Error('lost the race');
        }
        settled = true;
        return { ...result, route, index };
      },
      error => {
        if (!settled) {
          this.recordFailure(route, error, true);
          failures.push(`${route.model}: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      },
    ));
    try {
      const winner = await Promise.any(attempts);
      controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
      this.succeeded(winner.route, winner.latencyMs);
      return { ...winner.stream, chunks: winner.chunks, route: winner.route };
    } catch {
      throw new ProviderError(`All raced routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable');
    }
  }

}

export function parseAutoModels(value: string | undefined) {
  const models = (value ?? '').split(',').map(model => model.trim()).filter(Boolean);
  return models;
}
