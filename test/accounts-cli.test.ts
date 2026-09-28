import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';

function harness() {
  const saved: Credential[] = [];
  const lines: string[] = [];
  const deps: AccountsCliDeps = {
    store: {
      list: provider => saved.filter(entry => !provider || entry.provider === provider),
      addApiKey: input => {
        const credential: Credential = { id: `${input.provider}-${saved.length + 1}`, provider: input.provider, email: input.label, password: '', method: 'api-key', token: input.apiKey };
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
    askHidden: async () => 'nvapi-secret',
    log: line => lines.push(line),
    verifyApiKey: async () => 3,
  };
  return { deps, saved, lines };
}

describe('accounts CLI', () => {
  test('lists saved keys without printing them, checks and removes them by id', async () => {
    const { deps, lines } = harness();
    await runAccountsCommand(['add', 'nvidia', '--api-key', '--label', 'main', '--no-verify'], deps);
    lines.length = 0;
    await runAccountsCommand(['list'], deps);
    expect(lines).toEqual(['nvidia-1\tnvidia\tmain']);
    expect(lines.join('\n')).not.toContain('nvapi-secret');
    expect(await runAccountsCommand(['test', 'nvidia-1'], deps)).toBe(0);
    expect(lines.at(-1)).toBe('OK main: 3 models available');
    expect(await runAccountsCommand(['remove', 'nvidia-1'], deps)).toBe(0);
    expect(await runAccountsCommand(['remove', 'nvidia-1'], deps)).toBe(1);
    expect(await runAccountsCommand(['test', 'nvidia-1'], deps)).toBe(1);
  });

  test('rejects unknown providers and commands and points to the API key flag', async () => {
    const { deps } = harness();
    await expect(runAccountsCommand(['add', 'qwen'], deps)).rejects.toThrow('Unknown provider: qwen');
    await expect(runAccountsCommand(['add', 'nvidia'], deps)).rejects.toThrow('Use: bun run account add nvidia --api-key');
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

  test('opens https sites in the browser profile and rejects anything else', async () => {
    const { deps } = harness();
    const opened: string[] = [];
    deps.openWindow = async url => { opened.push(url); };
    expect(await runAccountsCommand(['open', 'https://www.kimi.com'], deps)).toBe(0);
    expect(opened).toEqual(['https://www.kimi.com/']);
    await expect(runAccountsCommand(['open', 'http://chat.z.ai'], deps)).rejects.toThrow('https');
    await expect(runAccountsCommand(['open', 'kimi.com'], deps)).rejects.toThrow('full https URL');
  });
});
