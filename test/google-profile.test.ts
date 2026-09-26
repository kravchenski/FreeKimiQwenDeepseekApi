import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { launchCdpBrowser } from '../src/browser/cdp.ts';
import { googleProfileDir, parseListAccounts } from '../src/browser/google-profile.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

describe('google profile', () => {
  test('parses signed-in accounts from the ListAccounts response', () => {
    const body = '["gaia.l.a.r",[["gaia.l.a",1,"Ann","Ann.Doe@gmail.com","https://lh3.googleusercontent.com/a/x",1,1,0,null,1,"1"],' +
      '["gaia.l.a",1,"Work","work@company.io","https://x",0,0,0,null,1,"2"],["gaia.l.a",1,"Ann","ann.doe@gmail.com"]]]';
    expect(parseListAccounts(body)).toEqual(['ann.doe@gmail.com', 'work@company.io']);
    expect(parseListAccounts('["gaia.l.a.r",[]]')).toEqual([]);
  });

  test('keeps the profile under the session directory', () => {
    expect(googleProfileDir({ SESSION_DIR: 'custom-session' })).toBe(resolve('custom-session', 'browser-profile'));
    expect(googleProfileDir({})).toBe(resolve('session', 'browser-profile'));
  });
});

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('persistent CDP profile', () => {
  test('keeps profile data after the browser closes', async () => {
    const profileDir = join(mkdtempSync(join(tmpdir(), 'profile-')), 'browser-profile');
    const cdp = await launchCdpBrowser({ profileDir });
    const page = await cdp.browser.contexts()[0]!.newPage();
    await page.goto('about:blank');
    await cdp.close();
    expect(existsSync(profileDir)).toBeTrue();
    expect(readdirSync(profileDir).length).toBeGreaterThan(0);
  }, 40_000);
});
