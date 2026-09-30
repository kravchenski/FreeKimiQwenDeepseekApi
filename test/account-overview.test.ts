import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { buildOverview, formatOverview, type OverviewInput } from '../src/cli/overview.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';
import { ARENA_CHAT_SITE } from '../src/providers/arena/web.ts';
import { KIMI_CHAT_SITE } from '../src/providers/kimi/web.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';

const NOW = 10 * 60 * 60_000;

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    env: {},
    credentials: () => [],
    deepseekAccounts: () => [],
    accountStates: () => [],
    signIn: () => undefined,
    webSites: [ZAI_CHAT_SITE, KIMI_CHAT_SITE],
    now: NOW,
    ...overrides,
  };
}

describe('account overview', () => {
  test('shows every provider as not connected with the command to fix it', () => {
    const rows = buildOverview(input());
    expect(rows.map(row => [row.id, row.state, row.fix])).toEqual([
      ['deepseek', 'not-connected', 'bun run auth:deepseek'],
      ['glm-chat', 'unknown', 'bun run account status'],
      ['kimi-chat', 'unknown', 'bun run account status'],
      ['nvidia', 'not-connected', 'bun run account add nvidia --api-key'],
    ]);
  });

  test('summarises accounts, pool problems, web sign-ins and API keys', () => {
    const key: Credential = { id: 'nvidia-1', provider: 'nvidia', email: 'main', password: '', method: 'api-key', token: 'k' };
    const rows = buildOverview(input({
      credentials: () => [key],
      deepseekAccounts: () => [{ id: 'ds-1' }, { id: 'ds-2' }, { id: 'ds-3', invalid: true }],
      accountStates: () => [{ provider: 'deepseek', accountId: 'ds-2', status: 'quota_exhausted' }],
      signIn: provider => provider === 'glm-chat'
        ? { provider, signedIn: true, checkedAt: NOW - 5 * 60_000 }
        : { provider, signedIn: false, reason: 'www.kimi.ai: session expired; run: bun run account open https://www.kimi.ai/', checkedAt: NOW },
      autoEnabled: provider => provider !== 'nvidia',
    }));
    expect(rows).toEqual([
      { id: 'deepseek', kind: 'account', state: 'degraded', detail: '2 accounts (1 quota exhausted); 1 invalid', auto: true },
      { id: 'glm-chat', kind: 'web', state: 'connected', detail: 'chat.z.ai: signed in (checked 5 min ago)', url: 'https://chat.z.ai/', auto: true },
      { id: 'kimi-chat', kind: 'web', state: 'not-connected', detail: 'www.kimi.ai: session expired; run: bun run account open https://www.kimi.ai/', fix: 'bun run account open https://www.kimi.ai/', url: 'https://www.kimi.ai/', auto: true },
      { id: 'nvidia', kind: 'api-key', state: 'connected', detail: 'API key (saved)', auto: false },
    ]);
  });

  test('shows a web chat without sign-in as connected', () => {
    const rows = buildOverview(input({ webSites: [ARENA_CHAT_SITE] }));
    expect(rows[1]).toEqual({ id: 'arena-chat', kind: 'web', state: 'connected', detail: 'arena.ai: no sign-in needed', url: 'https://arena.ai/text/direct', auto: true });
  });

  test('reports a pool where every account is signed out as not connected', () => {
    const rows = buildOverview(input({
      deepseekAccounts: () => [{ id: 'ds-1' }],
      accountStates: () => [{ provider: 'deepseek', accountId: 'ds-1', status: 'unauthorized' }],
    }));
    expect(rows[0]).toEqual({ id: 'deepseek', kind: 'account', state: 'not-connected', detail: '1 account (1 signed out)', fix: 'bun run auth:deepseek', auto: true });
  });

  test('counts an environment key as connected', () => {
    const rows = buildOverview(input({ env: { NVIDIA_API_KEY: 'k' } }));
    expect(rows[3]).toEqual({ id: 'nvidia', kind: 'api-key', state: 'connected', detail: 'API key (environment)', auto: true });
  });

  test('explains a locked registry and survives failing sources', () => {
    const fail = () => { throw new Error('ACCOUNTS_SECRET is not set'); };
    const rows = buildOverview(input({ credentials: fail, deepseekAccounts: fail, accountStates: fail, signIn: fail, autoEnabled: fail }));
    expect(rows[3]).toEqual({ id: 'nvidia', kind: 'api-key', state: 'unknown', detail: 'registry locked: ACCOUNTS_SECRET is not set', fix: 'bun run account init', auto: true });
    expect(rows.map(row => row.state)).toEqual(['not-connected', 'unknown', 'unknown', 'unknown']);
  });

  test('formats a readable table with fixes under each row', () => {
    const text = formatOverview(buildOverview(input({ env: { NVIDIA_API_KEY: 'k' } })));
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Providers (1/4 connected)',
      '',
      '  ○ deepseek   no accounts',
      '               → bun run auth:deepseek',
    ]);
    expect(text).toContain('  ✓ nvidia     API key (environment)');
    expect(text).not.toContain('k)');
  });
});

describe('accounts CLI overview', () => {
  function cli() {
    const lines: string[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      overview: () => buildOverview(input()),
    };
    return { deps, lines };
  }

  test('shows the overview without a command and as JSON', async () => {
    const { deps, lines } = cli();
    expect(await runAccountsCommand([], deps)).toBe(0);
    expect(lines[0]).toStartWith('Providers (0/4 connected)');
    expect(await runAccountsCommand(['--json'], deps)).toBe(0);
    expect(JSON.parse(lines[1]!)).toHaveLength(4);
    expect(await runAccountsCommand(['help'], deps)).toBe(0);
    expect(lines[2]).toStartWith('Usage: bun run account');
  });
});
