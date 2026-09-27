import { describe, expect, test } from 'bun:test';

import { editImage, generateImage, type ImageUpstream } from '../src/api/images.ts';
import { createQwenProvider } from '../src/providers/qwen/provider.ts';

function upstream(reply: Record<string, unknown> = { created: 1, data: [{ url: 'https://cdn.test/a.png' }] }) {
  const calls: Array<{ path: string; body: BodyInit | undefined; headers?: Record<string, string> }> = [];
  const fake: ImageUpstream = {
    async forward(path, init = {}) {
      calls.push({ path, body: init.body, headers: init.headers });
      return Response.json(reply);
    },
  };
  return { fake, calls };
}

describe('image generation', () => {
  test('forwards only allowed fields', async () => {
    const { fake, calls } = upstream();
    const result = await generateImage(fake, { prompt: 'a red fox', size: '16:9', response_format: 'url', n: 5, model: 'dall-e-3', user: 'x' });
    expect(result).toEqual({ created: 1, data: [{ url: 'https://cdn.test/a.png' }] });
    expect(calls[0]!.path).toBe('/images/generations');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ prompt: 'a red fox', size: '16:9', response_format: 'url' });
  });

  test('rejects invalid input before calling upstream', async () => {
    const { fake, calls } = upstream();
    await expect(generateImage(fake, { prompt: '  ' })).rejects.toThrow('prompt');
    await expect(generateImage(fake, { prompt: 'x'.repeat(4_001) })).rejects.toThrow('at most');
    await expect(generateImage(fake, { prompt: 'fox', response_format: 'png' })).rejects.toThrow('response_format');
    await expect(generateImage(fake, { prompt: 'fox', size: 1024 })).rejects.toThrow('size');
    expect(calls).toHaveLength(0);
  });
});

describe('image edits', () => {
  const jsonRequest = (body: unknown) => new Request('http://local/v1/images/edits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('accepts https and data URLs in JSON', async () => {
    const { fake, calls } = upstream();
    await editImage(fake, jsonRequest({ prompt: 'make it blue', image: 'https://img.test/cat.png' }));
    await editImage(fake, jsonRequest({ prompt: 'make it blue', image: 'data:image/png;base64,AAAA' }));
    expect(calls.map(call => JSON.parse(call.body as string).image)).toEqual(['https://img.test/cat.png', 'data:image/png;base64,AAAA']);
  });

  test('rejects non-https and non-image references', async () => {
    const { fake, calls } = upstream();
    await expect(editImage(fake, jsonRequest({ prompt: 'x', image: 'http://img.test/cat.png' }))).rejects.toThrow('https');
    await expect(editImage(fake, jsonRequest({ prompt: 'x', image: 'file:///etc/passwd' }))).rejects.toThrow('https');
    await expect(editImage(fake, jsonRequest({ prompt: 'x', image: 'data:text/html;base64,AAAA' }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('forwards exactly one uploaded file as multipart', async () => {
    const { fake, calls } = upstream();
    const form = new FormData();
    form.set('prompt', 'add a hat');
    form.set('image', new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }));
    form.set('response_format', 'b64_json');
    form.set('extra', 'dropped');
    await editImage(fake, new Request('http://local/v1/images/edits', { method: 'POST', body: form }));
    const sent = calls[0]!.body as FormData;
    expect(sent.get('prompt')).toBe('add a hat');
    expect((sent.get('image') as File).name).toBe('cat.png');
    expect(sent.get('response_format')).toBe('b64_json');
    expect(sent.get('extra')).toBeNull();

    const twoFiles = new FormData();
    twoFiles.set('prompt', 'x');
    twoFiles.append('image', new File([new Uint8Array([1])], 'a.png'));
    twoFiles.append('image', new File([new Uint8Array([2])], 'b.png'));
    await expect(editImage(fake, new Request('http://local/v1/images/edits', { method: 'POST', body: twoFiles }))).rejects.toThrow('exactly one');
  });
});

describe('Qwen image upstream', () => {
  test('forwards with the account token and reports the outcome', async () => {
    const reports: unknown[] = [];
    const requests: Array<{ url: string; auth: string | null }> = [];
    const qwen = createQwenProvider({
      env: { QWEN_TOKEN: 'jwt' },
      resolveApiKey: async () => undefined,
      hasApiKey: () => false,
      reportResult: (_key, outcome) => reports.push(outcome),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, auth: new Headers(init.headers).get('authorization') });
        return url.endsWith('/images/generations') ? Response.json({ created: 1, data: [] }) : new Response('slow', { status: 429 });
      }) as unknown as typeof fetch,
    });
    await generateImage(qwen, { prompt: 'fox' });
    await expect(qwen.forward('/images/edits', { body: '{}' })).rejects.toThrow('429');
    expect(requests).toEqual([
      { url: 'https://qwen.aikit.club/v1/images/generations', auth: 'Bearer jwt' },
      { url: 'https://qwen.aikit.club/v1/images/edits', auth: 'Bearer jwt' },
    ]);
    expect(reports).toEqual([{ ok: true }, { ok: false, kind: 'rate_limit', status: 429, retryAfterSeconds: undefined }]);
  });
});
