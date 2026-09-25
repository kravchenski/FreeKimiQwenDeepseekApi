import { describe, expect, test } from 'bun:test';

import type { Credential } from '../src/core/accounts/credential-store.ts';
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

describe('QwenAccountPool', () => {
  test('signs in lazily, caches sessions and rotates accounts', async () => {
    const calls: string[] = [];
    const pool = new QwenAccountPool(source(), async email => {
      calls.push(email);
      return { token: `token-${email}` };
    });

    expect(await pool.token()).toBe('token-a@example.com');
    expect(await pool.token()).toBe('token-b@example.com');
    expect(await pool.token()).toBe('token-a@example.com');
    expect(calls).toEqual(['a@example.com', 'b@example.com']);
  });

  test('signs in again when the session is about to expire', async () => {
    let now = 1_000_000;
    let logins = 0;
    const pool = new QwenAccountPool(source(credentials.slice(0, 1)), async () => {
      logins++;
      return { token: `t${logins}`, expiresAt: now + 5 * 60_000 };
    }, () => now);

    expect(await pool.token()).toBe('t1');
    now += 4.5 * 60_000;
    expect(await pool.token()).toBe('t2');
  });

  test('skips accounts that fail to sign in and cools them down', async () => {
    const attempts: string[] = [];
    const pool = new QwenAccountPool(source(), async email => {
      attempts.push(email);
      if (email === 'a@example.com') throw new Error('bad password');
      return { token: 'token-b' };
    });

    expect(await pool.token()).toBe('token-b');
    expect(await pool.token()).toBe('token-b');
    expect(attempts).toEqual(['a@example.com', 'b@example.com']);
  });

  test('throws with every sign-in error when no account works', async () => {
    const pool = new QwenAccountPool(source(), async email => {
      throw new Error(`denied ${email}`);
    });
    await expect(pool.token()).rejects.toThrow('qwen-a: denied a@example.com; qwen-b: denied b@example.com');
  });

  test('deduplicates concurrent sign-ins and supports invalidation', async () => {
    let logins = 0;
    let release!: (session: QwenSession) => void;
    const pool = new QwenAccountPool(source(credentials.slice(0, 1)), () => {
      logins++;
      return new Promise<QwenSession>(resolve => { release = resolve; });
    });

    const both = Promise.all([pool.token(), pool.token()]);
    release({ token: 'shared' });
    expect(await both).toEqual(['shared', 'shared']);
    expect(logins).toBe(1);

    pool.invalidate('shared');
    const next = pool.token();
    release({ token: 'fresh' });
    expect(await next).toBe('fresh');
  });

  test('returns undefined without accounts and hides store errors from health', async () => {
    expect(await new QwenAccountPool(source([]), unusedSignIn).token()).toBeUndefined();
    const broken = new QwenAccountPool({ list: () => { throw new Error('ACCOUNTS_SECRET is not set'); } }, unusedSignIn);
    expect(broken.hasAccounts()).toBeFalse();
    await expect(broken.token()).rejects.toThrow('ACCOUNTS_SECRET');
  });
});
