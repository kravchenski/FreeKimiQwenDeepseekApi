export type RouteOutcome = 'chosen' | 'failed' | 'timeout' | 'lost';

export interface RouteAttempt {
  model: string;
  provider: string;
  outcome: RouteOutcome;
  latencyMs?: number;
  error?: string;
}

export interface SkippedRoute {
  model: string;
  reason: string;
}

export interface RoutingDecision {
  id: number;
  at: number;
  requestedModel: string;
  mode: 'direct' | 'fallback' | 'race' | 'decide';
  picked?: string;
  preferredModel?: string;
  skipped: SkippedRoute[];
  attempts: RouteAttempt[];
  chosen?: { model: string; provider: string };
  error?: string;
}

const DEFAULT_LIMIT = 200;

export class DecisionLog {
  private readonly entries: RoutingDecision[] = [];
  private nextId = 1;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  add(decision: Omit<RoutingDecision, 'id'>) {
    this.entries.push({ ...decision, id: this.nextId++ });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  list(limit = 50, model?: string): RoutingDecision[] {
    return this.entries
      .filter(entry => !model || entry.requestedModel === model || entry.chosen?.model === model)
      .slice(-Math.max(1, limit))
      .reverse();
  }
}
