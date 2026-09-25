import { describe, expect, test } from 'bun:test';

import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { collectChunks, readLines } from '../src/core/streaming/sse.ts';

function fakeProvider(id: string, prefix: string, models: string[] | Error = []): Provider {
  return {
    id,
    ownedBy: `${id}-owner`,
    supports: model => model.startsWith(prefix),
    listModels: async () => {
      if (models instanceof Error) throw models;
      return models;
    },
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    stream: async () => ({ chunks: (async function* () {})() }),
    health: () => ({ available: true }),
  };
}

function bodyFrom(parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function toArray<T>(iterable: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('ProviderRegistry', () => {
  test('resolves the first provider that supports a model', () => {
    const registry = new ProviderRegistry()
      .register(fakeProvider('nvidia', 'deepseek-ai/'))
      .register(fakeProvider('deepseek', 'deepseek-'));
    expect(registry.resolve('deepseek-ai/deepseek-v4-pro')?.id).toBe('nvidia');
    expect(registry.resolve('deepseek-default')?.id).toBe('deepseek');
  });

  test('returns undefined for unknown models', () => {
    const registry = new ProviderRegistry().register(fakeProvider('glm', 'glm-'));
    expect(registry.resolve('gpt-4')).toBeUndefined();
  });

  test('rejects duplicate provider ids', () => {
    const registry = new ProviderRegistry().register(fakeProvider('glm', 'glm-'));
    expect(() => registry.register(fakeProvider('glm', 'x-'))).toThrow('glm');
  });

  test('lists models and skips providers that fail', async () => {
    const registry = new ProviderRegistry()
      .register(fakeProvider('glm', 'glm-', ['glm-a', 'glm-b']))
      .register(fakeProvider('broken', 'b-', new Error('offline')));
    expect(await registry.listModels()).toEqual([
      { id: 'glm-a', ownedBy: 'glm-owner' },
      { id: 'glm-b', ownedBy: 'glm-owner' },
    ]);
  });
});

describe('readLines', () => {
  test('joins lines split across chunks and skips blanks', async () => {
    const lines = await toArray(readLines(bodyFrom(['data: {"a"', ':1}\n\n', 'data: [DONE]'])));
    expect(lines).toEqual(['data: {"a":1}', 'data: [DONE]']);
  });

  test('decodes multibyte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: ✓\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    expect(await toArray(readLines(body))).toEqual(['data: ✓']);
  });

  test('throws on a missing body', async () => {
    await expect(toArray(readLines(null))).rejects.toThrow('empty');
  });
});

describe('collectChunks', () => {
  test('separates content from reasoning', async () => {
    async function* chunks(): AsyncGenerator<ChatChunk> {
      yield { type: 'reasoning', text: 'think ' };
      yield { type: 'content', text: 'hello ' };
      yield { type: 'reasoning', text: 'more' };
      yield { type: 'content', text: 'world' };
    }
    expect(await collectChunks(chunks())).toEqual({ content: 'hello world', reasoning: 'think more' });
  });
});
