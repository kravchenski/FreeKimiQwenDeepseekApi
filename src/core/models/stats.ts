export interface ModelStat {
  model: string;
  successes: number;
  failures: number;
  latencyMs?: number;
  lastOutcome: 'success' | 'failure';
  updatedAt: number;
}

const LATENCY_WEIGHT = 0.3;

export class ModelStats {
  private readonly stats = new Map<string, ModelStat>();
  private readonly listeners = new Set<(stat: ModelStat) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  load(stats: ModelStat[]) {
    for (const stat of stats) this.stats.set(stat.model, { ...stat });
  }

  recordSuccess(model: string, latencyMs: number) {
    const previous = this.stats.get(model);
    const latency = previous?.latencyMs === undefined
      ? latencyMs
      : previous.latencyMs + LATENCY_WEIGHT * (latencyMs - previous.latencyMs);
    this.update({
      model,
      successes: (previous?.successes ?? 0) + 1,
      failures: previous?.failures ?? 0,
      latencyMs: Math.round(latency),
      lastOutcome: 'success',
      updatedAt: this.now(),
    });
  }

  recordFailure(model: string) {
    const previous = this.stats.get(model);
    this.update({
      model,
      successes: previous?.successes ?? 0,
      failures: (previous?.failures ?? 0) + 1,
      latencyMs: previous?.latencyMs,
      lastOutcome: 'failure',
      updatedAt: this.now(),
    });
  }

  get(model: string) {
    return this.stats.get(model);
  }

  list() {
    return [...this.stats.values()];
  }

  onChange(listener: (stat: ModelStat) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(stat: ModelStat) {
    this.stats.set(stat.model, stat);
    for (const listener of this.listeners) listener(stat);
  }
}

export function rankModels(models: string[], stats: Pick<ModelStats, 'get'>) {
  const group = (model: string) => {
    const stat = stats.get(model);
    if (!stat) return 1;
    return stat.lastOutcome === 'success' ? 0 : 2;
  };
  return models
    .map((model, order) => ({ model, order, group: group(model), latency: stats.get(model)?.latencyMs ?? 0 }))
    .sort((a, b) => a.group - b.group || (a.group === 0 ? a.latency - b.latency : 0) || a.order - b.order)
    .map(entry => entry.model);
}
