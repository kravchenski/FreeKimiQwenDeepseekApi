import type { Page } from 'playwright-core';

import { ProviderError } from '../core/providers/errors.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { googleProfileDir } from './google-profile.ts';
import { readSignIn, type SignInResult, type SignInRule } from './sign-in.ts';

export interface ChatSite {
  id: string;
  url: string;
  inputSelector: string;
  responseUrl: RegExp;
  verificationText?: RegExp;
  signIn?: SignInRule;
  challengeResponse?: RegExp;
}

export interface BrowserChatOptions {
  profileDir?: string;
  headless?: boolean;
  firstChunkTimeoutMs?: number;
  idleTimeoutMs?: number;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  onSignIn?: (siteId: string, result: SignInResult) => void;
}

const BINDING = '__freeapiStreamChunk';
const CHALLENGE_GRACE_MS = 120_000;

function teeScript({ pattern, binding }: { pattern: string; binding: string }) {
  const matcher = new RegExp(pattern);
  const original = window.fetch;
  window.fetch = Object.assign(async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const response = await original.apply(this, args);
    const target = args[0];
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
    if (!matcher.test(url) || !response.body) return response;
    const [forPage, forGateway] = response.body.tee();
    const emit = (window as unknown as Record<string, (chunk: string | null) => void>)[binding]!;
    (async () => {
      const reader = forGateway.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let binary = '';
        for (const byte of value) binary += String.fromCharCode(byte);
        emit(btoa(binary));
      }
      emit(null);
    })().catch(() => emit(null));
    return new Response(forPage, { status: response.status, statusText: response.statusText, headers: response.headers });
  }, original) as typeof fetch;
}

export function notSignedIn(site: Pick<ChatSite, 'url'>, result: SignInResult) {
  return `${new URL(site.url).hostname}: ${result.reason ?? 'not signed in'}; run: bun run account open ${site.url}`;
}

async function drainResponse(queue: ChunkQueue) {
  for (let chunk = await queue.next(5_000); chunk instanceof Uint8Array; chunk = await queue.next(5_000));
}

class ChunkQueue {
  private readonly items: Array<Uint8Array | null> = [];
  private waiter?: () => void;

  push(item: Uint8Array | null) {
    this.items.push(item);
    this.waiter?.();
  }

  async next(timeoutMs?: number): Promise<Uint8Array | null | 'timeout'> {
    if (!this.items.length) {
      await new Promise<void>(resolve => {
        this.waiter = resolve;
        if (timeoutMs !== undefined) setTimeout(resolve, timeoutMs);
      });
      this.waiter = undefined;
    }
    return this.items.length ? this.items.shift()! : 'timeout';
  }
}

export class BrowserChatSession {
  private browser?: Promise<CdpBrowser>;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: BrowserChatOptions = {}) {}

  private cdp() {
    this.browser ??= (this.options.launch ?? launchCdpBrowser)({
      profileDir: this.options.profileDir ?? googleProfileDir(),
      headless: this.options.headless ?? false,
    }).catch(error => {
      this.browser = undefined;
      throw error;
    });
    return this.browser;
  }

  async close() {
    const browser = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    await browser?.close();
  }

  send(site: ChatSite, prompt: string): Promise<AsyncGenerator<Uint8Array>> {
    const previous = this.queues.get(site.id) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(site.id, previous.then(() => done));
    return previous.then(async () => {
      try {
        const { page, queue } = await this.openPage(site, prompt);
        return this.stream(site, page, queue, release);
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  private async openPage(site: ChatSite, prompt: string) {
    const context = (await this.cdp()).browser.contexts()[0];
    if (!context) throw new ProviderError('Browser profile has no default context', 'unavailable');
    const page = await context.newPage();
    const queue = new ChunkQueue();
    await page.exposeFunction(BINDING, (chunk: string | null) => queue.push(chunk === null ? null : Buffer.from(chunk, 'base64')));
    await page.addInitScript(teeScript, { pattern: site.responseUrl.source, binding: BINDING });
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (site.signIn) {
        const signIn = await readSignIn(page, site.signIn);
        this.options.onSignIn?.(site.id, signIn);
        if (!signIn.signedIn) throw new ProviderError(notSignedIn(site, signIn), 'auth');
      }
      const input = page.locator(site.inputSelector).first();
      await input.waitFor({ timeout: 30_000 });
      await input.fill(prompt);
      await input.press('Enter');
      return { page, queue };
    } catch (error) {
      await page.close().catch(() => {});
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`${site.id} chat page is not ready: ${error instanceof Error ? error.message : error}`, 'unavailable');
    }
  }

  private async *stream(site: ChatSite, page: Page, queue: ChunkQueue, release: () => void): AsyncGenerator<Uint8Array> {
    let deadline = Date.now() + (this.options.firstChunkTimeoutMs ?? 60_000);
    let challenged = false;
    try {
      let first: Uint8Array | null | 'timeout' = 'timeout';
      while (first === 'timeout') {
        if (Date.now() > deadline) {
          throw new ProviderError(challenged
            ? `${site.id} asked for a security verification that was not completed in time; complete it in the browser window and retry`
            : `${site.id} did not answer in time`, 'unavailable');
        }
        if (site.verificationText && await page.getByText(site.verificationText).first().isVisible().catch(() => false)) {
          throw new ProviderError(`${site.id} asks for a security verification; complete it in the browser window`, 'unavailable');
        }
        first = await queue.next(500);
        if (first instanceof Uint8Array && site.challengeResponse?.test(new TextDecoder().decode(first))) {
          if (!challenged) deadline = Math.max(deadline, Date.now() + CHALLENGE_GRACE_MS);
          challenged = true;
          await drainResponse(queue);
          first = 'timeout';
        }
      }
      if (first === null) return;
      yield first;
      for (;;) {
        const chunk = await queue.next(this.options.idleTimeoutMs ?? 120_000);
        if (chunk === 'timeout') throw new ProviderError(`${site.id} stopped streaming`, 'upstream');
        if (chunk === null) return;
        yield chunk;
      }
    } finally {
      release();
      await page.close().catch(() => {});
    }
  }
}
