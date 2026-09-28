import type { ChatChunk } from '../providers/provider.ts';

export async function* readLines(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new Error('Response body is empty');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
      if (done) break;
    }
    const rest = pending.trim();
    if (rest) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function collectChunks(chunks: AsyncIterable<ChatChunk>) {
  let content = '';
  let reasoning = '';
  for await (const chunk of chunks) {
    if (chunk.type === 'content') content += chunk.text;
    else reasoning += chunk.text;
  }
  return { content, reasoning };
}

export interface PrimedChunks extends AsyncIterableIterator<ChatChunk> {
  return(value?: unknown): Promise<IteratorResult<ChatChunk>>;
}

export async function primeChunks(chunks: AsyncIterable<ChatChunk>): Promise<PrimedChunks> {
  const iterator = chunks[Symbol.asyncIterator]();
  let pending: IteratorResult<ChatChunk> | undefined = await iterator.next();
  let closed = false;
  const finish = async () => {
    if (closed) return;
    closed = true;
    await iterator.return?.();
  };
  const primed: PrimedChunks = {
    async next() {
      if (closed) return { done: true, value: undefined };
      const result: IteratorResult<ChatChunk> = pending ?? await iterator.next();
      pending = undefined;
      if (result.done) closed = true;
      return result;
    },
    async return(value?: unknown) {
      await finish();
      return { done: true, value };
    },
    async throw(error?: unknown) {
      await finish();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return primed;
    },
  };
  return primed;
}
