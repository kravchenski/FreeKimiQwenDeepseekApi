import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureAccountsSecret } from '../src/cli/accounts-secret.ts';
import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';

const envFile = () => join(mkdtempSync(join(tmpdir(), 'env-')), '.env');

describe('ensureAccountsSecret', () => {
  test('fills an empty ACCOUNTS_SECRET line and keeps the rest of the file', () => {
    const file = envFile();
    writeFileSync(file, 'NVIDIA_API_KEY=k\nACCOUNTS_SECRET=\nHOST=0.0.0.0\n');
    expect(ensureAccountsSecret(file, () => 'generated')).toBe('created');
    expect(readFileSync(file, 'utf8')).toBe('NVIDIA_API_KEY=k\nACCOUNTS_SECRET=generated\nHOST=0.0.0.0\n');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('appends the secret to a file without it or creates the file', () => {
    const file = envFile();
    writeFileSync(file, 'HOST=0.0.0.0');
    ensureAccountsSecret(file, () => 'a');
    expect(readFileSync(file, 'utf8')).toBe('HOST=0.0.0.0\nACCOUNTS_SECRET=a\n');
    const fresh = envFile();
    ensureAccountsSecret(fresh);
    expect(readFileSync(fresh, 'utf8')).toMatch(/^ACCOUNTS_SECRET=[A-Za-z0-9+/]{43}=\n$/);
  });

  test('never replaces an existing secret', () => {
    const file = envFile();
    writeFileSync(file, 'ACCOUNTS_SECRET="keep-me"\n');
    expect(ensureAccountsSecret(file, () => 'new')).toBe('exists');
    expect(readFileSync(file, 'utf8')).toBe('ACCOUNTS_SECRET="keep-me"\n');
  });

  test('the CLI reports what happened', async () => {
    const lines: string[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], add: () => { throw new Error('unused'); }, remove: () => false },
      signIn: async () => { throw new Error('unused'); },
      ask: async () => '',
      askHidden: async () => '',
      log: line => lines.push(line),
      initSecret: () => 'created',
    };
    expect(await runAccountsCommand(['init'], deps)).toBe(0);
    expect(lines[0]).toContain('Created ACCOUNTS_SECRET');
  });
});
