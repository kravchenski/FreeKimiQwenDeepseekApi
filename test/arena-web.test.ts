import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { parseArenaEvent, parseArenaStream } from '../src/providers/arena/web.ts';
import { siteForUrl } from '../src/providers/web-chat-sites.ts';

async function* bytes(text: string, size: number) {
  const all = new TextEncoder().encode(text);
  for (let index = 0; index < all.length; index += size) yield all.slice(index, index + size);
}

describe('arena web chat', () => {
  test('streams the answer and reasoning of model A and stops at the finish event', async () => {
    const body = 'a2:[{"type":"routed_model","organization":"google"}]\nag:"Thinking"\na0:"Hello "\na0:"there!"\nad:{"finishReason":"stop"}\na0:"ignored"\n';
    const result = await collectChunks(parseArenaStream(bytes(body, 7)));
    expect(result.content).toBe('Hello there!');
    expect(result.reasoning).toBe('Thinking');
  });

  test('turns error events into provider errors', () => {
    expect(() => parseArenaEvent('a3:"Too many requests, slow down"')).toThrow('Arena rate limit');
    expect(() => parseArenaEvent('{"error":"recaptcha validation failed"}')).toThrow('verification');
    try {
      parseArenaEvent('a3:"model crashed"');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe('upstream');
    }
    expect(parseArenaEvent('b0:"other model"')).toBeNull();
  });

  test('is found by its URL', () => {
    expect(siteForUrl('https://arena.ai/')?.id).toBe('arena-chat');
  });
});
