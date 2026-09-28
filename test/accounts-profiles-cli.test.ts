import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { buildOverview } from '../src/cli/overview.ts';
import type { BrowserProfile } from '../src/browser/profiles.ts';
import { KIMI_CHAT_SITE } from '../src/providers/kimi/web.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';

function cli() {
  const profiles: BrowserProfile[] = [{ id: 'default', label: 'Main' }];
  const lines: string[] = [];
  const opened: Array<[string[], string]> = [];
  const checked: Array<[string | undefined, string | undefined]> = [];
  const deps: AccountsCliDeps = {
    store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
    askHidden: async () => '',
    log: line => lines.push(line),
    chatUrls: [ZAI_CHAT_SITE.url, KIMI_CHAT_SITE.url],
    openWindow: async (urls, profile) => { opened.push([urls, profile]); },
    checkSignIns: async (url, profile) => {
      checked.push([url, profile]);
      const accounts = profiles.filter(entry => !profile || entry.id === profile);
      return accounts.flatMap(account => [ZAI_CHAT_SITE, KIMI_CHAT_SITE].map(site => ({
        site,
        profile: account,
        result: account.id === 'default' ? { signedIn: true } : { signedIn: false, reason: 'not signed in' },
      })));
    },
    profiles: {
      list: () => [...profiles],
      add: label => {
        const profile = { id: `acct-00000${profiles.length}`, label };
        profiles.push(profile);
        return profile;
      },
      remove: id => {
        const index = profiles.findIndex(profile => profile.id === id);
        if (index <= 0) return false;
        profiles.splice(index, 1);
        return true;
      },
    },
  };
  return { deps, lines, opened, checked, profiles };
}

describe('accounts CLI browser accounts', () => {
  test('creates, lists and removes accounts', async () => {
    const { deps, lines } = cli();
    expect(await runAccountsCommand(['profile', 'add', 'Work', 'account'], deps)).toBe(0);
    expect(lines.at(-1)).toBe('Created acct-000001 (Work account). Sign it in to the web chats: bun run account connect --profile acct-000001');
    lines.length = 0;
    await runAccountsCommand(['profiles'], deps);
    expect(lines).toEqual(['default\tMain', 'acct-000001\tWork account']);
    expect(await runAccountsCommand(['profile', 'remove', 'acct-000001'], deps)).toBe(0);
    expect(await runAccountsCommand(['profile', 'remove', 'acct-000001'], deps)).toBe(1);
  });

  test('connect opens Google and every web chat in the account, then checks that account', async () => {
    const { deps, opened, checked, lines } = cli();
    await runAccountsCommand(['profile', 'add', 'Work'], deps);
    expect(await runAccountsCommand(['connect', '--profile', 'acct-000001'], deps)).toBe(1);
    expect(opened).toEqual([[['https://accounts.google.com/', 'https://chat.z.ai/', 'https://www.kimi.ai/'], 'acct-000001']]);
    expect(checked).toEqual([[undefined, 'acct-000001']]);
    expect(lines.at(-1)).toStartWith('○ kimi-chat');
  });

  test('status checks every account and labels lines when there are several', async () => {
    const { deps, lines, checked } = cli();
    await runAccountsCommand(['profile', 'add', 'Work'], deps);
    lines.length = 0;
    await runAccountsCommand(['status'], deps);
    expect(checked).toEqual([[undefined, undefined]]);
    expect(lines).toEqual([
      '✓ glm-chat   chat.z.ai  [Main]',
      '✓ kimi-chat  www.kimi.ai  [Main]',
      '○ glm-chat   chat.z.ai: not signed in; run: bun run account open https://chat.z.ai/  [Work]',
      '○ kimi-chat  www.kimi.ai: not signed in; run: bun run account open https://www.kimi.ai/  [Work]',
    ]);
  });

  test('rejects unknown accounts and opens sites in the chosen account', async () => {
    const { deps, opened } = cli();
    await expect(runAccountsCommand(['open', 'https://chat.z.ai/', '--profile', 'acct-ffffff'], deps)).rejects.toThrow('Unknown account: acct-ffffff');
    await runAccountsCommand(['open', 'https://chat.z.ai/'], deps);
    expect(opened.at(-1)).toEqual([['https://chat.z.ai/'], 'default']);
  });
});

describe('overview across accounts', () => {
  test('summarises how many accounts are signed in to each web chat', () => {
    const now = 1_000_000;
    const rows = buildOverview({
      env: {},
      credentials: () => [],
      deepseekAccounts: () => [],
      accountStates: () => [],
      signIn: () => undefined,
      accountSignIns: provider => provider === 'glm-chat'
        ? [{ provider, profile: 'default', signedIn: true, checkedAt: now }, { provider, profile: 'acct-1', signedIn: false, checkedAt: now }]
        : [{ provider, profile: 'default', signedIn: false, checkedAt: now }, { provider, profile: 'acct-1', signedIn: false, checkedAt: now }],
      webSites: [ZAI_CHAT_SITE, KIMI_CHAT_SITE],
      now,
    });
    expect(rows[1]).toMatchObject({ id: 'glm-chat', state: 'degraded', detail: 'chat.z.ai: signed in on 1 of 2 accounts (checked just now)' });
    expect(rows[2]).toMatchObject({ id: 'kimi-chat', state: 'not-connected', detail: 'www.kimi.ai: not signed in on any of 2 accounts' });
  });
});
