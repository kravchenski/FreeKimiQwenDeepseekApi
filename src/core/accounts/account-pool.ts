import type { Database } from 'bun:sqlite';

export type AccountStatus = 'healthy' | 'cooldown' | 'quota_exhausted' | 'unauthorized';

export interface AccountState {
  accountId: string;
  provider: string;
  status: AccountStatus;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  quotaResetAt: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_QUOTA_WINDOW_MS = 60 * 60_000;

const COLUMNS = `account_id AS accountId, provider, status, consecutive_failures AS consecutiveFailures,
  cooldown_until AS cooldownUntil, quota_reset_at AS quotaResetAt, last_used_at AS lastUsedAt,
  last_success_at AS lastSuccessAt, last_error_at AS lastErrorAt, last_error AS lastError`;

export function effectiveStatus(state: AccountState, now: number): AccountStatus {
  if (state.status === 'unauthorized') return 'unauthorized';
  if (state.quotaResetAt && state.quotaResetAt > now) return 'quota_exhausted';
  if (state.cooldownUntil && state.cooldownUntil > now) return 'cooldown';
  return 'healthy';
}

export function scoreAccount(state: AccountState, now: number) {
  if (effectiveStatus(state, now) !== 'healthy') return -Infinity;
  const idleSeconds = state.lastUsedAt === null ? Infinity : (now - state.lastUsedAt) / 1000;
  return 100 - state.consecutiveFailures * 20 + Math.min(idleSeconds / 10, 20);
}

export class AccountPool {
  constructor(
    private readonly db: Database,
    readonly provider: string,
    private readonly now: () => number = Date.now,
  ) {}

  sync(accountIds: string[]) {
    const insert = this.db.query('INSERT OR IGNORE INTO account_state (account_id, provider) VALUES ($id, $provider)');
    this.db.transaction(() => {
      for (const id of accountIds) insert.run({ id, provider: this.provider });
    })();
  }

  list(): AccountState[] {
    const now = this.now();
    return (this.db.query(`SELECT ${COLUMNS} FROM account_state WHERE provider = $provider ORDER BY account_id`)
      .all({ provider: this.provider }) as AccountState[])
      .map(state => ({ ...state, status: effectiveStatus(state, now) }));
  }

  acquire(accountIds?: string[]) {
    const now = this.now();
    const allowed = accountIds && new Set(accountIds);
    const best = this.list()
      .filter(state => !allowed || allowed.has(state.accountId))
      .map(state => ({ state, score: scoreAccount(state, now) }))
      .filter(candidate => candidate.score > -Infinity)
      .sort((a, b) => b.score - a.score)[0]?.state;
    if (best) this.update(best.accountId, 'last_used_at = $now', { now });
    return best?.accountId;
  }

  markSuccess(accountId: string) {
    this.update(accountId, `status = 'healthy', consecutive_failures = 0, cooldown_until = NULL,
      quota_reset_at = NULL, last_success_at = $now`, { now: this.now() });
  }

  markFailure(accountId: string, error: string) {
    const failures = (this.state(accountId)?.consecutiveFailures ?? 0) + 1;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    const now = this.now();
    this.update(accountId, `status = 'cooldown', consecutive_failures = $failures, cooldown_until = $until,
      last_error_at = $now, last_error = $error`, { failures, until: now + backoff, now, error });
  }

  markRateLimited(accountId: string, retryAt: number) {
    const now = this.now();
    this.update(accountId, `status = 'cooldown', cooldown_until = $retryAt, last_error_at = $now,
      last_error = 'rate limited'`, { retryAt, now });
    this.recordQuotaEvent(accountId, 'rate_limited', retryAt);
  }

  markQuotaExhausted(accountId: string, resetAt?: number) {
    const now = this.now();
    const until = resetAt ?? now + DEFAULT_QUOTA_WINDOW_MS;
    this.update(accountId, `status = 'quota_exhausted', quota_reset_at = $until, last_error_at = $now,
      last_error = 'quota exhausted'`, { until, now });
    this.recordQuotaEvent(accountId, 'quota_exhausted', until);
  }

  markUnauthorized(accountId: string, error: string) {
    this.update(accountId, `status = 'unauthorized', last_error_at = $now, last_error = $error`, { now: this.now(), error });
  }

  private state(accountId: string) {
    return this.db.query(`SELECT ${COLUMNS} FROM account_state WHERE account_id = $id AND provider = $provider`)
      .get({ id: accountId, provider: this.provider }) as AccountState | null;
  }

  private update(accountId: string, assignments: string, values: Record<string, string | number>) {
    this.db.query(`UPDATE account_state SET ${assignments} WHERE account_id = $id AND provider = $provider`)
      .run({ ...values, id: accountId, provider: this.provider });
  }

  private recordQuotaEvent(accountId: string, type: string, resetAt: number) {
    this.db.query(`INSERT INTO quota_events (created_at, provider, account_id, type, reset_at)
      VALUES ($now, $provider, $id, $type, $resetAt)`)
      .run({ now: this.now(), provider: this.provider, id: accountId, type, resetAt });
  }
}
