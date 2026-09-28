import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureAccountsSecret, initAccountsSecret, readFileSecret } from '../src/cli/accounts-secret.ts';
import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { CredentialStore } from '../src/core/accounts/credential-store.ts';
import { accountsSecret, forgetAccountsSecret, KEYRING_ENTRY, loadAccountsSecret, type Keyring } from '../src/core/secrets/accounts-secret.ts';

const envFile = () => join(mkdtempSync(join(tmpdir(), 'env-')), '.env');

function fakeKeyring(initial?: string, options: { broken?: boolean; dropWrites?: boolean } = {}) {
  let value = initial;
  const keyring: Keyring = {
    get: async entry => {
      if (options.broken) throw new Error('no keyring daemon');
      expect(entry).toEqual(KEYRING_ENTRY);
      return value ?? null;
    },
    set: async entry => {
      if (options.broken) throw new Error('no keyring daemon');
      if (!options.dropWrites) value = entry.value;
    },
  };
  return { keyring, value: () => value };
}

afterEach(forgetAccountsSecret);

describe('initAccountsSecret', () => {
  test('creates a new secret in the keyring and leaves .env untouched', async () => {
    const file = envFile();
    writeFileSync(file, 'HOST=0.0.0.0\n');
    const store = fakeKeyring();
    expect(await initAccountsSecret({ envFile: file, env: {}, keyring: store.keyring, random: () => 'fresh' })).toBe('created');
    expect(store.value()).toBe('fresh');
    expect(readFileSync(file, 'utf8')).toBe('HOST=0.0.0.0\n');
  });

  test('moves a secret out of .env into the keyring', async () => {
    const file = envFile();
    writeFileSync(file, 'NVIDIA_API_KEY=k\nACCOUNTS_SECRET="from-file"\nHOST=0.0.0.0\n');
    const store = fakeKeyring();
    expect(await initAccountsSecret({ envFile: file, env: { ACCOUNTS_SECRET: 'from-file' }, keyring: store.keyring })).toBe('moved');
    expect(store.value()).toBe('from-file');
    expect(readFileSync(file, 'utf8')).toBe('NVIDIA_API_KEY=k\nHOST=0.0.0.0\n');
    expect(readFileSecret(file)).toBeUndefined();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('removes the .env copy when the keyring already has the same secret', async () => {
    const file = envFile();
    writeFileSync(file, 'ACCOUNTS_SECRET=same');
    expect(await initAccountsSecret({ envFile: file, env: {}, keyring: fakeKeyring('same').keyring })).toBe('moved');
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  test('refuses to pick between two different secrets', async () => {
    const file = envFile();
    writeFileSync(file, 'ACCOUNTS_SECRET=file\n');
    const store = fakeKeyring('keyring');
    await expect(initAccountsSecret({ envFile: file, env: {}, keyring: store.keyring })).rejects.toThrow('different ACCOUNTS_SECRET');
    expect(readFileSecret(file)).toBe('file');
    expect(store.value()).toBe('keyring');
  });

  test('keeps the .env secret when the keyring does not store it', async () => {
    const file = envFile();
    writeFileSync(file, 'ACCOUNTS_SECRET=file\n');
    expect(await initAccountsSecret({ envFile: file, env: {}, keyring: fakeKeyring(undefined, { dropWrites: true }).keyring })).toBe('exists-in-env-file');
    expect(readFileSecret(file)).toBe('file');
    expect(await initAccountsSecret({ envFile: file, env: {}, keyring: fakeKeyring(undefined, { broken: true }).keyring })).toBe('exists-in-env-file');
  });

  test('falls back to .env without a keyring and respects real environment secrets', async () => {
    const file = envFile();
    expect(await initAccountsSecret({ envFile: file, env: {}, keyring: fakeKeyring(undefined, { broken: true }).keyring, random: () => 'fallback' })).toBe('created-in-env-file');
    expect(readFileSecret(file)).toBe('fallback');
    const other = envFile();
    expect(await initAccountsSecret({ envFile: other, env: { ACCOUNTS_SECRET: 'docker' }, keyring: fakeKeyring().keyring })).toBe('environment');
    expect(existsSync(other)).toBeFalse();
    expect(await initAccountsSecret({ envFile: other, env: {}, keyring: fakeKeyring('stored').keyring })).toBe('exists');
  });
});

describe('loadAccountsSecret', () => {
  test('prefers the environment and removes it so child processes do not inherit it', async () => {
    const env: Record<string, string | undefined> = { ACCOUNTS_SECRET: 'env-secret', OTHER: 'x' };
    expect(await loadAccountsSecret(fakeKeyring('keyring-secret').keyring, env)).toBe('environment');
    expect(env).toEqual({ OTHER: 'x' });
    expect(accountsSecret({})).toBe('env-secret');
  });

  test('reads the keyring and reports a missing or broken keyring', async () => {
    expect(await loadAccountsSecret(fakeKeyring('keyring-secret').keyring, {})).toBe('keyring');
    expect(accountsSecret({})).toBe('keyring-secret');
    expect(await loadAccountsSecret(fakeKeyring().keyring, {})).toBe('missing');
    expect(accountsSecret({})).toBeUndefined();
    expect(await loadAccountsSecret(fakeKeyring(undefined, { broken: true }).keyring, {})).toBe('missing');
  });

  test('the credential store reads the loaded secret lazily', async () => {
    const store = new CredentialStore(join(mkdtempSync(join(tmpdir(), 'lazy-')), 'credentials.enc'), () => accountsSecret({}));
    expect(() => store.list()).not.toThrow();
    expect(() => store.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'k' })).toThrow('run: bun run account init');
    await loadAccountsSecret(fakeKeyring('correct horse battery staple').keyring, {});
    store.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'k' });
    expect(store.list()).toHaveLength(1);
  });
});

describe('ensureAccountsSecret', () => {
  test('fills an empty line, appends, and never replaces an existing secret', () => {
    const file = envFile();
    writeFileSync(file, 'A=1\nACCOUNTS_SECRET=\n');
    expect(ensureAccountsSecret(file, () => 'generated')).toBe('created');
    expect(readFileSync(file, 'utf8')).toBe('A=1\nACCOUNTS_SECRET=generated\n');
    expect(ensureAccountsSecret(file, () => 'new')).toBe('exists');
    const fresh = envFile();
    ensureAccountsSecret(fresh);
    expect(readFileSync(fresh, 'utf8')).toMatch(/^ACCOUNTS_SECRET=[A-Za-z0-9+/]{43}=\n$/);
  });
});

describe('accounts CLI secret commands', () => {
  test('init and secret print what happened', async () => {
    const lines: string[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], add: () => { throw new Error('unused'); }, remove: () => false },
      signIn: async () => { throw new Error('unused'); },
      ask: async () => '',
      askHidden: async () => '',
      log: line => lines.push(line),
      initSecret: async () => 'Moved ACCOUNTS_SECRET',
      secretSource: async () => 'keyring',
    };
    expect(await runAccountsCommand(['init'], deps)).toBe(0);
    expect(await runAccountsCommand(['secret'], deps)).toBe(0);
    expect(lines).toEqual(['Moved ACCOUNTS_SECRET', 'ACCOUNTS_SECRET: keyring']);
  });
});
