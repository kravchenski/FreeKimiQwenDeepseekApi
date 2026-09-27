import { ProviderError } from '../core/providers/errors.ts';

export interface ImageUpstream {
  forward(path: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
}

const RESPONSE_FORMATS = new Set(['url', 'b64_json']);
const MAX_PROMPT_LENGTH = 4_000;

function invalid(message: string) {
  return new ProviderError(message, 'invalid_request');
}

function prompt(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw invalid('prompt must be a non-empty string');
  if (value.length > MAX_PROMPT_LENGTH) throw invalid(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  return value;
}

function options(body: Record<string, unknown>) {
  const out: Record<string, string> = {};
  if (body.size !== undefined) {
    if (typeof body.size !== 'string') throw invalid('size must be a string');
    out.size = body.size;
  }
  if (body.response_format !== undefined) {
    if (typeof body.response_format !== 'string' || !RESPONSE_FORMATS.has(body.response_format)) {
      throw invalid('response_format must be url or b64_json');
    }
    out.response_format = body.response_format;
  }
  return out;
}

function imageReference(value: unknown) {
  if (typeof value !== 'string') throw invalid('image must be an https URL or a data URL');
  if (/^data:image\/[a-z+.-]+;base64,/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('image must be an https URL or a data URL');
  }
  if (url.protocol !== 'https:') throw invalid('image URLs must use https');
  return url.href;
}

async function json(upstream: ImageUpstream, path: string, body: Record<string, unknown>) {
  const response = await upstream.forward(path, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export async function generateImage(upstream: ImageUpstream, body: Record<string, unknown>) {
  return json(upstream, '/images/generations', { prompt: prompt(body.prompt), ...options(body) });
}

export async function editImage(upstream: ImageUpstream, request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const images = form.getAll('image').concat(form.getAll('image[]'));
    if (images.length !== 1 || typeof images[0] === 'string') throw invalid('send exactly one image file');
    const upstreamForm = new FormData();
    upstreamForm.set('prompt', prompt(form.get('prompt')));
    upstreamForm.set('image', images[0]!);
    for (const [key, value] of Object.entries(options(Object.fromEntries(['size', 'response_format'].flatMap(name => {
      const value = form.get(name);
      return value === null ? [] : [[name, value]];
    }))))) upstreamForm.set(key, value);
    const response = await upstream.forward('/images/edits', { body: upstreamForm });
    return response.json() as Promise<Record<string, unknown>>;
  }
  const body = await request.json().catch(() => {
    throw invalid('Invalid JSON body');
  }) as Record<string, unknown>;
  return json(upstream, '/images/edits', { prompt: prompt(body.prompt), image: imageReference(body.image), ...options(body) });
}
