export const MODEL_UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UnavailableModel {
  model: string;
  reason: string;
  until: number;
}

export class ModelAvailability {
  private readonly unavailable = new Map<string, UnavailableModel>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ttlMs = MODEL_UNAVAILABLE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  markUnavailable(model: string, reason: string) {
    this.unavailable.set(model, { model, reason: reason.slice(0, 200), until: this.now() + this.ttlMs });
    for (const listener of this.listeners) listener();
  }

  isAvailable(model: string) {
    const entry = this.unavailable.get(model);
    if (!entry) return true;
    if (entry.until > this.now()) return false;
    this.unavailable.delete(model);
    return true;
  }

  list(): UnavailableModel[] {
    return [...this.unavailable.values()].filter(entry => !this.isAvailable(entry.model));
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
