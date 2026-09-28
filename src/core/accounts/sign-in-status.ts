import type { ProviderHealth } from '../providers/provider.ts';

export interface SignInRecord {
  provider: string;
  signedIn: boolean;
  reason?: string;
  checkedAt: number;
}

export interface SignInStore {
  load(provider: string): SignInRecord | undefined;
  save(record: SignInRecord): void;
}

export const SIGNED_OUT_RECHECK_MS = 10 * 60_000;
const CACHE_MS = 30_000;

export class WebSignInStatus {
  private readonly cache = new Map<string, { record?: SignInRecord; readAt: number }>();

  constructor(
    private readonly store: SignInStore,
    private readonly now: () => number = Date.now,
  ) {}

  record(provider: string, signedIn: boolean, reason?: string) {
    const record: SignInRecord = { provider, signedIn, checkedAt: this.now(), ...(reason ? { reason } : {}) };
    try {
      this.store.save(record);
    } catch {}
    this.cache.set(provider, { record, readAt: this.now() });
  }

  current(provider: string) {
    const cached = this.cache.get(provider);
    if (cached && this.now() - cached.readAt < CACHE_MS) return cached.record;
    let record: SignInRecord | undefined;
    try {
      record = this.store.load(provider);
    } catch {}
    this.cache.set(provider, { record, readAt: this.now() });
    return record;
  }

  health(provider: string): ProviderHealth {
    const record = this.current(provider);
    if (!record || record.signedIn || this.now() - record.checkedAt >= SIGNED_OUT_RECHECK_MS) return { available: true };
    return { available: false, reason: record.reason ?? 'not signed in' };
  }
}
