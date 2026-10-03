import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { accountsSecret } from '../secrets/accounts-secret.ts';
import { open, seal } from '../secrets/vault.ts';

export interface Credential {
  id: string;
  provider: string;
  email: string;
  password: string;
  method?: 'password' | 'api-key';
  token?: string;
  expiresAt?: number;
}

export interface ApiKeyCredential {
  provider: string;
  label: string;
  apiKey: string;
}

export const CREDENTIALS_FILE = path.resolve(process.env.SESSION_DIR || 'session', 'credentials.enc');

export class CredentialStore {
  constructor(
    private readonly file: string,
    private readonly secret: string | undefined | (() => string | undefined),
  ) {}

  list(provider?: string) {
    const credentials = this.read();
    return provider ? credentials.filter(credential => credential.provider === provider) : credentials;
  }

  add(input: Omit<Credential, 'id'>) {
    const credentials = this.read();
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password) throw new Error('Email and password are required');
    if (credentials.some(credential => credential.provider === input.provider && credential.email === email)) {
      throw new Error(`Account already exists: ${input.provider} ${email}`);
    }
    const credential = { ...input, email, id: `${input.provider}-${crypto.randomBytes(4).toString('hex')}` };
    this.write([...credentials, credential]);
    return credential;
  }

  addApiKey(input: ApiKeyCredential) {
    const label = input.label.trim().toLowerCase();
    const apiKey = input.apiKey.trim();
    if (!label || !apiKey) throw new Error('Label and API key are required');
    const credentials = this.read();
    if (credentials.some(credential => credential.provider === input.provider && credential.email === label)) {
      throw new Error(`Account already exists: ${input.provider} ${label}`);
    }
    const credential: Credential = {
      id: `${input.provider}-${crypto.randomBytes(4).toString('hex')}`,
      provider: input.provider,
      email: label,
      password: '',
      method: 'api-key',
      token: apiKey,
    };
    this.write([...credentials, credential]);
    return credential;
  }

  remove(id: string) {
    const credentials = this.read();
    const remaining = credentials.filter(credential => credential.id !== id);
    if (remaining.length === credentials.length) return false;
    this.write(remaining);
    return true;
  }

  private requireSecret() {
    const secret = typeof this.secret === 'function' ? this.secret() : this.secret;
    if (!secret) throw new Error('ACCOUNTS_SECRET is not set; run: bun run account init');
    return secret;
  }

  private read(): Credential[] {
    if (!fs.existsSync(this.file)) return [];
    const payload = fs.readFileSync(this.file, 'utf8').trim();
    return JSON.parse(open(payload, this.requireSecret()));
  }

  private write(credentials: Credential[]) {
    const payload = seal(JSON.stringify(credentials), this.requireSecret());
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${payload}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}

export function openCredentialStore(secret?: string) {
  return new CredentialStore(CREDENTIALS_FILE, secret ?? (() => accountsSecret()));
}

export interface CredentialSource {
  list(provider?: string): Array<Pick<Credential, 'method' | 'token'>>;
}

export function savedApiKeys(store: CredentialSource, provider: string): string[] {
  try {
    return store.list(provider).filter(credential => credential.method === 'api-key' && credential.token).map(credential => credential.token!);
  } catch {
    return [];
  }
}

export function savedApiKey(store: CredentialSource, provider: string) {
  return savedApiKeys(store, provider)[0];
}
