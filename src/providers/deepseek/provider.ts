import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../../core/providers/provider.ts';
import { readLines } from '../../core/streaming/sse.ts';
import { hasValidDeepSeekAccounts } from './accounts.ts';
import { deepSeekCompletion, fetchDeepSeekModels, parseDeepSeekEvent } from './client.ts';

interface DeepSeekDependencies {
  complete: (request: ChatRequest) => Promise<{ response: Response; sessionId: string }>;
  listModels: () => Promise<string[]>;
  hasAccount: () => boolean;
}

const defaults: DeepSeekDependencies = {
  complete: deepSeekCompletion,
  listModels: fetchDeepSeekModels,
  hasAccount: () => hasValidDeepSeekAccounts() || Boolean(process.env.DEEPSEEK_TOKEN),
};

async function* deepSeekChunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<ChatChunk> {
  const state: Parameters<typeof parseDeepSeekEvent>[1] = { phase: 'content' };
  for await (const line of readLines(body)) {
    const event = parseDeepSeekEvent(line, state);
    if (!event) continue;
    if (event.reasoning) yield { type: 'reasoning', text: event.reasoning };
    if (event.content) yield { type: 'content', text: event.content };
    if (event.done) return;
  }
}

export function createDeepSeekProvider(overrides: Partial<DeepSeekDependencies> = {}): Provider {
  const deps = { ...defaults, ...overrides };
  return {
    id: 'deepseek',
    ownedBy: 'deepseek-web',
    supports: model => model.startsWith('deepseek-') && !model.startsWith('deepseek-ai/'),
    listModels: deps.listModels,
    capabilities: model => ({
      nativeTools: false,
      reasoning: model.includes('reasoner') || model.includes('r1'),
      vision: false,
    }),
    health: () =>
      deps.hasAccount() ? { available: true } : { available: false, reason: 'No active DeepSeek accounts' },
    async stream(request): Promise<ProviderStream> {
      const { response, sessionId } = await deps.complete(request);
      return { chunks: deepSeekChunks(response.body), responseFields: { x_deepseek_chat_id: sessionId } };
    },
  };
}
