import crypto from 'node:crypto';
import fs from 'node:fs';

import { KEYRING_ENTRY, type Keyring } from '../core/secrets/accounts-secret.ts';

const SECRET_LINE = /^ACCOUNTS_SECRET=(.*)$/m;
const SECRET_LINE_WITH_BREAK = /^ACCOUNTS_SECRET=.*(?:\r?\n|$)/m;

export type InitResult = 'created' | 'moved' | 'exists' | 'environment' | 'created-in-env-file' | 'exists-in-env-file';

export interface InitOptions {
  envFile: string;
  env: Record<string, string | undefined>;
  keyring: Keyring;
  random?: () => string;
}

const randomSecret = () => crypto.randomBytes(32).toString('base64');

export function readFileSecret(envFile: string) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  return current.match(SECRET_LINE)?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
}

function writeEnvFile(envFile: string, content: string) {
  fs.writeFileSync(envFile, content, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
}

export function ensureAccountsSecret(envFile: string, random: () => string = randomSecret) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (readFileSecret(envFile)) return 'exists' as const;
  const line = `ACCOUNTS_SECRET=${random()}`;
  writeEnvFile(envFile, SECRET_LINE.test(current)
    ? current.replace(SECRET_LINE, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  return 'created' as const;
}

function removeFileSecret(envFile: string) {
  writeEnvFile(envFile, fs.readFileSync(envFile, 'utf8').replace(SECRET_LINE_WITH_BREAK, ''));
}

async function keyringValue(keyring: Keyring) {
  try {
    return { ok: true as const, value: (await keyring.get(KEYRING_ENTRY)) || undefined };
  } catch {
    return { ok: false as const };
  }
}

async function storeInKeyring(keyring: Keyring, value: string) {
  try {
    await keyring.set({ ...KEYRING_ENTRY, value });
    return (await keyring.get(KEYRING_ENTRY)) === value;
  } catch {
    return false;
  }
}

export async function initAccountsSecret({ envFile, env, keyring, random = randomSecret }: InitOptions): Promise<InitResult> {
  const fileSecret = readFileSecret(envFile);
  const stored = await keyringValue(keyring);
  if (fileSecret) {
    if (!stored.ok) return 'exists-in-env-file';
    if (stored.value && stored.value !== fileSecret) {
      throw new Error('.env and the system keyring hold different ACCOUNTS_SECRET values. Remove the one that does not open session/credentials.enc, then run this command again.');
    }
    if (!stored.value && !await storeInKeyring(keyring, fileSecret)) return 'exists-in-env-file';
    removeFileSecret(envFile);
    return 'moved';
  }
  if (env.ACCOUNTS_SECRET) return 'environment';
  if (!stored.ok) {
    ensureAccountsSecret(envFile, random);
    return 'created-in-env-file';
  }
  if (stored.value) return 'exists';
  if (await storeInKeyring(keyring, random())) return 'created';
  ensureAccountsSecret(envFile, random);
  return 'created-in-env-file';
}

export const INIT_MESSAGES: Record<InitResult, string> = {
  created: 'Created ACCOUNTS_SECRET in the system keyring. Restart the gateway to use saved accounts.',
  moved: 'Moved ACCOUNTS_SECRET from .env to the system keyring and removed it from .env. Restart the gateway.',
  exists: 'ACCOUNTS_SECRET is already in the system keyring.',
  environment: 'ACCOUNTS_SECRET comes from the environment; it is left there.',
  'created-in-env-file': 'No system keyring is available, so ACCOUNTS_SECRET was written to .env (mode 600).',
  'exists-in-env-file': 'ACCOUNTS_SECRET stays in .env because the system keyring is not available.',
};
