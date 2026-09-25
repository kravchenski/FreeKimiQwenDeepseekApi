import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../src/core/accounts/credential-store.ts';
import { open, seal } from '../src/core/secrets/vault.ts';

const SECRET = 'correct horse battery staple';

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'vault-')), 'accounts.enc');
}

describe('vault', () => {
  test('round-trips data with a fresh salt and iv each time', () => {
    const first = seal('hello', SECRET);
    expect(open(first, SECRET)).toBe('hello');
    expect(seal('hello', SECRET)).not.toBe(first);
  });

  test('rejects wrong secrets, tampering and short secrets', () => {
    const payload = seal('hello', SECRET);
    expect(() => open(payload, 'another long secret value')).toThrow('decryption failed');
    const tampered = Buffer.from(payload, 'base64');
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(tampered.toString('base64'), SECRET)).toThrow('decryption failed');
    expect(() => seal('hello', 'short')).toThrow('at least 16');
  });
});

describe('CredentialStore', () => {
  test('stores multiple accounts encrypted with owner-only permissions', () => {
    const file = tempFile();
    const store = new CredentialStore(file, SECRET);
    store.add({ provider: 'qwen', email: 'A@Example.com ', password: 'pw-a' });
    store.add({ provider: 'qwen', email: 'b@example.com', password: 'pw-b' });
    store.add({ provider: 'deepseek', email: 'c@example.com', password: 'pw-c' });

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('example.com');
    expect(raw).not.toContain('pw-a');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const reopened = new CredentialStore(file, SECRET);
    expect(reopened.list('qwen').map(credential => credential.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(reopened.list()).toHaveLength(3);
  });

  test('rejects duplicates and removes by id', () => {
    const store = new CredentialStore(tempFile(), SECRET);
    const added = store.add({ provider: 'qwen', email: 'a@example.com', password: 'pw' });
    expect(() => store.add({ provider: 'qwen', email: 'A@example.com', password: 'other' })).toThrow('already exists');
    expect(store.remove(added.id)).toBeTrue();
    expect(store.remove(added.id)).toBeFalse();
    expect(store.list()).toEqual([]);
  });

  test('requires a secret and fails loudly on a wrong one', () => {
    const file = tempFile();
    expect(new CredentialStore(file, undefined).list()).toEqual([]);
    expect(() => new CredentialStore(file, undefined).add({ provider: 'qwen', email: 'a@example.com', password: 'pw' }))
      .toThrow('ACCOUNTS_SECRET');
    new CredentialStore(file, SECRET).add({ provider: 'qwen', email: 'a@example.com', password: 'pw' });
    expect(() => new CredentialStore(file, 'a different long secret').list()).toThrow('decryption failed');
    writeFileSync(file, 'garbage');
    expect(() => new CredentialStore(file, SECRET).list()).toThrow('Unsupported');
  });
});
