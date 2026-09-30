import type {
  ChatChunk,
  ChatRequest,
  ModelCapabilities,
  Provider,
  ProviderContext,
  ProviderStream,
} from '../core/providers/provider.ts';
import { classifyStatus, ProviderError, upstreamError } from '../core/providers/errors.ts';
import { readLines } from '../core/streaming/sse.ts';

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
  namespace?: string;
  normalizeModel?: (model: string) => string;
  fallback?: boolean;
  accountHint?: string;
  acceptListedModels?: boolean;
  modelFilter?: (model: string, entry?: Record<string, unknown>) => boolean;
  optionalKey?: boolean;
  modelsUrl?: string;
  headers?: Record<string, string>;
  endpoint?: (apiKey: string | undefined) => { baseUrl: string; apiKey?: string };
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

  private headers(apiKey: string | undefined): Record<string, string> {
    return { ...this.config.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  }

  private missingKey() {
    return `${this.config.apiKeyEnv} is not set${this.config.accountHint ? `; ${this.config.accountHint}` : ''}`;
  }

  supports(model: string) {
    if (this.config.namespace) return model.startsWith(`${this.config.namespace}/`);
    return Boolean(this.listed?.has(model)) || this.config.prefixes.some(prefix => model.startsWith(prefix));
  }

  private accepts(model: string, entry?: Record<string, unknown>) {
    const known = this.config.namespace || this.config.acceptListedModels || this.config.prefixes.some(prefix => model.startsWith(prefix));
    return Boolean(known) && (this.config.modelFilter?.(model, entry) ?? true);
  }

  private publicId(model: string) {
    const id = this.config.normalizeModel?.(model) ?? model;
    return this.config.namespace ? `${this.config.namespace}/${id}` : id;
  }

  private upstreamId(model: string) {
    const prefix = this.config.namespace ? `${this.config.namespace}/` : '';
    const id = prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
    return this.config.upstreamModel?.(id) ?? id;
  }

  async listModels() {
    if (!this.config.optionalKey && !this.envApiKey && this.config.hasApiKey && !this.config.hasApiKey()) return [];
    if (!this.config.upstreamModels) return this.config.models;
    try {
      const apiKey = await this.apiKey();
      if (!apiKey && !this.config.optionalKey) return [];
      const response = await (this.config.fetch ?? fetch)(this.config.modelsUrl ?? `${this.config.baseUrl}/models`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return this.config.models;
      const body = await response.json() as Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> };
      const listed = Array.isArray(body) ? body : body.data ?? [];
      const ids = [...new Set(listed.filter(model => typeof model.id === 'string' && this.accepts(model.id, model)).map(model => this.publicId(model.id as string)))];
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
    return this.config.optionalKey || this.envApiKey || this.config.hasApiKey?.()
      ? { available: true }
      : { available: false, reason: this.missingKey() };
  }

  async stream(request: ChatRequest, context: ProviderContext = {}): Promise<ProviderStream> {
    const apiKey = await this.apiKey();
    if (!apiKey && !this.config.optionalKey) throw new ProviderError(this.missingKey(), 'unavailable');
    const model = this.upstreamId(request.model);
    const target = this.config.endpoint?.(apiKey) ?? { baseUrl: this.config.baseUrl, apiKey };
    const response = await (this.config.fetch ?? fetch)(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers(target.apiKey) },
      body: JSON.stringify({ ...this.config.extraBody, model, messages: request.messages, stream: true }),
      signal: context.signal,
    });
    if (!response.ok) throw await upstreamError(`${this.config.label} completion`, response);
    return { chunks: openAIChunks(response.body) };
  }
}
