import { describe, expect, test } from 'bun:test';

import type { Credential } from '../src/core/accounts/credential-store.ts';
import { AccountPool } from '../src/core/accounts/account-pool.ts';
import { openDatabase } from '../src/core/store/database.ts';
import { QwenAccountPool } from '../src/providers/qwen/account-pool.ts';
import { parseSignInResponse, type QwenSession } from '../src/providers/qwen/auth.ts';

const credentials: Credential[] = [
  { id: 'qwen-a', provider: 'qwen', email: 'a@example.com', password: 'pw-a' },
  { id: 'qwen-b', provider: 'qwen', email: 'b@example.com', password: 'pw-b' },
];

function source(list: Credential[] = credentials) {
  return { list: () => list };
}

const unusedSignIn = async (): Promise<QwenSession> => { throw new Error('unexpected sign-in'); };

function jwt(payload: Record<string, unknown>) {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

describe('parseSignInResponse', () => {
  test('returns the token with expiry', () => {
    expect(parseSignInResponse(200, { token: 'tok', expires_at: 2_000_000_000 })).toEqual({ token: 'tok', expiresAt: 2_000_000_000_000 });
  });

  test('falls back to the jwt exp claim', () => {
    expect(parseSignInResponse(200, { token: jwt({ exp: 1_900_000_000 }) }).expiresAt).toBe(1_900_000_000_000);
  });

  test('understands the v2 envelope, including errors returned with status 200', () => {
    expect(parseSignInResponse(200, { success: true, data: { token: 'v2-token', expires_at: 1_800_000_000 } }))
      .toEqual({ token: 'v2-token', expiresAt: 1_800_000_000_000 });
    expect(() => parseSignInResponse(200, { success: false, data: { code: 'Bad_Request', details: 'email not found' } }))
      .toThrow('Qwen sign-in failed: 200 email not found');
  });

  test('reports the upstream reason on failure', () => {
    expect(() => parseSignInResponse(400, { detail: 'email not found' })).toThrow('400 email not found');
  });
});

function harness(signIn: (email: string, password: string) => Promise<QwenSession>, list: Credential[] = credentials) {
  const clock = { now: 1_000_000 };
  const accounts = new AccountPool(openDatabase(':memory:'), 'qwen', () => clock.now);
  const pool = new QwenAccountPool(source(list), signIn, () => accounts, () => clock.now);
  const status = () => Object.fromEntries(accounts.list().map(state => [state.accountId, state.status]));
  return { pool, accounts, clock, status };
}

describe('QwenAccountPool', () => {
  test('signs in lazily, caches sessions and spreads load across accounts', async () => {
    const calls: string[] = [];
    const { pool, clock } = harness(async email => {
      calls.push(email);
      return { token: `token-${email}` };
    });

    const first = await pool.token();
    clock.now += 1_000;
    const second = await pool.token();
    clock.now += 1_000;
    await pool.token();

    expect(new Set([first, second])).toEqual(new Set(['token-a@example.com', 'token-b@example.com']));
    expect(calls.sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  test('signs in again when the session is about to expire', async () => {
    let logins = 0;
    const { pool, clock } = harness(async () => {
      logins++;
      return { token: `t${logins}`, expiresAt: clock.now + 5 * 60_000 };
    }, credentials.slice(0, 1));

    expect(await pool.token()).toBe('t1');
    clock.now += 4.5 * 60_000;
    expect(await pool.token()).toBe('t2');
  });

  test('backs off accounts that fail to sign in', async () => {
    const attempts: string[] = [];
    const { pool, status } = harness(async email => {
      attempts.push(email);
      if (email === 'a@example.com') throw new Error('bad password');
      return { token: 'token-b' };
    });

    expect(await pool.token()).toBe('token-b');
    expect(await pool.token()).toBe('token-b');
    expect(attempts.filter(email => email === 'a@example.com')).toHaveLength(1);
    expect(status()['qwen-a']).toBe('cooldown');
  });

  test('throws with every sign-in error when no account works, then reports cooldown', async () => {
    const { pool } = harness(async email => {
      throw new Error(`denied ${email}`);
    });
    await expect(pool.token()).rejects.toThrow(/qwen-\w: denied \S+; qwen-\w: denied/);
    await expect(pool.token()).rejects.toThrow('cooling down');
  });

  test('deduplicates concurrent sign-ins', async () => {
    let logins = 0;
    let release!: (session: QwenSession) => void;
    const { pool } = harness(() => {
      logins++;
      return new Promise<QwenSession>(resolve => { release = resolve; });
    }, credentials.slice(0, 1));

    const both = Promise.all([pool.token(), pool.token()]);
    release({ token: 'shared' });
    expect(await both).toEqual(['shared', 'shared']);
    expect(logins).toBe(1);
  });

  test('maps upstream outcomes onto account health', async () => {
    let logins = 0;
    const { pool, clock, status } = harness(async () => ({ token: `t${++logins}` }), credentials.slice(0, 1));
    const token = (await pool.token())!;

    pool.report(token, { ok: false, kind: 'rate_limit', status: 429, retryAfterSeconds: 120 });
    expect(status()).toEqual({ 'qwen-a': 'cooldown' });
    clock.now += 120_000;

    pool.report(token, { ok: true });
    expect(status()).toEqual({ 'qwen-a': 'healthy' });

    pool.report(token, { ok: false, kind: 'quota_exhausted', status: 429 });
    expect(status()).toEqual({ 'qwen-a': 'quota_exhausted' });
    clock.now += 60 * 60_000;
    pool.report(token, { ok: true });

    pool.report(token, { ok: false, kind: 'auth', status: 500 });
    clock.now += 30_000;
    expect(await pool.token()).toBe('t2');

    pool.report('unknown-token', { ok: false, kind: 'upstream', status: 500 });
    expect(status()).toEqual({ 'qwen-a': 'healthy' });
  });

  test('returns undefined without accounts and hides store errors from health', async () => {
    expect(await harness(unusedSignIn, []).pool.token()).toBeUndefined();
    const broken = new QwenAccountPool({ list: () => { throw new Error('ACCOUNTS_SECRET is not set'); } }, unusedSignIn, () => {
      throw new Error('pool must not be opened');
    });
    expect(broken.hasAccounts()).toBeFalse();
    await expect(broken.token()).rejects.toThrow('ACCOUNTS_SECRET');
  });
});
