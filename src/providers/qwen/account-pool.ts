import type { AccountPool } from '../../core/accounts/account-pool.ts';
import type { Credential } from '../../core/accounts/credential-store.ts';
import type { QwenSession } from './auth.ts';

interface CredentialSource {
  list(provider?: string): Credential[];
}

type SignIn = (email: string, password: string) => Promise<QwenSession>;

const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export function retryAfterMs(header: string | null, now: number) {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(date - now, 0);
}

export class QwenAccountPool {
  private credentials?: Credential[];
  private readonly sessions = new Map<string, QwenSession>();
  private readonly pending = new Map<string, Promise<QwenSession>>();
  private accountPool?: AccountPool;

  constructor(
    private readonly source: CredentialSource,
    private readonly signIn: SignIn,
    private readonly createPool: () => AccountPool,
    private readonly now: () => number = Date.now,
  ) {}

  private get pool() {
    this.accountPool ??= this.createPool();
    return this.accountPool;
  }

  hasAccounts() {
    try {
      return this.accounts().length > 0;
    } catch {
      return false;
    }
  }

  async token() {
    const accounts = this.accounts();
    const remaining = new Set(accounts.map(account => account.id));
    const errors: string[] = [];
    while (remaining.size) {
      const id = this.pool.acquire([...remaining]);
      if (!id) break;
      remaining.delete(id);
      const account = accounts.find(candidate => candidate.id === id)!;
      try {
        return (await this.session(account)).token;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.pool.markFailure(id, message);
        errors.push(`${id}: ${message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    if (accounts.length) throw new Error('All Qwen accounts are cooling down or unavailable');
    return undefined;
  }

  report(token: string, response: Response) {
    const id = this.accountFor(token);
    if (!id) return;
    if (response.ok) {
      this.pool.markSuccess(id);
    } else if (response.status === 401 || response.status === 403) {
      this.sessions.delete(id);
      this.pool.markFailure(id, `upstream ${response.status}`);
    } else if (response.status === 429) {
      this.pool.markRateLimited(id, this.now() + retryAfterMs(response.headers.get('retry-after'), this.now()));
    } else if (response.status >= 500) {
      this.pool.markFailure(id, `upstream ${response.status}`);
    }
  }

  private accountFor(token: string) {
    for (const [id, session] of this.sessions) {
      if (session.token === token) return id;
    }
    return undefined;
  }

  private accounts() {
    if (!this.credentials) {
      this.credentials = this.source.list('qwen');
      if (this.credentials.length) this.pool.sync(this.credentials.map(account => account.id));
    }
    return this.credentials;
  }

  private async session(account: Credential) {
    const cached = this.sessions.get(account.id);
    if (cached && (!cached.expiresAt || cached.expiresAt - EXPIRY_MARGIN_MS > this.now())) return cached;
    let pending = this.pending.get(account.id);
    if (!pending) {
      pending = this.signIn(account.email, account.password).finally(() => this.pending.delete(account.id));
      this.pending.set(account.id, pending);
    }
    const session = await pending;
    this.sessions.set(account.id, session);
    return session;
  }
}
