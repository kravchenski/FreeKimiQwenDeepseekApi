import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { buildOverview, formatOverview, type OverviewInput } from '../src/cli/overview.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';
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

const qwenAccount = (id: string): Credential => ({ id, provider: 'qwen', email: `${id}@example.com`, password: '', method: 'browser', token: 't' });

describe('account overview', () => {
  test('shows every provider as not connected with the command to fix it', () => {
    const rows = buildOverview(input());
    expect(rows.map(row => [row.id, row.state, row.fix])).toEqual([
      ['qwen', 'not-connected', 'bun run account add qwen --browser'],
      ['deepseek', 'not-connected', 'bun run auth:deepseek'],
      ['glm-chat', 'unknown', 'bun run account status'],
      ['kimi-chat', 'unknown', 'bun run account status'],
      ['nvidia', 'not-connected', 'bun run account add nvidia --api-key'],
    ]);
  });

  test('summarises accounts, pool problems, web sign-ins and API keys', () => {
    const rows = buildOverview(input({
      credentials: () => [qwenAccount('qwen-a'), qwenAccount('qwen-b'), { id: 'nvidia-1', provider: 'nvidia', email: 'main', password: '', method: 'api-key', token: 'k' }],
      deepseekAccounts: () => [{ id: 'ds-1' }, { id: 'ds-2', invalid: true }],
      accountStates: () => [
        { provider: 'qwen', accountId: 'qwen-b', status: 'quota_exhausted' },
        { provider: 'deepseek', accountId: 'ds-1', status: 'unauthorized' },
      ],
      signIn: provider => provider === 'glm-chat'
        ? { provider, signedIn: true, checkedAt: NOW - 5 * 60_000 }
        : { provider, signedIn: false, reason: 'www.kimi.ai: session expired; run: bun run account open https://www.kimi.ai/', checkedAt: NOW },
    }));
    expect(rows).toEqual([
      { id: 'qwen', kind: 'account', state: 'degraded', detail: '2 accounts (1 quota exhausted)' },
      { id: 'deepseek', kind: 'account', state: 'not-connected', detail: '1 account (1 signed out); 1 invalid', fix: 'bun run auth:deepseek' },
      { id: 'glm-chat', kind: 'web', state: 'connected', detail: 'chat.z.ai: signed in (checked 5 min ago)' },
      { id: 'kimi-chat', kind: 'web', state: 'not-connected', detail: 'www.kimi.ai: session expired; run: bun run account open https://www.kimi.ai/', fix: 'bun run account open https://www.kimi.ai/' },
      { id: 'nvidia', kind: 'api-key', state: 'connected', detail: 'API key (saved)' },
    ]);
  });

  test('counts environment tokens and keys as connected', () => {
    const rows = buildOverview(input({ env: { QWEN_TOKEN: 't', NVIDIA_API_KEY: 'k' } }));
    expect(rows[0]).toEqual({ id: 'qwen', kind: 'account', state: 'connected', detail: 'QWEN_TOKEN' });
    expect(rows[4]).toEqual({ id: 'nvidia', kind: 'api-key', state: 'connected', detail: 'API key (environment)' });
  });

  test('explains a locked registry and survives failing sources', () => {
    const fail = () => { throw new Error('ACCOUNTS_SECRET is not set'); };
    const rows = buildOverview(input({ credentials: fail, deepseekAccounts: fail, accountStates: fail, signIn: fail }));
    expect(rows[0]).toEqual({ id: 'qwen', kind: 'account', state: 'unknown', detail: 'registry locked: ACCOUNTS_SECRET is not set', fix: 'bun run account init' });
    expect(rows.map(row => row.state)).toEqual(['unknown', 'not-connected', 'unknown', 'unknown', 'not-connected']);
  });

  test('formats a readable table with fixes under each row', () => {
    const text = formatOverview(buildOverview(input({ env: { NVIDIA_API_KEY: 'k' } })));
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Providers (1/5 connected)',
      '',
      '  ○ qwen       no accounts',
      '               → bun run account add qwen --browser',
      '  ○ deepseek   no accounts',
    ]);
    expect(text).toContain('  ✓ nvidia     API key (environment)');
    expect(text).not.toContain('k)');
  });
});

describe('accounts CLI overview', () => {
  function cli() {
    const lines: string[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], add: () => { throw new Error('unused'); }, remove: () => false },
      signIn: async () => { throw new Error('unused'); },
      ask: async () => '',
      askHidden: async () => '',
      log: line => lines.push(line),
      overview: () => buildOverview(input()),
    };
    return { deps, lines };
  }

  test('shows the overview without a command and as JSON', async () => {
    const { deps, lines } = cli();
    expect(await runAccountsCommand([], deps)).toBe(0);
    expect(lines[0]).toStartWith('Providers (0/5 connected)');
    expect(await runAccountsCommand(['--json'], deps)).toBe(0);
    expect(JSON.parse(lines[1]!)).toHaveLength(5);
    expect(await runAccountsCommand(['help'], deps)).toBe(0);
    expect(lines[2]).toStartWith('Usage: bun run account');
  });
});
