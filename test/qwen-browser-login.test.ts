import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';
import { qwenBrowserSignIn } from '../src/providers/qwen/browser-login.ts';

const page = `<!doctype html><form id="f">
<input name="email"><input name="password" type="password"><button type="submit">Sign in</button></form>
<script>
document.getElementById('f').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  await fetch('/api/v1/auths/signin', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
});
</script>`;

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/auth') return new Response(page, { headers: { 'content-type': 'text/html' } });
      if (url.pathname === '/api/v1/auths/signin') {
        const { email, password } = await request.json() as { email: string; password: string };
        if (email !== 'user@example.com' || password !== 'right') return Response.json({ detail: 'wrong password' }, { status: 400 });
        return Response.json({ token: 'browser-token', expires_at: 2_000_000_000 }, {
          headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('qwenBrowserSignIn over CDP', () => {
  test('fills the form and returns the token with cookies', async () => {
    const session = await qwenBrowserSignIn('user@example.com', 'right', { baseUrl, timeoutMs: 15_000 });
    expect(session.token).toBe('browser-token');
    expect(session.expiresAt).toBe(2_000_000_000_000);
    expect(session.cookies).toContainEqual({ name: 'session', value: 'abc', domain: '127.0.0.1' });
  }, 40_000);

  test('surfaces the upstream reason for rejected credentials', async () => {
    await expect(qwenBrowserSignIn('user@example.com', 'wrong', { baseUrl, timeoutMs: 15_000 }))
      .rejects.toThrow('Qwen sign-in failed: 400 wrong password');
  }, 40_000);
});
