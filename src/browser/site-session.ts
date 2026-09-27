import type { BrowserContext, Page } from 'playwright-core';

import { jwtExpiry } from '../providers/qwen/auth.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { googleProfileDir, openProfileWindow } from './google-profile.ts';

export interface SiteSpec {
  id: string;
  origin: string;
  loginUrl: string;
  cookieDomain: RegExp;
  tokenKey: string;
  userInfoPath?: string;
}

export interface CapturedSession {
  token: string;
  email?: string;
  expiresAt?: number;
}

export interface CaptureOptions {
  profileDir?: string;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  openWindow?: (url: string, profileDir: string) => Promise<void>;
}

export const QWEN_SITE: SiteSpec = {
  id: 'qwen',
  origin: 'https://chat.qwen.ai',
  loginUrl: 'https://chat.qwen.ai/auth?action=signin',
  cookieDomain: /(^|\.)qwen\.ai$/,
  tokenKey: 'token',
  userInfoPath: '/api/v1/auths/',
};

async function withSitePage<T>(
  site: SiteSpec,
  options: CaptureOptions,
  task: (page: Page, context: BrowserContext) => Promise<T>,
) {
  const cdp = await (options.launch ?? launchCdpBrowser)({ profileDir: options.profileDir ?? googleProfileDir() });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const page = await context.newPage();
    await page.goto(site.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    return await task(page, context);
  } finally {
    await cdp.close();
  }
}

const NAVIGATION_ERROR = /Execution context was destroyed|navigation|Target page, context or browser has been closed/i;

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

export async function retryAfterNavigation<R>(page: Page, action: () => Promise<R>, attempts = 5): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !(error instanceof Error) || !NAVIGATION_ERROR.test(error.message)) throw error;
      await settle(page);
    }
  }
}

export function clearSiteSession(site: SiteSpec, options: CaptureOptions = {}) {
  return withSitePage(site, options, async (page, context) => {
    await context.clearCookies({ domain: site.cookieDomain });
    await retryAfterNavigation(page, () => page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }));
  });
}

export function readSiteSession(site: SiteSpec, options: CaptureOptions = {}): Promise<CapturedSession | null> {
  return withSitePage(site, options, async page => {
    const token = await retryAfterNavigation(page, () => page.evaluate(key => localStorage.getItem(key), site.tokenKey));
    if (!token) return null;
    const userInfoPath = site.userInfoPath;
    const email = userInfoPath
      ? await retryAfterNavigation(page, () => page.evaluate(async ({ path, token }) => {
        try {
          const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
          const body = await response.json();
          return typeof body?.email === 'string' ? body.email : typeof body?.data?.email === 'string' ? body.data.email : undefined;
        } catch {
          return undefined;
        }
      }, { path: userInfoPath, token }))
      : undefined;
    return { token, email, expiresAt: jwtExpiry(token) };
  });
}

export async function captureSiteSession(site: SiteSpec, options: CaptureOptions = {}) {
  const profileDir = options.profileDir ?? googleProfileDir();
  const scoped = { ...options, profileDir };
  await clearSiteSession(site, scoped);
  await (options.openWindow ?? openProfileWindow)(site.loginUrl, profileDir);
  const session = await readSiteSession(site, scoped);
  if (!session) throw new Error(`No ${site.id} session found. Sign in, wait for the chat to open, then close the window.`);
  await clearSiteSession(site, scoped);
  return session;
}
