import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { decodeJwtPayload, evaluateSignIn } from '../src/browser/sign-in.ts';
import { WebSignInStatus, type SignInRecord } from '../src/core/accounts/sign-in-status.ts';
import { loadSignIn, openDatabase, saveSignIn } from '../src/core/store/database.ts';
import { KIMI_CHAT_SITE } from '../src/providers/kimi/web.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';
import { siteForUrl } from '../src/providers/web-chat-sites.ts';

const jwt = (payload: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('web sign-in rules', () => {
  test('Z.ai needs a token with a non-guest email', () => {
    const rule = ZAI_CHAT_SITE.signIn!;
    expect(evaluateSignIn(rule, jwt({ id: '1', email: 'me@example.com' }))).toEqual({ signedIn: true });
    expect(evaluateSignIn(rule, jwt({ id: '1', email: 'Guest-1700000000@guest.com' }))).toEqual({ signedIn: false, reason: 'signed in as a guest' });
    expect(evaluateSignIn(rule, jwt({ id: '1' }))).toEqual({ signedIn: false, reason: 'not signed in' });
    expect(evaluateSignIn(rule, null)).toEqual({ signedIn: false, reason: 'not signed in' });
    expect(evaluateSignIn(rule, 'not-a-jwt')).toEqual({ signedIn: false, reason: 'session token is not readable' });
  });

  test('Kimi needs an unexpired refresh token', () => {
    const rule = KIMI_CHAT_SITE.signIn!;
    expect(evaluateSignIn(rule, jwt({ exp: 2_000 }), 1_000_000)).toEqual({ signedIn: true });
    expect(evaluateSignIn(rule, jwt({ exp: 1_000 }), 1_000_000)).toEqual({ signedIn: false, reason: 'session expired' });
    expect(evaluateSignIn(rule, jwt({}), 0)).toEqual({ signedIn: false, reason: 'session expired' });
  });

  test('decodes base64url payloads and rejects garbage', () => {
    expect(decodeJwtPayload(jwt({ name: 'ÿ~?' }))).toEqual({ name: 'ÿ~?' });
    expect(decodeJwtPayload('a.%%%.c')).toBeUndefined();
    expect(decodeJwtPayload('single')).toBeUndefined();
  });

  test('maps opened URLs to known web chats', () => {
    expect(siteForUrl('https://chat.z.ai/c/123')?.id).toBe('glm-chat');
    expect(siteForUrl('https://www.kimi.ai/')?.id).toBe('kimi-chat');
    expect(siteForUrl('https://example.com/')).toBeUndefined();
  });
});

describe('WebSignInStatus', () => {
  function status(start = 0) {
    let now = start;
    const records = new Map<string, SignInRecord>();
    const tracker = new WebSignInStatus({ load: provider => records.get(provider), save: record => { records.set(record.provider, record); } }, () => now);
    return { tracker, records, advance: (ms: number) => { now += ms; } };
  }

  test('reports signed-out providers as unavailable for ten minutes', () => {
    const { tracker, advance } = status();
    expect(tracker.health('glm-chat')).toEqual({ available: true });
    tracker.record('glm-chat', false, 'chat.z.ai: not signed in; run: bun run account open https://chat.z.ai/');
    expect(tracker.health('glm-chat')).toEqual({ available: false, reason: 'chat.z.ai: not signed in; run: bun run account open https://chat.z.ai/' });
    advance(10 * 60_000);
    expect(tracker.health('glm-chat')).toEqual({ available: true });
  });

  test('picks up records written by another process after the cache expires', () => {
    const { tracker, records, advance } = status();
    tracker.record('kimi-chat', false, 'expired');
    records.set('kimi-chat', { provider: 'kimi-chat', signedIn: true, checkedAt: 1 });
    expect(tracker.health('kimi-chat').available).toBeFalse();
    advance(30_000);
    expect(tracker.health('kimi-chat').available).toBeTrue();
  });

  test('keeps working when the store fails', () => {
    const tracker = new WebSignInStatus({ load: () => { throw new Error('locked'); }, save: () => { throw new Error('locked'); } });
    tracker.record('glm-chat', false, 'nope');
    expect(tracker.health('glm-chat').available).toBeFalse();
    expect(new WebSignInStatus({ load: () => { throw new Error('locked'); }, save: () => {} }).health('x')).toEqual({ available: true });
  });

  test('persists records in the gateway database', () => {
    const db = openDatabase(':memory:');
    saveSignIn(db, { provider: 'glm-chat', signedIn: false, reason: 'guest', checkedAt: 5 });
    saveSignIn(db, { provider: 'glm-chat', signedIn: true, checkedAt: 6 });
    expect(loadSignIn(db, 'glm-chat')).toEqual({ provider: 'glm-chat', signedIn: true, checkedAt: 6 });
    expect(loadSignIn(db, 'kimi-chat')).toBeUndefined();
  });
});

describe('accounts CLI sign-in status', () => {
  function cli(signedIn: Record<string, boolean>) {
    const lines: string[] = [];
    const checked: Array<string | undefined> = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], add: () => { throw new Error('unused'); }, remove: () => false },
      signIn: async () => { throw new Error('unused'); },
      ask: async () => '',
      askHidden: async () => '',
      log: line => lines.push(line),
      openWindow: async () => {},
      checkSignIns: async url => {
        checked.push(url);
        const sites = url ? [siteForUrl(url)].filter(site => site !== undefined) : [ZAI_CHAT_SITE, KIMI_CHAT_SITE];
        return sites.map(site => ({ site, result: signedIn[site.id] ? { signedIn: true } : { signedIn: false, reason: 'not signed in' } }));
      },
    };
    return { deps, lines, checked };
  }

  test('status lists every web chat and fails when one is signed out', async () => {
    const { deps, lines } = cli({ 'glm-chat': true });
    expect(await runAccountsCommand(['status'], deps)).toBe(1);
    expect(lines).toEqual([
      '✓ glm-chat   chat.z.ai',
      '○ kimi-chat  www.kimi.ai: not signed in; run: bun run account open https://www.kimi.ai/',
    ]);
  });

  test('open checks the opened site after the window closes', async () => {
    const { deps, lines, checked } = cli({ 'kimi-chat': true });
    expect(await runAccountsCommand(['open', 'https://www.kimi.ai/'], deps)).toBe(0);
    expect(checked).toEqual(['https://www.kimi.ai/']);
    expect(lines.at(-1)).toBe('✓ kimi-chat  www.kimi.ai');
    expect(await runAccountsCommand(['open', 'https://example.com/'], deps)).toBe(0);
  });
});
