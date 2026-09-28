import { savedApiKey, type CredentialSource } from '../core/accounts/credential-store.ts';
import { upstreamError } from '../core/providers/errors.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.ts';

type Overrides = Pick<OpenAICompatibleConfig, 'env' | 'fetch'>;

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

const NON_CHAT_MODEL = /embed|retriever|safety|guard|reward|parse|coder-6\.7b|translate|clip|detector|deplot/i;

export function isNvidiaChatModel(model: string) {
  return !NON_CHAT_MODEL.test(model);
}

const SAVED_KEY_TTL_MS = 60_000;

function savedKeyReader(credentials: CredentialSource, now: () => number = Date.now) {
  let key: string | undefined;
  let readAt = -Infinity;
  return () => {
    if (now() - readAt > SAVED_KEY_TTL_MS) {
      key = savedApiKey(credentials, 'nvidia');
      readAt = now();
    }
    return key;
  };
}

export async function verifyNvidiaKey(apiKey: string, fetchFn: typeof fetch = fetch) {
  const response = await fetchFn(`${NVIDIA_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await upstreamError('NVIDIA key check', response);
  const body = await response.json() as { data?: unknown[] };
  return body.data?.length ?? 0;
}

export function createNvidiaProvider(overrides: Overrides = {}, credentials?: CredentialSource) {
  const savedKey = credentials ? savedKeyReader(credentials) : undefined;
  return new OpenAICompatibleProvider({
    id: 'nvidia',
    ownedBy: 'nvidia',
    label: 'NVIDIA',
    baseUrl: NVIDIA_BASE,
    apiKeyEnv: 'NVIDIA_API_KEY',
    prefixes: ['deepseek-ai/', 'nvidia/', 'moonshotai/', 'minimaxai/', 'z-ai/'],
    models: ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.6', 'z-ai/glm-5.3'],
    upstreamModels: true,
    acceptListedModels: true,
    fallback: true,
    accountHint: 'or run: bun run account add nvidia --api-key',
    ...(savedKey ? {
      resolveApiKey: async () => savedKey(),
      hasApiKey: () => Boolean(savedKey()),
    } : {}),
    modelFilter: isNvidiaChatModel,
    extraBody: { temperature: 1, top_p: 0.95, max_tokens: 8192 },
    capabilities: { reasoning: true },
    ...overrides,
  });
}
