import type { ChatSite } from '../../browser/browser-chat.ts';
import { aspectRatio, type GeneratedImage, type ImageProvider, type ImageRequest } from '../../core/images/images.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import { collectChunks } from '../../core/streaming/sse.ts';
import type { ProfileSession } from '../browser-chat-provider.ts';
import { parseQwenStream, QWEN_CHAT_SITE } from '../qwen/web.ts';

const MODEL = 'qwen-chat/image';
const TEXT_MODEL = 'qwen3.7-plus';

export function qwenImageSite(width: number, height: number): ChatSite {
  return {
    ...QWEN_CHAT_SITE,
    modelFields: model => ({
      model,
      'messages.*.models': [model],
      'messages.*.chat_type': 't2i',
      'messages.*.sub_chat_type': 't2i',
      'messages.*.extra.meta.subChatType': 't2i',
      'messages.*.feature_config.thinking_enabled': false,
      size: aspectRatio(width, height),
    }),
  };
}

export function createQwenChatImages(sessions: () => ProfileSession[], available: () => boolean): ImageProvider {
  return {
    id: 'qwen-chat',
    available,
    supports: model => model === MODEL,
    listModels: async () => available() ? [MODEL] : [],
    async generate(request: ImageRequest): Promise<GeneratedImage> {
      const candidates = sessions();
      if (!candidates.length) throw new ProviderError('qwen-chat: no account is signed in', 'unavailable');
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          const { content } = await collectChunks(parseQwenStream(await candidate.session.send(qwenImageSite(request.width, request.height), request.prompt, TEXT_MODEL)));
          const url = /https?:\/\/\S+/.exec(content)?.[0];
          if (!url) throw new ProviderError(`Qwen returned no image${content ? `: ${content.slice(0, 200)}` : ''}`, 'upstream', 502);
          return { url };
        } catch (error) {
          if (candidates.length === 1) throw error;
          failures.push(`${candidate.profile}: ${error instanceof Error ? error.message : error}`);
        }
      }
      throw new ProviderError(`qwen-chat image failed on every account: ${failures.join('; ')}`, 'unavailable');
    },
  };
}
