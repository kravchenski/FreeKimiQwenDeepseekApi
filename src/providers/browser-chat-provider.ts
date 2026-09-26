import type { BrowserChatSession, ChatSite } from '../browser/browser-chat.ts';
import type { ChatChunk, Provider, ProviderStream } from '../core/providers/provider.ts';
import { messagesToPrompt } from '../core/providers/prompt.ts';

export interface BrowserChatProviderConfig {
  id: string;
  ownedBy: string;
  model: string;
  site: ChatSite;
  session: () => Pick<BrowserChatSession, 'send'>;
  parse: (bytes: AsyncIterable<Uint8Array>) => AsyncIterable<ChatChunk>;
  reasoning?: boolean;
}

export function createBrowserChatProvider(config: BrowserChatProviderConfig): Provider {
  return {
    id: config.id,
    ownedBy: config.ownedBy,
    supports: model => model === config.model,
    listModels: async () => [config.model],
    capabilities: () => ({ nativeTools: false, reasoning: config.reasoning ?? true, vision: false }),
    health: () => ({ available: true }),
    async stream(request): Promise<ProviderStream> {
      const bytes = await config.session().send(config.site, messagesToPrompt(request.messages));
      return { chunks: config.parse(bytes) };
    },
  };
}

export async function* bytesToLines(bytes: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of bytes) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
  const rest = (pending + decoder.decode()).trim();
  if (rest) yield rest;
}
