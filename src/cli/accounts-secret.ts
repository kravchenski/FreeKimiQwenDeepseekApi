import crypto from 'node:crypto';
import fs from 'node:fs';

const SECRET_LINE = /^ACCOUNTS_SECRET=(.*)$/m;

export function ensureAccountsSecret(envFile: string, random: () => string = () => crypto.randomBytes(32).toString('base64')) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const existing = current.match(SECRET_LINE)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (existing) return 'exists' as const;
  const line = `ACCOUNTS_SECRET=${random()}`;
  const next = SECRET_LINE.test(current)
    ? current.replace(SECRET_LINE, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(envFile, next, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  return 'created' as const;
}
