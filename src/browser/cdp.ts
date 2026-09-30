import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright-core';

import { requireBrowserExecutable } from '../platform/browserExecutable.ts';

export interface CdpBrowser {
  browser: Browser;
  exited: Promise<unknown>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
  profileDir?: string;
  startUrl?: string;
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForEndpoint(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error('Chrome did not open the remote debugging port');
}

function chromeVersionSync(executable: string): string | null {
  try {
    const out = Bun.spawnSync([executable, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = new TextDecoder().decode(out.stdout);
    return /(\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalChromeVersion(raw: string | null): string | null {
  const match = raw?.match(/(\d+\.\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function linuxChromeUa(version: string): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function hardenFingerprint(browser: Browser, version: string | null) {
  const context = browser.contexts()[0];
  if (!context || !version) return;
  const metadata = {
    brands: [
      { brand: 'Google Chrome', version: version.split('.')[0]! },
      { brand: 'Chromium', version: version.split('.')[0]! },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version },
      { brand: 'Chromium', version },
      { brand: 'Not_A Brand', version: '99.0.0.0' },
    ],
    fullVersion: version,
    platform: 'Linux',
    platformVersion: '',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
  const apply = (page: Page) => {
    page.context().newCDPSession(page)
      .then(session => session.send('Emulation.setUserAgentOverride', {
        userAgent: linuxChromeUa(version),
        acceptLanguage: 'en-US,en;q=0.9',
        userAgentMetadata: metadata,
      }))
      .catch(() => {});
  };
  context.on('page', apply);
  for (const page of context.pages()) apply(page);
}

export async function launchCdpBrowser(options: LaunchOptions = {}): Promise<CdpBrowser> {
  const executable = requireBrowserExecutable({ interactive: options.headless === false });
  const headless = options.headless !== false;
  const version = headless ? chromeVersionSync(executable) : null;
  const port = await freePort();
  const persistent = Boolean(options.profileDir);
  if (options.profileDir) mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const profile = options.profileDir ?? mkdtempSync(join(tmpdir(), 'freeapi-cdp-'));
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    ...(persistent ? ['--password-store=basic'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    ...(headless && version ? [`--user-agent=${linuxChromeUa(version)}`] : []),
    ...(headless ? ['--headless=new'] : []),
    options.startUrl ?? 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const cleanup = async () => {
    child.kill();
    await Promise.race([exited, Bun.sleep(5_000)]);
    if (persistent) return;
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  };
  try {
    await waitForEndpoint(port, 15_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    if (headless) hardenFingerprint(browser, version ?? normalChromeVersion(browser.version()));
    return {
      browser,
      exited,
      async close() {
        await browser.close().catch(() => {});
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
