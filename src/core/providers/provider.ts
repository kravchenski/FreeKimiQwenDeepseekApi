export type ChatMessage = Record<string, any>;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  conversationId?: string;
}

export type ChatChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string };

export interface ProviderStream {
  chunks: AsyncIterable<ChatChunk>;
  responseFields?: Record<string, unknown>;
}

export interface ModelCapabilities {
  nativeTools: boolean;
  reasoning: boolean;
  vision: boolean;
}

export interface ProviderHealth {
  available: boolean;
  reason?: string;
}

export interface ProviderContext {
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly ownedBy: string;
  supports(model: string): boolean;
  listModels(): Promise<string[]>;
  capabilities(model: string): ModelCapabilities;
  stream(request: ChatRequest, context?: ProviderContext): Promise<ProviderStream>;
  health(): ProviderHealth;
}
