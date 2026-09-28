import type { Page } from 'playwright-core';

export interface SignInRule {
  storageKey: string;
  claim?: string;
  guestPattern?: RegExp;
  expiring?: boolean;
}

export interface SignInResult {
  signedIn: boolean;
  reason?: string;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateSignIn(rule: SignInRule, value: string | null | undefined, now = Date.now()): SignInResult {
  if (!value) return { signedIn: false, reason: 'not signed in' };
  const payload = decodeJwtPayload(value);
  if (!payload) return { signedIn: false, reason: 'session token is not readable' };
  if (rule.claim) {
    const claim = payload[rule.claim];
    if (typeof claim !== 'string' || !claim) return { signedIn: false, reason: 'not signed in' };
    if (rule.guestPattern?.test(claim)) return { signedIn: false, reason: 'signed in as a guest' };
  }
  if (rule.expiring) {
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= now) return { signedIn: false, reason: 'session expired' };
  }
  return { signedIn: true };
}

export async function readSignIn(page: Page, rule: SignInRule, now = Date.now()) {
  const value = await page.evaluate(key => localStorage.getItem(key), rule.storageKey).catch(() => null);
  return evaluateSignIn(rule, value, now);
}
