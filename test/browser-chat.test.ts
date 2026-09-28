import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserChatSession, type ChatSite } from '../src/browser/browser-chat.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

const chatPage = `<!doctype html><textarea id="box"></textarea><div id="out"></div>
<script>
document.getElementById('box').addEventListener('keydown', async event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const response = await fetch('/api/stream', { method: 'POST', body: event.target.value });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    document.getElementById('out').textContent += decoder.decode(value);
  }
});
</script>`;

const precheckPage = chatPage.replace("const response = await fetch('/api/stream'", "await (await fetch('/api/stream?precheck=1', { method: 'POST' })).text();\n  const response = await fetch('/api/stream'");

const verifyPage = '<!doctype html><textarea></textarea><p>Please complete security verification</p>';

const jwt = (payload: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const withToken = (payload: Record<string, unknown>) => `<script>localStorage.setItem('token', ${JSON.stringify(jwt(payload))})</script>${chatPage}`;
const clearToken = `<script>localStorage.removeItem('token')</script>${chatPage}`;

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/stream' && url.searchParams.has('precheck')) {
        return Response.json({ code: 0, sig: 'from bx' });
      }
      if (url.pathname === '/api/stream') {
        const prompt = await request.text();
        const parts = ['data: first\n\n', `data: echo ${prompt}\n\n`, 'data: [DONE]\n\n'];
        return new Response(new ReadableStream({
          async start(controller) {
            for (const part of parts) {
              controller.enqueue(new TextEncoder().encode(part));
              await Bun.sleep(50);
            }
            controller.close();
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const html = url.pathname === '/verify' ? verifyPage
        : url.pathname === '/precheck' ? precheckPage
        : url.pathname === '/member' ? withToken({ email: 'me@example.com' })
        : url.pathname === '/guest' ? withToken({ email: 'Guest-123@guest.com' })
        : url.pathname === '/signed-out' ? clearToken
        : chatPage;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

async function collect(stream: AsyncIterable<Uint8Array>) {
  let text = '';
  for await (const chunk of stream) text += new TextDecoder().decode(chunk);
  return text;
}

function site(path = '/'): ChatSite {
  return { id: 'fake', url: `${origin}${path}`, inputSelector: 'textarea', responseUrl: /\/api\/stream/, verificationText: /security verification/i };
}

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('browser chat session', () => {
  test('types the prompt, lets the page send it and streams the response', async () => {
    const session = new BrowserChatSession({ profileDir: join(mkdtempSync(join(tmpdir(), 'chat-')), 'profile'), headless: true });
    try {
      const text = await collect(await session.send(site(), 'hello there'));
      expect(text).toBe('data: first\n\ndata: echo hello there\n\ndata: [DONE]\n\n');

      const [a, b] = await Promise.all([session.send(site(), 'one').then(collect), session.send(site(), 'two').then(collect)]);
      expect(a).toContain('echo one');
      expect(b).toContain('echo two');
    } finally {
      await session.close();
    }
  }, 90_000);

  test('relaunches the browser after its window was closed', async () => {
    const session = new BrowserChatSession({ profileDir: join(mkdtempSync(join(tmpdir(), 'chat-')), 'profile'), headless: true });
    try {
      expect(await collect(await session.send(site(), 'one'))).toContain('echo one');
      const cdp = await (session as unknown as { browser: Promise<{ browser: { close(): Promise<void> } }> }).browser;
      await cdp.browser.close();
      expect(await collect(await session.send(site(), 'two'))).toContain('echo two');
    } finally {
      await session.close();
    }
  }, 60_000);

  test('skips a pre-check response and streams the answer the page asks for next', async () => {
    const session = new BrowserChatSession({ profileDir: join(mkdtempSync(join(tmpdir(), 'chat-')), 'profile'), headless: true });
    try {
      const text = await collect(await session.send({ ...site('/precheck'), ignoredResponse: /"sig":"from bx"/ }, 'real one'));
      expect(text).toBe('data: first\n\ndata: echo real one\n\ndata: [DONE]\n\n');
    } finally {
      await session.close();
    }
  }, 60_000);

  test('reports a security verification instead of waiting for it', async () => {
    const session = new BrowserChatSession({ profileDir: join(mkdtempSync(join(tmpdir(), 'chat-')), 'profile'), headless: true, firstChunkTimeoutMs: 10_000 });
    try {
      await expect(session.send(site('/verify'), 'hi').then(collect)).rejects.toThrow('security verification');
    } finally {
      await session.close();
    }
  }, 90_000);

  test('checks the sign-in before typing and refuses guests', async () => {
    const seen: Array<[string, boolean]> = [];
    const session = new BrowserChatSession({
      profileDir: join(mkdtempSync(join(tmpdir(), 'chat-')), 'profile'),
      headless: true,
      onSignIn: (id, result) => seen.push([id, result.signedIn]),
    });
    const rule = { storageKey: 'token', claim: 'email', guestPattern: /guest/i };
    try {
      expect(await collect(await session.send({ ...site('/member'), signIn: rule }, 'hi'))).toContain('echo hi');
      await expect(session.send({ ...site('/guest'), signIn: rule }, 'hi')).rejects.toThrow('signed in as a guest; run: bun run account open');
      await expect(session.send({ ...site('/signed-out'), signIn: rule }, 'hi')).rejects.toThrow('not signed in');
      expect(seen).toEqual([['fake', true], ['fake', false], ['fake', false]]);
    } finally {
      await session.close();
    }
  }, 90_000);
});
