import { ProviderError } from '../providers/errors.ts';

export interface GeneratedImage {
  url?: string;
  base64?: string;
  mimeType?: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  width: number;
  height: number;
}

export interface ImageProvider {
  readonly id: string;
  available(): boolean;
  listModels(): Promise<string[]>;
  supports(model: string): boolean;
  generate(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage>;
}

const MAX_SIDE = 2048;

export function parseSize(size: unknown) {
  if (size === undefined || size === null || size === 'auto') return { width: 1024, height: 1024 };
  const match = typeof size === 'string' ? /^(\d{2,4})x(\d{2,4})$/.exec(size) : null;
  if (!match) throw new ProviderError(`Unsupported size: ${String(size)}; use WIDTHxHEIGHT, e.g. 1024x1024`, 'invalid_request', 400);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new ProviderError(`Size must be between 64 and ${MAX_SIDE} pixels per side`, 'invalid_request', 400);
  }
  return { width, height };
}

export function aspectRatio(width: number, height: number) {
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
  const target = width / height;
  return ratios.reduce((best, ratio) => {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    const [bw, bh] = best.split(':').map(Number) as [number, number];
    return Math.abs(w / h - target) < Math.abs(bw / bh - target) ? ratio : best;
  });
}

export async function toBase64(image: GeneratedImage, fetchFn: typeof fetch = fetch) {
  if (image.base64) return { base64: image.base64, mimeType: image.mimeType ?? 'image/png' };
  const response = await fetchFn(image.url!, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new ProviderError(`Image download failed: ${response.status}`, 'upstream', 502);
  return { base64: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType: response.headers.get('content-type') ?? 'image/png' };
}

export function toUrl(image: GeneratedImage) {
  return image.url ?? `data:${image.mimeType ?? 'image/png'};base64,${image.base64}`;
}
