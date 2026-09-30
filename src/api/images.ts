import { parseSize, toBase64, toUrl, type ImageProvider } from '../core/images/images.ts';
import { ProviderError } from '../core/providers/errors.ts';

const MAX_IMAGES = 4;
const MAX_PROMPT = 4000;

export interface ImageAttempt {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function listImageModels(providers: ImageProvider[]) {
  const results = await Promise.allSettled(providers.filter(provider => provider.available()).map(async provider => (await provider.listModels()).map(id => ({ id, ownedBy: provider.id }))));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

async function routes(providers: ImageProvider[], model: string | undefined) {
  if (model && model !== 'auto') {
    const provider = providers.find(entry => entry.supports(model));
    if (!provider) throw new ProviderError(`Unknown image model: ${model}; see GET /v1/images/models`, 'model_unavailable', 404);
    return [{ provider, model }];
  }
  const models = await listImageModels(providers);
  const firstPerProvider = providers.flatMap(provider => {
    const found = models.find(entry => entry.ownedBy === provider.id);
    return found ? [{ provider, model: found.id }] : [];
  });
  if (!firstPerProvider.length) throw new ProviderError('No image provider is available', 'unavailable', 503);
  return firstPerProvider;
}

export async function generateImages(
  providers: ImageProvider[],
  body: Record<string, unknown>,
  onAttempt: (attempt: ImageAttempt) => void = () => {},
  now: () => number = Date.now,
) {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new ProviderError('prompt is required', 'invalid_request', 400);
  if (prompt.length > MAX_PROMPT) throw new ProviderError(`prompt is longer than ${MAX_PROMPT} characters`, 'invalid_request', 400);
  const count = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) throw new ProviderError(`n must be between 1 and ${MAX_IMAGES}`, 'invalid_request', 400);
  const format = body.response_format ?? 'url';
  if (format !== 'url' && format !== 'b64_json') throw new ProviderError('response_format must be url or b64_json', 'invalid_request', 400);
  const { width, height } = parseSize(body.size);
  const candidates = await routes(providers, typeof body.model === 'string' ? body.model : undefined);
  const failures: string[] = [];
  for (const { provider, model } of candidates) {
    const data: Array<{ url?: string; b64_json?: string; revised_prompt: string }> = [];
    const started = now();
    try {
      for (let index = 0; index < count; index++) {
        const image = await provider.generate({ model, prompt, width, height });
        data.push(format === 'url' ? { url: toUrl(image), revised_prompt: prompt } : { b64_json: (await toBase64(image)).base64, revised_prompt: prompt });
      }
      onAttempt({ provider: provider.id, model, ok: true, latencyMs: now() - started });
      return { created: Math.floor(now() / 1000), model, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onAttempt({ provider: provider.id, model, ok: false, latencyMs: now() - started, error: message });
      if (candidates.length === 1) throw error;
      failures.push(`${model}: ${message}`);
    }
  }
  throw new ProviderError(`Every image provider failed: ${failures.join('; ')}`, 'unavailable', 503);
}
