import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { CredentialStore, savedApiKey } from '../src/core/accounts/credential-store.ts';
import { createNvidiaProvider, verifyNvidiaKey } from '../src/providers/catalog.ts';

const SECRET = 'correct horse battery staple';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'registry-'));
}

function cli(verify: AccountsCliDeps['verifyApiKey'] = async () => 82) {
  const lines: string[] = [];
  const store = new CredentialStore(join(tempDir(), 'credentials.enc'), SECRET);
  const deps: AccountsCliDeps = {
    store,
    askHidden: async () => '  nvapi-secret  ',
    log: line => lines.push(line),
    verifyApiKey: verify,
  };
  return { deps, lines, store };
}

describe('credential registry', () => {
  test('stores API keys next to other accounts and finds them by provider', () => {
    const store = new CredentialStore(join(tempDir(), 'credentials.enc'), SECRET);
    store.add({ provider: 'qwen', email: 'a@example.com', password: 'pw' });
    const key = store.addApiKey({ provider: 'nvidia', label: 'Main', apiKey: ' nvapi-1 ' });
    expect(key).toMatchObject({ provider: 'nvidia', email: 'main', method: 'api-key', token: 'nvapi-1' });
    expect(store.list().map(entry => entry.provider)).toEqual(['qwen', 'nvidia']);
    expect(savedApiKey(store, 'nvidia')).toBe('nvapi-1');
    expect(savedApiKey(store, 'qwen')).toBeUndefined();
    expect(() => store.addApiKey({ provider: 'nvidia', label: 'main', apiKey: 'x' })).toThrow('already exists');
    expect(() => store.addApiKey({ provider: 'nvidia', label: 'other', apiKey: ' ' })).toThrow('required');
  });

  test('returns no saved key when the registry cannot be opened', () => {
    const store = new CredentialStore(join(tempDir(), 'credentials.enc'), undefined);
    expect(savedApiKey({ list: () => { throw new Error('ACCOUNTS_SECRET is not set'); } }, 'nvidia')).toBeUndefined();
    expect(() => store.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'k' })).toThrow('ACCOUNTS_SECRET');
  });

  test('NVIDIA uses a saved key when the environment has none', async () => {
    const calls: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls.push(String((init.headers as Record<string, string>).Authorization));
      return new Response('data: [DONE]\n\n');
    }) as unknown as typeof fetch;
    const nvidia = createNvidiaProvider({ env: {}, fetch: fetchFn }, { list: () => [{ method: 'api-key', token: 'saved-key' }] });
    expect(nvidia.health()).toEqual({ available: true });
    await nvidia.stream({ model: 'nvidia/nemotron-3-super-120b-a12b', messages: [] });
    expect(calls).toEqual(['Bearer saved-key']);
    const envFirst = createNvidiaProvider({ env: { NVIDIA_API_KEY: 'env-key' }, fetch: fetchFn }, { list: () => [{ method: 'api-key', token: 'saved-key' }] });
    await envFirst.stream({ model: 'nvidia/nemotron-3-super-120b-a12b', messages: [] });
    expect(calls[1]).toBe('Bearer env-key');
  });

  test('checks an NVIDIA key against the model list', async () => {
    const ok = (async () => Response.json({ data: [{}, {}, {}] })) as unknown as typeof fetch;
    const denied = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    expect(await verifyNvidiaKey('k', ok)).toBe(3);
    await expect(verifyNvidiaKey('k', denied)).rejects.toThrow('NVIDIA key check failed: 401');
  });
});

describe('accounts CLI API keys', () => {
  test('prompts for the key, verifies it and saves it with a label', async () => {
    const { deps, lines, store } = cli();
    expect(await runAccountsCommand(['add', 'nvidia', '--api-key', '--label', 'Work'], deps)).toBe(0);
    expect(lines[0]).toBe('Key works: 82 models available');
    expect(store.list('nvidia')).toMatchObject([{ email: 'work', method: 'api-key', token: 'nvapi-secret' }]);
    await runAccountsCommand(['list'], deps);
    expect(lines.at(-1)).toMatch(/^nvidia-[0-9a-f]{8}\tnvidia\twork$/);
    expect(lines.join('\n')).not.toContain('nvapi-secret');
  });

  test('does not save a key that fails the check', async () => {
    const { deps, store } = cli(async () => { throw new Error('NVIDIA key check failed: 401'); });
    await expect(runAccountsCommand(['add', 'nvidia', '--api-key'], deps)).rejects.toThrow('401');
    expect(store.list()).toEqual([]);
  });

  test('tests saved keys and refuses other sign-in methods', async () => {
    const { deps, lines, store } = cli();
    const key = store.addApiKey({ provider: 'nvidia', label: 'default', apiKey: 'k' });
    expect(await runAccountsCommand(['test', key.id], deps)).toBe(0);
    expect(lines.at(-1)).toBe('OK default: 82 models available');
    await expect(runAccountsCommand(['add', 'nvidia', '--email', 'a@b.c'], deps)).rejects.toThrow('bun run account add nvidia --api-key');
    await expect(runAccountsCommand(['add', 'qwen', '--api-key'], deps)).rejects.toThrow('Unknown provider: qwen');
  });
});
