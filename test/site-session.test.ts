import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchCdpBrowser } from '../src/browser/cdp.ts';
import { captureSiteSession, readSiteSession, type SiteSpec } from '../src/browser/site-session.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

let server: ReturnType<typeof Bun.serve>;
let site: SiteSpec;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/auths/') {
        return request.headers.get('authorization') === 'Bearer user-token'
          ? Response.json({ email: 'me@example.com' })
          : new Response('unauthorized', { status: 401 });
      }
      return new Response('<!doctype html><title>site</title>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  site = { id: 'fake', origin, loginUrl: `${origin}/auth`, cookieDomain: /127\.0\.0\.1/, tokenKey: 'token', userInfoPath: '/api/v1/auths/' };
});

afterAll(() => server?.stop(true));

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('site session capture', () => {
  test('captures the token the user obtained and clears the site afterwards', async () => {
    const profileDir = join(mkdtempSync(join(tmpdir(), 'capture-')), 'profile');
    const userSignsIn = async (url: string, dir: string) => {
      const cdp = await launchCdpBrowser({ profileDir: dir });
      const page = await cdp.browser.contexts()[0]!.newPage();
      await page.goto(url);
      await page.evaluate(() => localStorage.setItem('token', 'user-token'));
      await cdp.close();
    };

    const session = await captureSiteSession(site, { profileDir, openWindow: userSignsIn });

    expect(session).toEqual({ token: 'user-token', email: 'me@example.com', expiresAt: undefined });
    expect(await readSiteSession(site, { profileDir })).toBeNull();
  }, 90_000);

  test('fails clearly when the user closes the window without signing in', async () => {
    const profileDir = join(mkdtempSync(join(tmpdir(), 'capture-')), 'profile');
    await expect(captureSiteSession(site, { profileDir, openWindow: async () => {} })).rejects.toThrow('No fake session found');
  }, 90_000);
});
