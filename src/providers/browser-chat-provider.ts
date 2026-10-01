import { webChatModelSlug, type BrowserChatSession, type ChatSite, type WebChatModel } from '../browser/browser-chat.ts';
import { ProviderError } from '../core/providers/errors.ts';
import type { ChatChunk, Provider, ProviderHealth, ProviderStream } from '../core/providers/provider.ts';
import { collectImageUrls, messagesToPrompt, stripImages } from '../core/providers/prompt.ts';
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
  models?: () => WebChatModel[] | undefined;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createBrowserChatProvider(config: BrowserChatProviderConfig): Provider {
  const prefix = `${config.model}/`;
  const models = () => {
    const listed = config.models?.();
    return listed?.length ? listed : config.site.defaultModels ?? [];
  };
  const upstreamModel = (model: string) => {
    if (!model.startsWith(prefix)) return undefined;
    const slug = model.slice(prefix.length);
    return models().find(entry => webChatModelSlug(entry.name) === slug)?.id ?? slug;
  };
  return {
    id: config.id,
    ownedBy: config.ownedBy,
    supports: model => model === config.model || model.startsWith(prefix),
    listModels: async () => [config.model, ...models().map(entry => `${prefix}${webChatModelSlug(entry.name)}`)],
    capabilities: () => ({ nativeTools: false, reasoning: config.reasoning ?? true, vision: config.site.images === true }),
    health: () => config.health?.() ?? { available: true },
    async stream(request): Promise<ProviderStream> {
      const candidates = config.sessions();
      if (!candidates.length) throw new ProviderError(`${config.id}: no account is signed in`, 'unavailable');
      const supported = config.site.images === true;
      const prompt = messagesToPrompt(stripImages(request.messages, supported));
      const extractImages = (messages: Record<string, any>[]) => supported ? collectImageUrls(messages) : [];
      const model = upstreamModel(request.model);
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          const chunks = await primeChunks(config.parse(await candidate.session.send(config.site, prompt, model, {
            conversationId: request.conversationId,
            messages: request.messages,
            toPrompt: messages => messagesToPrompt(stripImages(messages, supported)),
            extractImages,
          })));
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
