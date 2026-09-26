import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.ts';

type Overrides = Pick<OpenAICompatibleConfig, 'env' | 'fetch'>;

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

const NON_CHAT_MODEL = /embed|retriever|safety|guard|reward|parse|coder-6\.7b/i;

export function isNvidiaChatModel(model: string) {
  return !NON_CHAT_MODEL.test(model);
}

export function createNvidiaProvider(overrides: Overrides = {}) {
  return new OpenAICompatibleProvider({
    id: 'nvidia',
    ownedBy: 'nvidia',
    label: 'NVIDIA',
    baseUrl: NVIDIA_BASE,
    apiKeyEnv: 'NVIDIA_API_KEY',
    prefixes: ['deepseek-ai/', 'nvidia/', 'moonshotai/', 'minimaxai/', 'z-ai/'],
    models: ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.6', 'z-ai/glm-5.3'],
    upstreamModels: true,
    modelFilter: isNvidiaChatModel,
    extraBody: { temperature: 1, top_p: 0.95, max_tokens: 8192 },
    capabilities: { reasoning: true },
    ...overrides,
  });
}
