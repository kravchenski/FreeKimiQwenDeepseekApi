import type { ChatSite } from './browser-chat.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { googleProfileDir } from './google-profile.ts';
import { readSignIn, type SignInResult } from './sign-in.ts';

export interface SiteSignIn {
  site: ChatSite;
  result: SignInResult;
}

export async function checkSignIns(
  sites: ChatSite[],
  launch: (options: LaunchOptions) => Promise<CdpBrowser> = launchCdpBrowser,
): Promise<SiteSignIn[]> {
  let cdp: CdpBrowser;
  try {
    cdp = await launch({ profileDir: googleProfileDir() });
  } catch (error) {
    throw new Error(`Cannot open the browser profile (is the gateway or another profile window running?): ${error instanceof Error ? error.message : error}`);
  }
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const results: SiteSignIn[] = [];
    for (const site of sites.filter(entry => entry.signIn)) {
      const page = await context.newPage();
      try {
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        results.push({ site, result: await readSignIn(page, site.signIn!) });
      } catch (error) {
        results.push({ site, result: { signedIn: false, reason: `page did not load: ${error instanceof Error ? error.message : error}`.slice(0, 200) } });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  } finally {
    await cdp.close();
  }
}
