import type { ChatChunk, ToolCall } from '../providers/provider.ts';

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

export class ToolCallAssembler {
  private readonly calls = new Map<number, { id?: string; name: string; arguments: string }>();

  add(chunk: Extract<ChatChunk, { type: 'tool_call' }>) {
    const call = this.calls.get(chunk.index) ?? { name: '', arguments: '' };
    if (chunk.id) call.id = chunk.id;
    if (chunk.name) call.name += chunk.name;
    if (chunk.arguments) call.arguments += chunk.arguments;
    this.calls.set(chunk.index, call);
  }

  result(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));
  }
}

export async function collectChunks(chunks: AsyncIterable<ChatChunk>) {
  let content = '';
  let reasoning = '';
  const tools = new ToolCallAssembler();
  for await (const chunk of chunks) {
    if (chunk.type === 'content') content += chunk.text;
    else if (chunk.type === 'reasoning') reasoning += chunk.text;
    else tools.add(chunk);
  }
  return { content, reasoning, toolCalls: tools.result() };
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
