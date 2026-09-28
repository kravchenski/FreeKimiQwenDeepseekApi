import type { ProviderHealth } from '../providers/provider.ts';

export const DEFAULT_PROFILE = 'default';

export interface SignInRecord {
  provider: string;
  profile?: string;
  signedIn: boolean;
  reason?: string;
  checkedAt: number;
}

export interface SignInStore {
  load(provider: string, profile: string): SignInRecord | undefined;
  save(record: SignInRecord): void;
}

export const SIGNED_OUT_RECHECK_MS = 10 * 60_000;
const CACHE_MS = 30_000;

export type SignInState = 'signed-in' | 'unknown' | 'signed-out';

export class WebSignInStatus {
  private readonly cache = new Map<string, { record?: SignInRecord; readAt: number }>();

  constructor(
    private readonly store: SignInStore,
    private readonly now: () => number = Date.now,
  ) {}

  record(provider: string, signedIn: boolean, reason?: string, profile = DEFAULT_PROFILE) {
    const record: SignInRecord = { provider, profile, signedIn, checkedAt: this.now(), ...(reason ? { reason } : {}) };
    try {
      this.store.save(record);
    } catch {}
    this.cache.set(`${provider}|${profile}`, { record, readAt: this.now() });
  }

  current(provider: string, profile = DEFAULT_PROFILE) {
    const key = `${provider}|${profile}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.readAt < CACHE_MS) return cached.record;
    let record: SignInRecord | undefined;
    try {
      record = this.store.load(provider, profile);
    } catch {}
    this.cache.set(key, { record, readAt: this.now() });
    return record;
  }

  state(provider: string, profile = DEFAULT_PROFILE): SignInState {
    const record = this.current(provider, profile);
    if (!record) return 'unknown';
    if (record.signedIn) return 'signed-in';
    return this.now() - record.checkedAt >= SIGNED_OUT_RECHECK_MS ? 'unknown' : 'signed-out';
  }

  usable(provider: string, profiles: string[]) {
    const signedIn = profiles.filter(profile => this.state(provider, profile) === 'signed-in');
    const unknown = profiles.filter(profile => this.state(provider, profile) === 'unknown');
    return { signedIn, unknown };
  }

  health(provider: string, profiles: string[] = [DEFAULT_PROFILE]): ProviderHealth {
    const { signedIn, unknown } = this.usable(provider, profiles);
    if (signedIn.length || unknown.length) return { available: true };
    const record = this.current(provider, profiles[0] ?? DEFAULT_PROFILE);
    return { available: false, reason: profiles.length > 1 ? `not signed in on any of ${profiles.length} accounts` : record?.reason ?? 'not signed in' };
  }
}
