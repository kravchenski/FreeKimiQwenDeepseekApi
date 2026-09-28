import type {
  ChatChunk,
  ChatRequest,
  ModelCapabilities,
  Provider,
  ProviderContext,
  ProviderStream,
} from '../core/providers/provider.ts';
import { classifyStatus, ProviderError, upstreamError, type ProviderErrorKind } from '../core/providers/errors.ts';
import { readLines } from '../core/streaming/sse.ts';

export type UpstreamOutcome =
  | { ok: true }
  | { ok: false; kind: ProviderErrorKind; status?: number; retryAfterSeconds?: number };

export interface OpenAICompatibleConfig {
  id: string;
  ownedBy: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  prefixes: string[];
  models: string[];
  upstreamModel?: (model: string) => string;
  extraBody?: Record<string, unknown>;
  capabilities?: Partial<ModelCapabilities>;
  resolveApiKey?: () => Promise<string | undefined>;
  hasApiKey?: () => boolean;
  upstreamModels?: boolean;
  fallback?: boolean;
  accountHint?: string;
  acceptListedModels?: boolean;
  modelFilter?: (model: string) => boolean;
  reportResult?: (apiKey: string, outcome: UpstreamOutcome) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

function streamError(error: unknown) {
  const details = typeof error === 'object' && error !== null ? error as Record<string, unknown> : { message: String(error) };
  const message = String(details.message ?? JSON.stringify(details)).slice(0, 300);
  const code = Number(details.code ?? details.status);
  const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : details.type === 'service_unavailable' ? 503 : 502;
  return new ProviderError(`Upstream stream failed: ${message}`, classifyStatus(status, message), status);
}

export function parseOpenAIEvent(line: string): ChatChunk[] | 'done' | null {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'done';
  let event: any;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event?.error) throw streamError(event.error);
  const delta = event?.choices?.[0]?.delta;
  if (!delta) return null;
  const chunks: ChatChunk[] = [];
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning) chunks.push({ type: 'reasoning', text: reasoning });
  if (typeof delta.content === 'string' && delta.content) chunks.push({ type: 'content', text: delta.content });
  return chunks;
}

async function* openAIChunks(body: ReadableStream<Uint8Array> | null) {
  for await (const line of readLines(body)) {
    const parsed = parseOpenAIEvent(line);
    if (parsed === 'done') return;
    if (parsed) yield* parsed;
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly ownedBy: string;
  readonly fallback: boolean;
  private listed?: Set<string>;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.ownedBy = config.ownedBy;
    this.fallback = config.fallback ?? false;
  }

  private get envApiKey() {
    return (this.config.env ?? process.env)[this.config.apiKeyEnv];
  }

  private async apiKey() {
    return this.envApiKey || (await this.config.resolveApiKey?.());
  }

  private missingKey() {
    return `${this.config.apiKeyEnv} is not set${this.config.accountHint ? `; ${this.config.accountHint}` : ''}`;
  }

  supports(model: string) {
    return Boolean(this.listed?.has(model)) || this.config.prefixes.some(prefix => model.startsWith(prefix));
  }

  private accepts(model: string) {
    const known = this.config.acceptListedModels || this.config.prefixes.some(prefix => model.startsWith(prefix));
    return known && (this.config.modelFilter?.(model) ?? true);
  }

  async listModels() {
    if (!this.config.upstreamModels) return this.config.models;
    try {
      const apiKey = await this.apiKey();
      if (!apiKey) return this.config.models;
      const response = await (this.config.fetch ?? fetch)(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return this.config.models;
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const ids = (body.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string' && this.accepts(id));
      if (!ids.length) return this.config.models;
      if (this.config.acceptListedModels) this.listed = new Set(ids);
      return ids;
    } catch {
      return this.config.models;
    }
  }

  capabilities(): ModelCapabilities {
    return { nativeTools: false, reasoning: false, vision: false, ...this.config.capabilities };
  }

  health() {
    return this.envApiKey || this.config.hasApiKey?.()
      ? { available: true }
      : { available: false, reason: this.missingKey() };
  }

  async forward(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
    const apiKey = await this.apiKey();
    if (!apiKey) throw new ProviderError(this.missingKey(), 'unavailable');
    const response = await (this.config.fetch ?? fetch)(`${this.config.baseUrl}${path}`, {
      method: init.method ?? 'POST',
      headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
      body: init.body,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const error = await upstreamError(`${this.config.label} ${path}`, response);
      this.config.reportResult?.(apiKey, { ok: false, kind: error.kind, status: error.status, retryAfterSeconds: error.retryAfterSeconds });
      throw error;
    }
    this.config.reportResult?.(apiKey, { ok: true });
    return response;
  }

  async stream(request: ChatRequest, context: ProviderContext = {}): Promise<ProviderStream> {
    const apiKey = await this.apiKey();
    if (!apiKey) throw new ProviderError(this.missingKey(), 'unavailable');
    const model = this.config.upstreamModel?.(request.model) ?? request.model;
    const response = await (this.config.fetch ?? fetch)(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...this.config.extraBody, model, messages: request.messages, stream: true }),
      signal: context.signal,
    });
    if (!response.ok) {
      const error = await upstreamError(`${this.config.label} completion`, response);
      this.config.reportResult?.(apiKey, { ok: false, kind: error.kind, status: error.status, retryAfterSeconds: error.retryAfterSeconds });
      throw error;
    }
    this.config.reportResult?.(apiKey, { ok: true });
    return { chunks: openAIChunks(response.body) };
  }
}
