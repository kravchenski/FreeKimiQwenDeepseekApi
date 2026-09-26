import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { requireBrowserExecutable } from '../platform/browserExecutable.ts';
import { launchCdpBrowser } from './cdp.ts';

const GOOGLE_SIGN_IN_URL = 'https://accounts.google.com/';
const LIST_ACCOUNTS_URL = 'https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser';

export function googleProfileDir(env: Record<string, string | undefined> = process.env) {
  return path.resolve(env.SESSION_DIR || 'session', 'browser-profile');
}

export async function openGoogleSignIn(profileDir = googleProfileDir()) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(requireBrowserExecutable({ interactive: true }), [
    `--user-data-dir=${profileDir}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    GOOGLE_SIGN_IN_URL,
  ], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

export function parseListAccounts(body: string) {
  const emails = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(emails.map(email => email.toLowerCase()))];
}

export async function listGoogleAccounts(profileDir = googleProfileDir()) {
  const cdp = await launchCdpBrowser({ profileDir });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const response = await context.request.get(LIST_ACCOUNTS_URL, { timeout: 20_000 });
    return parseListAccounts(await response.text());
  } finally {
    await cdp.close();
  }
}
