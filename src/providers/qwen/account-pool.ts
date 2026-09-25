import type { Credential } from '../../core/accounts/credential-store.ts';
import { qwenSignIn, type QwenSession } from './auth.ts';

interface CredentialSource {
  list(provider?: string): Credential[];
}

type SignIn = (email: string, password: string) => Promise<QwenSession>;

const EXPIRY_MARGIN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;

export class QwenAccountPool {
  private credentials?: Credential[];
  private readonly sessions = new Map<string, QwenSession>();
  private readonly pending = new Map<string, Promise<QwenSession>>();
  private readonly cooldownUntil = new Map<string, number>();
  private pointer = 0;

  constructor(
    private readonly source: CredentialSource,
    private readonly signIn: SignIn = qwenSignIn,
    private readonly now: () => number = Date.now,
  ) {}

  hasAccounts() {
    try {
      return this.accounts().length > 0;
    } catch {
      return false;
    }
  }

  async token() {
    const accounts = this.accounts();
    const errors: string[] = [];
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const account = accounts[(this.pointer + attempt) % accounts.length]!;
      if ((this.cooldownUntil.get(account.id) ?? 0) > this.now()) continue;
      try {
        const session = await this.session(account);
        this.pointer = (this.pointer + attempt + 1) % accounts.length;
        return session.token;
      } catch (error) {
        this.cooldownUntil.set(account.id, this.now() + FAILURE_COOLDOWN_MS);
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return undefined;
  }

  invalidate(token: string) {
    for (const [id, session] of this.sessions) {
      if (session.token === token) this.sessions.delete(id);
    }
  }

  private accounts() {
    this.credentials ??= this.source.list('qwen');
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
