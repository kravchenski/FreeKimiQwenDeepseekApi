import { launchCdpBrowser, type CdpBrowser } from '../../browser/cdp.ts';
import { parseSignInResponse, type QwenSession } from './auth.ts';

interface BrowserLoginOptions {
  baseUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  launch?: (options: { headless?: boolean }) => Promise<CdpBrowser>;
}

export async function qwenBrowserSignIn(email: string, password: string, options: BrowserLoginOptions = {}): Promise<QwenSession> {
  const baseUrl = options.baseUrl ?? 'https://chat.qwen.ai';
  const timeout = options.timeoutMs ?? 60_000;
  const cdp = await (options.launch ?? launchCdpBrowser)({ headless: options.headless });
  try {
    const context = await cdp.browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/auth?action=signin`, { waitUntil: 'domcontentloaded', timeout });
    await page.fill('input[name="email"]', email, { timeout });
    await page.fill('input[name="password"]', password);
    const [response] = await Promise.all([
      page.waitForResponse(candidate => /\/api\/v\d+\/auths\/signin/.test(candidate.url()), { timeout }),
      page.click('button[type="submit"]'),
    ]);
    const session = parseSignInResponse(response.status(), await response.json().catch(() => ({})));
    const cookies = (await context.cookies()).map(({ name, value, domain }) => ({ name, value, domain }));
    return { ...session, cookies };
  } finally {
    await cdp.close();
  }
}
