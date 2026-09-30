import type { GeneratedImage, ImageProvider, ImageRequest } from '../../core/images/images.ts';
import { upstreamError } from '../../core/providers/errors.ts';

const BASE_URL = 'https://image.pollinations.ai';
const PREFIX = 'pollinations/';

export function createPollinationsImages(fetchFn: typeof fetch = fetch): ImageProvider {
  return {
    id: 'pollinations',
    available: () => true,
    supports: model => model.startsWith(PREFIX),
    async listModels() {
      try {
        const response = await fetchFn(`${BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
        const models = response.ok ? await response.json() as unknown : [];
        const ids = Array.isArray(models) ? models.filter((model): model is string => typeof model === 'string') : [];
        return (ids.length ? ids : ['sana']).map(model => `${PREFIX}${model}`);
      } catch {
        return [`${PREFIX}sana`];
      }
    },
    async generate(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
      const params = new URLSearchParams({
        width: String(request.width),
        height: String(request.height),
        model: request.model.slice(PREFIX.length),
        nologo: 'true',
        seed: String(Math.floor(Math.random() * 1_000_000)),
      });
      const response = await fetchFn(`${BASE_URL}/prompt/${encodeURIComponent(request.prompt)}?${params}`, { signal: signal ?? AbortSignal.timeout(120_000) });
      if (!response.ok) throw await upstreamError('Pollinations image', response);
      return { base64: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType: response.headers.get('content-type') ?? 'image/jpeg' };
    },
  };
}
