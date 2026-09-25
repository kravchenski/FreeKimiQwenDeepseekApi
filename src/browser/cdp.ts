import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser } from 'playwright-core';

import { requireBrowserExecutable } from '../platform/browserExecutable.ts';

export interface CdpBrowser {
  browser: Browser;
  close(): Promise<void>;
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

export async function launchCdpBrowser(options: { headless?: boolean } = {}): Promise<CdpBrowser> {
  const executable = requireBrowserExecutable({ interactive: options.headless === false });
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'freeapi-cdp-'));
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless === false ? [] : ['--headless=new']),
    'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const cleanup = async () => {
    child.kill();
    await Promise.race([exited, Bun.sleep(5_000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  };
  try {
    await waitForEndpoint(port, 15_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return {
      browser,
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
