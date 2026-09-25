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
