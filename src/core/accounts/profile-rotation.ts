import type { WebSignInStatus } from './sign-in-status.ts';

export const PROFILE_FAILURE_COOLDOWN_MS = 5 * 60_000;

export class ProfileRotation {
  private readonly next = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly profiles: () => string[],
    private readonly status: Pick<WebSignInStatus, 'usable'>,
    private readonly now: () => number = Date.now,
  ) {}

  order(provider: string) {
    const { signedIn, unknown } = this.status.usable(provider, this.profiles());
    const ready = (profiles: string[]) => profiles.filter(profile => (this.cooldownUntil.get(`${provider}|${profile}`) ?? 0) <= this.now());
    const rested = [...ready(signedIn), ...ready(unknown)];
    const pool = rested.length ? { signedIn: ready(signedIn), unknown: ready(unknown) } : { signedIn, unknown };
    const start = pool.signedIn.length ? (this.next.get(provider) ?? 0) % pool.signedIn.length : 0;
    this.next.set(provider, start + 1);
    return [...pool.signedIn.slice(start), ...pool.signedIn.slice(0, start), ...pool.unknown];
  }

  failed(provider: string, profile: string) {
    this.cooldownUntil.set(`${provider}|${profile}`, this.now() + PROFILE_FAILURE_COOLDOWN_MS);
  }

  succeeded(provider: string, profile: string) {
    this.cooldownUntil.delete(`${provider}|${profile}`);
  }
}
