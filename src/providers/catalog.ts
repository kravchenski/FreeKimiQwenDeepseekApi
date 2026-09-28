import { savedApiKey, type CredentialSource } from '../core/accounts/credential-store.ts';
import { upstreamError } from '../core/providers/errors.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.ts';

type Overrides = Pick<OpenAICompatibleConfig, 'env' | 'fetch'>;

export interface ApiProviderDefinition {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  keyUrl: string;
  namespace?: boolean;
  modelFilter?: (model: string) => boolean;
  normalizeModel?: (model: string) => string;
  config?: Partial<OpenAICompatibleConfig>;
}

const NON_CHAT_MODEL = /embed|retriever|safety|guard|reward|parse|coder-6\.7b|translate|clip|detector|deplot/i;
const NON_CHAT_API_MODEL = /embed|whisper|tts|guard|moderation|ocr|imagen|veo|rerank|transcri|orpheus|playai|-image|image-|audio|aqa|live/i;

export function isNvidiaChatModel(model: string) {
  return !NON_CHAT_MODEL.test(model);
}

export function isApiChatModel(model: string) {
  return !NON_CHAT_API_MODEL.test(model);
}

export const NVIDIA_PROVIDER: ApiProviderDefinition = {
  id: 'nvidia',
  label: 'NVIDIA',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKeyEnv: 'NVIDIA_API_KEY',
  keyUrl: 'https://build.nvidia.com',
  modelFilter: isNvidiaChatModel,
  config: {
    prefixes: ['deepseek-ai/', 'nvidia/', 'moonshotai/', 'minimaxai/', 'z-ai/'],
    models: ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.6', 'z-ai/glm-5.3'],
    acceptListedModels: true,
    extraBody: { temperature: 1, top_p: 0.95, max_tokens: 8192 },
    capabilities: { reasoning: true },
  },
};

export const FREE_API_PROVIDERS: ApiProviderDefinition[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    namespace: true,
    modelFilter: model => model.endsWith(':free') && isApiChatModel(model),
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    namespace: true,
    modelFilter: model => /gemini|gemma/i.test(model) && isApiChatModel(model),
    normalizeModel: model => model.replace(/^models\//, ''),
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    namespace: true,
    modelFilter: isApiChatModel,
  },
];

export const API_KEY_PROVIDERS: ApiProviderDefinition[] = [NVIDIA_PROVIDER, ...FREE_API_PROVIDERS];

export function apiKeyProvider(id: string) {
  return API_KEY_PROVIDERS.find(provider => provider.id === id);
}

const SAVED_KEY_TTL_MS = 60_000;

const savedKeyResets = new Set<() => void>();

export function forgetSavedKeys() {
  for (const reset of savedKeyResets) reset();
}

function savedKeyReader(credentials: CredentialSource, provider: string, now: () => number = Date.now) {
  let key: string | undefined;
  let readAt = -Infinity;
  savedKeyResets.add(() => { readAt = -Infinity; });
  return () => {
    if (now() - readAt > SAVED_KEY_TTL_MS) {
      key = savedApiKey(credentials, provider);
      readAt = now();
    }
    return key;
  };
}

export async function verifyProviderKey(definition: ApiProviderDefinition, apiKey: string, fetchFn: typeof fetch = fetch) {
  const response = await fetchFn(`${definition.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await upstreamError(`${definition.label} key check`, response);
  const body = await response.json() as { data?: unknown[] };
  return body.data?.length ?? 0;
}

export function verifyNvidiaKey(apiKey: string, fetchFn: typeof fetch = fetch) {
  return verifyProviderKey(NVIDIA_PROVIDER, apiKey, fetchFn);
}

export function createApiProvider(definition: ApiProviderDefinition, overrides: Overrides = {}, credentials?: CredentialSource) {
  const savedKey = credentials ? savedKeyReader(credentials, definition.id) : undefined;
  return new OpenAICompatibleProvider({
    id: definition.id,
    ownedBy: definition.id,
    label: definition.label,
    baseUrl: definition.baseUrl,
    apiKeyEnv: definition.apiKeyEnv,
    prefixes: [],
    models: [],
    upstreamModels: true,
    fallback: true,
    accountHint: `or run: bun run account add ${definition.id} --api-key`,
    ...(definition.namespace ? { namespace: definition.id } : {}),
    ...(definition.modelFilter ? { modelFilter: definition.modelFilter } : {}),
    ...(definition.normalizeModel ? { normalizeModel: definition.normalizeModel } : {}),
    ...definition.config,
    ...(savedKey ? {
      resolveApiKey: async () => savedKey(),
      hasApiKey: () => Boolean(savedKey()),
    } : {}),
    ...overrides,
  });
}

export function createNvidiaProvider(overrides: Overrides = {}, credentials?: CredentialSource) {
  return createApiProvider(NVIDIA_PROVIDER, overrides, credentials);
}
