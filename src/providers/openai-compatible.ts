import type {
  ChatChunk,
  ChatRequest,
  ModelCapabilities,
  Provider,
  ProviderContext,
  ProviderStream,
} from '../core/providers/provider.ts';
import { ProviderError, upstreamError, type ProviderErrorKind } from '../core/providers/errors.ts';
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
  reportResult?: (apiKey: string, outcome: UpstreamOutcome) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
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

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.ownedBy = config.ownedBy;
  }

  private get envApiKey() {
    return (this.config.env ?? process.env)[this.config.apiKeyEnv];
  }

  private async apiKey() {
    return this.envApiKey || (await this.config.resolveApiKey?.());
  }

  supports(model: string) {
    return this.config.prefixes.some(prefix => model.startsWith(prefix));
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
      const ids = (body.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string' && this.supports(id));
      return ids.length ? ids : this.config.models;
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
      : { available: false, reason: `${this.config.apiKeyEnv} is not set` };
  }

  async stream(request: ChatRequest, context: ProviderContext = {}): Promise<ProviderStream> {
    const apiKey = await this.apiKey();
    if (!apiKey) throw new ProviderError(`${this.config.apiKeyEnv} is not set`, 'unavailable');
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
