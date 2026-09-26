import type { AccountPool } from '../../core/accounts/account-pool.ts';
import type { Credential } from '../../core/accounts/credential-store.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { UpstreamOutcome } from '../openai-compatible.ts';
import type { QwenSession } from './auth.ts';

interface CredentialSource {
  list(provider?: string): Credential[];
}

type SignIn = (email: string, password: string) => Promise<QwenSession>;

const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

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
    if (errors.length) throw new ProviderError(errors.join('; '), 'unavailable');
    if (accounts.length) throw new ProviderError('All Qwen accounts are cooling down or unavailable', 'unavailable');
    return undefined;
  }

  report(token: string, outcome: UpstreamOutcome) {
    const id = this.accountFor(token);
    if (!id) return;
    if (outcome.ok) {
      this.pool.markSuccess(id);
      return;
    }
    const failure = outcome as Extract<UpstreamOutcome, { ok: false }>;
    const reason = `upstream ${failure.status ?? failure.kind}`;
    if (failure.kind === 'auth' && this.accounts().find(account => account.id === id)?.method === 'browser') {
      this.sessions.delete(id);
      this.pool.markUnauthorized(id, `${reason}; run: bun run account add qwen --browser`);
    } else if (failure.kind === 'auth') {
      this.sessions.delete(id);
      this.pool.markFailure(id, reason);
    } else if (failure.kind === 'rate_limit') {
      this.pool.markRateLimited(id, this.now() + (failure.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000);
    } else if (failure.kind === 'quota_exhausted') {
      this.pool.markQuotaExhausted(id, failure.retryAfterSeconds === undefined ? undefined : this.now() + failure.retryAfterSeconds * 1000);
    } else if ((failure.status ?? 500) >= 500) {
      this.pool.markFailure(id, reason);
    }
  }

  private browserSession(account: Credential): QwenSession {
    if (!account.token) throw new Error('Browser session has no token');
    if (account.expiresAt && account.expiresAt - EXPIRY_MARGIN_MS <= this.now()) {
      throw new Error(`Browser session expired; run: bun run account add ${account.provider} --browser`);
    }
    const session = { token: account.token, expiresAt: account.expiresAt };
    this.sessions.set(account.id, session);
    return session;
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
    if (account.method === 'browser') return this.browserSession(account);
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
