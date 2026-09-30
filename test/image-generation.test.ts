import { describe, expect, test } from 'bun:test';

import { generateImages, listImageModels, type ImageAttempt } from '../src/api/images.ts';
import { aspectRatio, parseSize, type ImageProvider } from '../src/core/images/images.ts';
import { ProviderError } from '../src/core/providers/errors.ts';
import { createCloudflareImages } from '../src/providers/images/cloudflare.ts';
import { createPollinationsImages } from '../src/providers/images/pollinations.ts';
import { qwenImageSite } from '../src/providers/images/qwen-chat.ts';
import { apiKeyProvider } from '../src/providers/catalog.ts';

function fake(id: string, options: { fail?: boolean; available?: boolean } = {}): ImageProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id,
    prompts,
    available: () => options.available ?? true,
    supports: model => model.startsWith(`${id}/`),
    listModels: async () => [`${id}/model`],
    async generate(request) {
      prompts.push(`${request.prompt} ${request.width}x${request.height}`);
      if (options.fail) throw new ProviderError(`${id} broke`, 'upstream', 502);
      return { base64: Buffer.from(id).toString('base64'), mimeType: 'image/png' };
    },
  };
}

describe('image generation', () => {
  test('uses the first provider that works when no model is given', async () => {
    const attempts: ImageAttempt[] = [];
    const broken = fake('first', { fail: true });
    const working = fake('second');
    const result = await generateImages([fake('off', { available: false }), broken, working], { prompt: 'a fox', size: '512x768', n: 2, response_format: 'b64_json' }, attempt => attempts.push(attempt), () => 5_000);
    expect(result).toEqual({ created: 5, model: 'second/model', data: [
      { b64_json: Buffer.from('second').toString('base64'), revised_prompt: 'a fox' },
      { b64_json: Buffer.from('second').toString('base64'), revised_prompt: 'a fox' },
    ] });
    expect(working.prompts).toEqual(['a fox 512x768', 'a fox 512x768']);
    expect(attempts.map(attempt => [attempt.provider, attempt.ok])).toEqual([['first', false], ['second', true]]);
    expect(await listImageModels([fake('off', { available: false }), working])).toEqual([{ id: 'second/model', ownedBy: 'second' }]);
  });

  test('returns data URLs for inline images and reports a failing explicit model', async () => {
    const result = await generateImages([fake('only')], { prompt: 'a fox', model: 'only/model' });
    expect(result.data[0]!.url).toBe(`data:image/png;base64,${Buffer.from('only').toString('base64')}`);
    await expect(generateImages([fake('only', { fail: true })], { prompt: 'a fox', model: 'only/model' })).rejects.toThrow('only broke');
    await expect(generateImages([fake('only')], { prompt: 'a fox', n: 9 })).rejects.toThrow('n must be between 1 and 4');
    await expect(generateImages([fake('only')], { prompt: 'a fox', response_format: 'png' })).rejects.toThrow('response_format');
  });

  test('parses sizes and maps them to aspect ratios', () => {
    expect(parseSize(undefined)).toEqual({ width: 1024, height: 1024 });
    expect(parseSize('1792x1024')).toEqual({ width: 1792, height: 1024 });
    expect(() => parseSize('4096x4096')).toThrow('between 64 and 2048');
    expect(aspectRatio(1792, 1024)).toBe('16:9');
    expect(aspectRatio(1024, 1365)).toBe('3:4');
  });

  test('asks the Qwen chat for a text-to-image answer', () => {
    expect(qwenImageSite(1792, 1024).modelFields!('qwen3.7-plus')).toMatchObject({ 'messages.*.chat_type': 't2i', size: '16:9', model: 'qwen3.7-plus' });
  });

  test('calls Pollinations and Cloudflare with the prompt and size', async () => {
    const calls: Array<{ url: string; body?: string; auth?: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body as string | undefined, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
      if (url.endsWith('/models')) return Response.json(['sana']);
      if (url.includes('cloudflare')) return Response.json({ result: { image: 'Zm94' } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const pollinations = createPollinationsImages(fetchFn);
    expect(await pollinations.listModels()).toEqual(['pollinations/sana']);
    expect(await pollinations.generate({ model: 'pollinations/sana', prompt: 'a red fox', width: 512, height: 512 })).toEqual({ base64: 'AQID', mimeType: 'image/jpeg' });
    expect(calls.at(-1)!.url).toStartWith('https://image.pollinations.ai/prompt/a%20red%20fox?width=512&height=512&model=sana');
    const cloudflare = createCloudflareImages(apiKeyProvider('cloudflare')!, () => 'acc1:token', fetchFn);
    expect(await cloudflare.generate({ model: 'cloudflare/@cf/black-forest-labs/flux-1-schnell', prompt: 'a fox', width: 1024, height: 1024 })).toEqual({ base64: 'Zm94', mimeType: 'image/jpeg' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/black-forest-labs/flux-1-schnell', auth: 'Bearer token' });
    expect(await createCloudflareImages(apiKeyProvider('cloudflare')!, () => undefined, fetchFn).listModels()).toEqual([]);
  });
});
