import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';

function harness(signInResult: () => Promise<{ token: string; expiresAt?: number }> = async () => ({ token: 't', expiresAt: 0 })) {
  const saved: Credential[] = [];
  const lines: string[] = [];
  const signIns: string[] = [];
  const deps: AccountsCliDeps = {
    store: {
      list: provider => saved.filter(entry => !provider || entry.provider === provider),
      add: input => {
        const credential = { ...input, id: `${input.provider}-${saved.length + 1}` };
        saved.push(credential);
        return credential;
      },
      remove: id => {
        const index = saved.findIndex(entry => entry.id === id);
        if (index === -1) return false;
        saved.splice(index, 1);
        return true;
      },
    },
    signIn: async email => {
      signIns.push(email);
      return signInResult();
    },
    ask: async () => 'typed@example.com',
    askHidden: async () => 'hidden-pw',
    log: line => lines.push(line),
  };
  return { deps, saved, lines, signIns };
}

describe('accounts CLI', () => {
  test('verifies credentials before saving an account', async () => {
    const { deps, saved, signIns } = harness();
    expect(await runAccountsCommand(['add', 'qwen', '--email', 'a@example.com'], deps)).toBe(0);
    expect(signIns).toEqual(['a@example.com']);
    expect(saved).toEqual([{ id: 'qwen-1', provider: 'qwen', email: 'a@example.com', password: 'hidden-pw' }]);
  });

  test('does not save an account whose sign-in fails', async () => {
    const { deps, saved } = harness(async () => { throw new Error('Qwen sign-in failed: 400 wrong password'); });
    await expect(runAccountsCommand(['add', 'qwen'], deps)).rejects.toThrow('wrong password');
    expect(saved).toEqual([]);
  });

  test('prompts for email and can skip verification', async () => {
    const { deps, saved, signIns } = harness();
    await runAccountsCommand(['add', 'qwen', '--no-verify'], deps);
    expect(signIns).toEqual([]);
    expect(saved[0]!.email).toBe('typed@example.com');
  });

  test('lists accounts without printing passwords', async () => {
    const { deps, lines } = harness();
    await runAccountsCommand(['add', 'qwen', '--email', 'a@example.com'], deps);
    lines.length = 0;
    await runAccountsCommand(['list'], deps);
    expect(lines).toEqual(['qwen-1\tqwen\ta@example.com']);
    expect(lines.join('\n')).not.toContain('hidden-pw');
  });

  test('tests and removes accounts by id', async () => {
    const { deps, lines } = harness();
    await runAccountsCommand(['add', 'qwen', '--email', 'a@example.com', '--no-verify'], deps);
    expect(await runAccountsCommand(['test', 'qwen-1'], deps)).toBe(0);
    expect(lines.at(-1)).toStartWith('OK a@example.com');
    expect(await runAccountsCommand(['remove', 'qwen-1'], deps)).toBe(0);
    expect(await runAccountsCommand(['remove', 'qwen-1'], deps)).toBe(1);
    expect(await runAccountsCommand(['test', 'qwen-1'], deps)).toBe(1);
  });

  test('rejects unknown providers and commands', async () => {
    const { deps } = harness();
    await expect(runAccountsCommand(['add', 'openai'], deps)).rejects.toThrow('Unknown provider: openai');
    expect(await runAccountsCommand(['explode'], deps)).toBe(1);
    expect(await runAccountsCommand([], deps)).toBe(0);
  });

  test('opens the Google profile then lists its accounts', async () => {
    const { deps, lines } = harness();
    const opened: string[] = [];
    deps.openGoogleSignIn = async () => { opened.push('open'); };
    deps.listGoogleAccounts = async () => ['a@gmail.com', 'b@gmail.com'];

    expect(await runAccountsCommand(['google'], deps)).toBe(0);
    expect(opened).toEqual(['open']);
    expect(lines.slice(-2)).toEqual(['google\ta@gmail.com', 'google\tb@gmail.com']);

    expect(await runAccountsCommand(['google', '--list'], deps)).toBe(0);
    expect(opened).toEqual(['open']);
  });
});

