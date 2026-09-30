import type { GeneratedImage, ImageProvider, ImageRequest } from '../../core/images/images.ts';
import { ProviderError, upstreamError } from '../../core/providers/errors.ts';
import { accountEndpoint, type ApiProviderDefinition } from '../catalog.ts';

const PREFIX = 'cloudflare/';
export const CLOUDFLARE_IMAGE_MODELS = [
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/bytedance/stable-diffusion-xl-lightning',
];

export function createCloudflareImages(definition: ApiProviderDefinition, apiKey: () => string | undefined, fetchFn: typeof fetch = fetch): ImageProvider {
  return {
    id: 'cloudflare',
    available: () => Boolean(apiKey()),
    supports: model => model.startsWith(PREFIX),
    listModels: async () => apiKey() ? CLOUDFLARE_IMAGE_MODELS.map(model => `${PREFIX}${model}`) : [],
    async generate(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
      const key = apiKey();
      if (!key) throw new ProviderError(`${definition.apiKeyEnv} is not set; or run: bun run account add cloudflare --api-key`, 'unavailable');
      const target = accountEndpoint(definition, key);
      const model = request.model.slice(PREFIX.length);
      const response = await fetchFn(`${target.baseUrl.replace(/\/v1$/, '')}/run/${model}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify({ prompt: request.prompt, width: request.width, height: request.height }),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw await upstreamError('Cloudflare image', response);
      const type = response.headers.get('content-type') ?? '';
      if (type.startsWith('image/')) return { base64: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType: type };
      const body = await response.json() as { result?: { image?: string } };
      if (!body.result?.image) throw new ProviderError('Cloudflare returned no image', 'upstream', 502);
      return { base64: body.result.image, mimeType: 'image/jpeg' };
    },
  };
}
