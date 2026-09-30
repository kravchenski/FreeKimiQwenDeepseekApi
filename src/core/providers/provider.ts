export type ChatMessage = Record<string, any>;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  conversationId?: string;
  tools?: ChatMessage[];
}

export type ChatChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments?: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

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
  readonly fallback?: boolean;
  supports(model: string): boolean;
  listModels(): Promise<string[]>;
  capabilities(model: string): ModelCapabilities;
  stream(request: ChatRequest, context?: ProviderContext): Promise<ProviderStream>;
  health(): ProviderHealth;
}
