import { savedApiKey, type CredentialSource } from '../core/accounts/credential-store.ts';
import { ProviderError, upstreamError } from '../core/providers/errors.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.ts';

type Overrides = Pick<OpenAICompatibleConfig, 'env' | 'fetch'>;

export interface ApiProviderDefinition {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  keyUrl: string;
  keyOptional?: boolean;
  account?: { env: string; label: string };
  modelsUrl?: string;
  headers?: Record<string, string>;
  namespace?: boolean;
  modelFilter?: (model: string, entry?: Record<string, unknown>) => boolean;
  autoByDefault?: boolean;
  normalizeModel?: (model: string) => string;
  config?: Partial<OpenAICompatibleConfig>;
}

const NON_CHAT_MODEL = /embed|retriever|safety|guard|reward|parse|coder-6\.7b|translate|clip|detector|deplot/i;
const NON_CHAT_API_MODEL = /embed|whisper|tts|guard|moderation|ocr|imagen|veo|rerank|transcri|orpheus|playai|-image|image-|audio|aqa|live|bge-|diffusion|flux|safety|lyria/i;

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

export const XKIRO_PROVIDER: ApiProviderDefinition = {
  id: 'xkiro',
  label: 'xKiro',
  baseUrl: 'https://api.xkiro.com/v1',
  apiKeyEnv: 'XKIRO_API_KEY',
  keyUrl: 'https://xkiro.com/dashboard/keys',
  namespace: true,
  autoByDefault: false,
  modelFilter: (model, entry) => entry?.access_tier === 'free' && (entry.modality ?? 'chat') === 'chat' && isApiChatModel(model),
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
  {
    id: 'github-models',
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    modelsUrl: 'https://models.github.ai/catalog/models',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    apiKeyEnv: 'GITHUB_MODELS_API_KEY',
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    keyUrl: 'https://huggingface.co/settings/tokens',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'bigmodel',
    label: 'Zhipu BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'BIGMODEL_API_KEY',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    namespace: true,
    modelFilter: model => /flash/i.test(model) && isApiChatModel(model),
    config: { models: ['bigmodel/glm-4-flash'] },
  },
  {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    apiKeyEnv: 'COHERE_API_KEY',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'aion',
    label: 'Aion Labs',
    baseUrl: 'https://api.aionlabs.ai/v1',
    apiKeyEnv: 'AION_API_KEY',
    keyUrl: 'https://www.aionlabs.ai/app/api-keys/',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'ovhcloud',
    label: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    apiKeyEnv: 'OVHCLOUD_API_KEY',
    keyUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/',
    keyOptional: true,
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'llm7',
    label: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    apiKeyEnv: 'LLM7_API_KEY',
    keyUrl: 'https://token.llm7.io',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'zai',
    label: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    namespace: true,
    modelFilter: model => /flash/i.test(model) && isApiChatModel(model),
    config: { models: ['zai/glm-4.7-flash'] },
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    keyUrl: 'https://ollama.com/settings/keys',
    namespace: true,
    modelFilter: isApiChatModel,
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_ZEN_API_KEY',
    keyUrl: 'https://opencode.ai/auth',
    namespace: true,
    modelFilter: model => model.endsWith('-free') && isApiChatModel(model),
  },
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    apiKeyEnv: 'KILO_API_KEY',
    keyUrl: 'https://app.kilo.ai/profile',
    keyOptional: true,
    namespace: true,
    modelFilter: model => /(:free|\/free)$/.test(model) && isApiChatModel(model),
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    modelsUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/models/search?task=Text%20Generation&per_page=100',
    apiKeyEnv: 'CLOUDFLARE_API_KEY',
    account: { env: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID' },
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    namespace: true,
    config: {
      upstreamModels: false,
      models: [
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/moonshotai/kimi-k2.6',
        '@cf/zai-org/glm-4.7-flash',
        '@cf/google/gemma-4-26b-a4b-it',
        '@cf/qwen/qwen2.5-coder-32b-instruct',
        '@cf/qwen/qwq-32b',
        '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
        '@cf/meta/llama-3.2-3b-instruct',
      ].map(model => `cloudflare/${model}`),
    },
  },
  XKIRO_PROVIDER,
];

export const API_KEY_PROVIDERS: ApiProviderDefinition[] = [NVIDIA_PROVIDER, ...FREE_API_PROVIDERS];

export function apiKeyProvider(id: string) {
  return API_KEY_PROVIDERS.find(provider => provider.id === id);
}

export function defaultAuto(id: string) {
  return apiKeyProvider(id)?.autoByDefault ?? true;
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

export function accountEndpoint(definition: ApiProviderDefinition, apiKey: string, env: Record<string, string | undefined> = process.env) {
  if (!definition.account) return { baseUrl: definition.baseUrl, modelsUrl: definition.modelsUrl, apiKey };
  const separator = apiKey.indexOf(':');
  const account = separator > 0 ? apiKey.slice(0, separator).trim() : env[definition.account.env];
  const token = separator > 0 ? apiKey.slice(separator + 1).trim() : apiKey;
  if (!account) {
    throw new ProviderError(`${definition.label} needs the ${definition.account.label}: save the key as <${definition.account.label}>:<token> or set ${definition.account.env}`, 'unavailable');
  }
  const fill = (url: string) => url.replace('{account}', encodeURIComponent(account));
  return { baseUrl: fill(definition.baseUrl), modelsUrl: definition.modelsUrl ? fill(definition.modelsUrl) : undefined, apiKey: token };
}

export async function verifyProviderKey(definition: ApiProviderDefinition, apiKey: string, fetchFn: typeof fetch = fetch) {
  const target = accountEndpoint(definition, apiKey);
  const response = await fetchFn(target.modelsUrl ?? `${target.baseUrl}/models`, {
    headers: { ...definition.headers, Authorization: `Bearer ${target.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await upstreamError(`${definition.label} key check`, response);
  const body = await response.json() as unknown[] | { data?: unknown[]; result?: unknown[] };
  return (Array.isArray(body) ? body : body.data ?? body.result)?.length ?? 0;
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
    nativeTools: true,
    accountHint: `or run: bun run account add ${definition.id} --api-key`,
    ...(definition.namespace ? { namespace: definition.id } : {}),
    ...(definition.modelFilter ? { modelFilter: definition.modelFilter } : {}),
    ...(definition.normalizeModel ? { normalizeModel: definition.normalizeModel } : {}),
    ...(definition.keyOptional ? { optionalKey: true } : {}),
    ...(definition.modelsUrl ? { modelsUrl: definition.modelsUrl } : {}),
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(definition.account ? { endpoint: (apiKey: string | undefined) => accountEndpoint(definition, apiKey ?? '', overrides.env ?? process.env) } : {}),
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
