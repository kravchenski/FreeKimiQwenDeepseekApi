import type { Database } from 'bun:sqlite';

import { effectiveStatus, type AccountState } from './accounts/account-pool.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import { recentRequests } from './store/database.ts';

export function gatewayStatus(registry: ProviderRegistry, db: Database, now = Date.now()) {
  const providers = registry.list().map(provider => ({ id: provider.id, ownedBy: provider.ownedBy, ...provider.health() }));
  const accounts = (db.query(`SELECT account_id AS accountId, provider, status, consecutive_failures AS consecutiveFailures,
    cooldown_until AS cooldownUntil, quota_reset_at AS quotaResetAt, last_used_at AS lastUsedAt,
    last_success_at AS lastSuccessAt, last_error_at AS lastErrorAt, last_error AS lastError
    FROM account_state ORDER BY provider, account_id`).all() as AccountState[])
    .map(state => ({ ...state, status: effectiveStatus(state, now) }));
  return { providers, accounts, requests: recentRequests(db, 50) };
}
