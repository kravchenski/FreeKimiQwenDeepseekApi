export const KEYRING_ENTRY = { service: 'free-ai-gateway', name: 'ACCOUNTS_SECRET' };

export interface Keyring {
  get(entry: { service: string; name: string }): Promise<string | null>;
  set(entry: { service: string; name: string; value: string }): Promise<void>;
}

export const systemKeyring: Keyring = {
  get: entry => Bun.secrets.get(entry),
  set: entry => Bun.secrets.set(entry),
};

export type SecretSource = 'environment' | 'keyring' | 'missing';

let loaded: string | undefined;

export function accountsSecret(env: Record<string, string | undefined> = process.env) {
  return env.ACCOUNTS_SECRET || loaded;
}

export async function loadAccountsSecret(keyring: Keyring = systemKeyring, env: Record<string, string | undefined> = process.env): Promise<SecretSource> {
  if (env.ACCOUNTS_SECRET) {
    loaded = env.ACCOUNTS_SECRET;
    delete env.ACCOUNTS_SECRET;
    return 'environment';
  }
  try {
    loaded = (await keyring.get(KEYRING_ENTRY)) || undefined;
  } catch {
    loaded = undefined;
  }
  return loaded ? 'keyring' : 'missing';
}

export function forgetAccountsSecret() {
  loaded = undefined;
}
