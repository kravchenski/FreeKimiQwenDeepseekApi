import type { BrowserChatSession, ChatSite } from '../browser/browser-chat.ts';
import { ProviderError } from '../core/providers/errors.ts';
import type { ChatChunk, Provider, ProviderHealth, ProviderStream } from '../core/providers/provider.ts';
import { messagesToPrompt } from '../core/providers/prompt.ts';
import { primeChunks } from '../core/streaming/sse.ts';

export interface ProfileSession {
  profile: string;
  session: Pick<BrowserChatSession, 'send'>;
}

export interface BrowserChatProviderConfig {
  id: string;
  ownedBy: string;
  model: string;
  site: ChatSite;
  sessions: () => ProfileSession[];
  parse: (bytes: AsyncIterable<Uint8Array>) => AsyncIterable<ChatChunk>;
  reasoning?: boolean;
  health?: () => ProviderHealth;
  onResult?: (profile: string, ok: boolean) => void;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createBrowserChatProvider(config: BrowserChatProviderConfig): Provider {
  return {
    id: config.id,
    ownedBy: config.ownedBy,
    supports: model => model === config.model,
    listModels: async () => [config.model],
    capabilities: () => ({ nativeTools: false, reasoning: config.reasoning ?? true, vision: false }),
    health: () => config.health?.() ?? { available: true },
    async stream(request): Promise<ProviderStream> {
      const candidates = config.sessions();
      if (!candidates.length) throw new ProviderError(`${config.id}: no account is signed in`, 'unavailable');
      const prompt = messagesToPrompt(request.messages);
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          const chunks = await primeChunks(config.parse(await candidate.session.send(config.site, prompt)));
          config.onResult?.(candidate.profile, true);
          return { chunks };
        } catch (error) {
          config.onResult?.(candidate.profile, false);
          if (candidates.length === 1) throw error;
          failures.push(`${candidate.profile}: ${message(error)}`);
        }
      }
      throw new ProviderError(`${config.id} failed on every account: ${failures.join('; ')}`, 'unavailable');
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
