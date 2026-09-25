import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { open, seal } from '../secrets/vault.ts';

export interface Credential {
  id: string;
  provider: string;
  email: string;
  password: string;
}

export class CredentialStore {
  constructor(
    private readonly file: string,
    private readonly secret: string | undefined,
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

  remove(id: string) {
    const credentials = this.read();
    const remaining = credentials.filter(credential => credential.id !== id);
    if (remaining.length === credentials.length) return false;
    this.write(remaining);
    return true;
  }

  private requireSecret() {
    if (!this.secret) throw new Error('ACCOUNTS_SECRET is not set');
    return this.secret;
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
