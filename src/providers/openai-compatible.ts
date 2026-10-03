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
import { KeyPool, parseKeyList, rotatesKey } from '../core/accounts/key-pool.ts';

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
  savedKeys?: () => string[];
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
  nativeTools?: boolean;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const TOOLS_REFUSED = /tool|function.?call/i;

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
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    chunks.push({
      type: 'tool_call',
      index: Number.isInteger(call?.index) ? call.index : 0,
      ...(typeof call?.id === 'string' ? { id: call.id } : {}),
      ...(typeof call?.function?.name === 'string' ? { name: call.function.name } : {}),
      ...(typeof call?.function?.arguments === 'string' ? { arguments: call.function.arguments } : {}),
    });
  }
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
  private readonly withoutTools = new Set<string>();

  constructor(private readonly config: OpenAICompatibleConfig, now: () => number = Date.now) {
    this.pool = new KeyPool(now);
    this.id = config.id;
    this.ownedBy = config.ownedBy;
    this.fallback = config.fallback ?? false;
  }

  private readonly pool: KeyPool;

  private keys() {
    const fromEnv = parseKeyList((this.config.env ?? process.env)[this.config.apiKeyEnv]);
    return [...new Set([...fromEnv, ...(this.config.savedKeys?.() ?? [])])];
  }

  private readyKeys() {
    return this.pool.order(this.keys());
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
    if (!this.config.optionalKey && !this.keys().length) return [];
    if (!this.config.upstreamModels) return this.config.models;
    try {
      const keys = this.keys();
      const candidates: Array<string | undefined> = keys.length ? [...new Set([...this.readyKeys(), ...keys])] : [undefined];
      let response: Response | undefined;
      for (const apiKey of candidates) {
        response = await (this.config.fetch ?? fetch)(this.config.modelsUrl ?? `${this.config.baseUrl}/models`, {
          headers: this.headers(apiKey),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok || ![401, 403, 429].includes(response.status)) break;
      }
      if (!response?.ok) return this.config.models;
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

  capabilities(model?: string): ModelCapabilities {
    const nativeTools = Boolean(this.config.nativeTools) && !(model && this.withoutTools.has(model));
    return { reasoning: false, vision: false, ...this.config.capabilities, nativeTools };
  }

  health() {
    if (this.config.optionalKey) return { available: true };
    const keys = this.keys();
    if (!keys.length) return { available: false, reason: this.missingKey() };
    if (this.readyKeys().length) return { available: true };
    const seconds = this.pool.secondsUntilReady(keys);
    return { available: false, reason: `all ${keys.length} ${this.config.label} keys are rate limited or rejected; next one in ${seconds}s` };
  }

  async stream(request: ChatRequest, context: ProviderContext = {}): Promise<ProviderStream> {
    const keys = this.keys();
    if (!keys.length) {
      if (!this.config.optionalKey) throw new ProviderError(this.missingKey(), 'unavailable');
      return this.streamWith(undefined, request, context);
    }
    const ready = this.readyKeys();
    if (!ready.length) throw new ProviderError(this.health().reason ?? this.missingKey(), 'rate_limit', 429);
    let lastError: unknown;
    for (const key of ready) {
      try {
        const result = await this.streamWith(key, request, context);
        this.pool.succeeded(key);
        return result;
      } catch (error) {
        if (!(error instanceof ProviderError) || !rotatesKey(error.kind)) throw error;
        this.pool.failed(key, error.kind, error.retryAfterSeconds);
        lastError = error;
      }
    }
    throw lastError;
  }

  private async streamWith(apiKey: string | undefined, request: ChatRequest, context: ProviderContext): Promise<ProviderStream> {
    const model = this.upstreamId(request.model);
    const target = this.config.endpoint?.(apiKey) ?? { baseUrl: this.config.baseUrl, apiKey };
    const tools = request.tools?.length && this.capabilities(request.model).nativeTools ? request.tools : undefined;
    const response = await (this.config.fetch ?? fetch)(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers(target.apiKey) },
      body: JSON.stringify({ ...this.config.extraBody, model, messages: request.messages, stream: true, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
      signal: context.signal,
    });
    if (!response.ok) {
      if (tools && [400, 404, 422].includes(response.status) && TOOLS_REFUSED.test(await response.clone().text())) {
        this.withoutTools.add(request.model);
      }
      throw await upstreamError(`${this.config.label} completion`, response);
    }
    return { chunks: openAIChunks(response.body) };
  }
}
