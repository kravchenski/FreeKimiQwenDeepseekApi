import { describe, expect, test } from 'bun:test';

import { AccountPool, scoreAccount, type AccountState } from '../src/core/accounts/account-pool.ts';
import { openDatabase } from '../src/core/store/database.ts';

function setup(ids = ['a', 'b']) {
  let now = 1_000_000;
  const db = openDatabase(':memory:');
  const pool = new AccountPool(db, 'qwen', () => now);
  pool.sync(ids);
  return { db, pool, advance: (ms: number) => { now += ms; }, now: () => now };
}

const status = (pool: AccountPool) => Object.fromEntries(pool.list().map(state => [state.accountId, state.status]));

describe('AccountPool', () => {
  test('prefers idle accounts and spreads load', () => {
    const { pool, advance } = setup();
    const first = pool.acquire();
    advance(1_000);
    const second = pool.acquire();
    expect(new Set([first, second])).toEqual(new Set(['a', 'b']));
  });

  test('backs off failing accounts exponentially and recovers after success', () => {
    const { pool, advance } = setup(['a']);
    pool.markFailure('a', 'timeout');
    expect(pool.acquire()).toBeUndefined();
    advance(30_000);
    expect(pool.acquire()).toBe('a');
    pool.markFailure('a', 'timeout');
    advance(30_000);
    expect(pool.acquire()).toBeUndefined();
    advance(30_000);
    expect(pool.acquire()).toBe('a');
    pool.markSuccess('a');
    expect(pool.list()[0]).toMatchObject({ status: 'healthy', consecutiveFailures: 0, cooldownUntil: null });
  });

  test('skips rate limited and quota exhausted accounts until their reset time', () => {
    const { db, pool, advance, now } = setup();
    pool.markRateLimited('a', now() + 10_000);
    pool.markQuotaExhausted('b', now() + 60_000);
    expect(status(pool)).toEqual({ a: 'cooldown', b: 'quota_exhausted' });
    expect(pool.acquire()).toBeUndefined();

    advance(10_000);
    expect(pool.acquire()).toBe('a');
    advance(50_000);
    expect(status(pool)).toEqual({ a: 'healthy', b: 'healthy' });
    expect(db.query('SELECT type FROM quota_events ORDER BY id').all()).toEqual([
      { type: 'rate_limited' },
      { type: 'quota_exhausted' },
    ]);
  });

  test('keeps unauthorized accounts out until they succeed again', () => {
    const { pool, advance } = setup(['a']);
    pool.markUnauthorized('a', '401');
    advance(24 * 60 * 60_000);
    expect(pool.acquire()).toBeUndefined();
    pool.markSuccess('a');
    expect(pool.acquire()).toBe('a');
  });

  test('restricts acquisition to the given ids and isolates providers', () => {
    const { db, pool } = setup();
    const other = new AccountPool(db, 'deepseek');
    other.sync(['a']);
    other.markUnauthorized('a', '401');
    expect(pool.acquire(['b'])).toBe('b');
    expect(status(pool)).toEqual({ a: 'healthy', b: 'healthy' });
    expect(status(other)).toEqual({ a: 'unauthorized' });
  });

  test('sync is idempotent and keeps existing state', () => {
    const { pool } = setup(['a']);
    pool.markFailure('a', 'boom');
    pool.sync(['a', 'c']);
    expect(pool.list().map(state => [state.accountId, state.consecutiveFailures])).toEqual([['a', 1], ['c', 0]]);
  });
});

describe('scoreAccount', () => {
  const base: AccountState = {
    accountId: 'a', provider: 'qwen', status: 'healthy', consecutiveFailures: 0, cooldownUntil: null,
    quotaResetAt: null, lastUsedAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null,
  };

  test('penalizes failures and rewards idle time up to a cap', () => {
    expect(scoreAccount(base, 0)).toBe(120);
    expect(scoreAccount({ ...base, lastUsedAt: 0 }, 50_000)).toBe(105);
    expect(scoreAccount({ ...base, lastUsedAt: 0, consecutiveFailures: 2 }, 1_000_000)).toBe(80);
    expect(scoreAccount({ ...base, status: 'unauthorized' }, 0)).toBe(-Infinity);
  });
});
