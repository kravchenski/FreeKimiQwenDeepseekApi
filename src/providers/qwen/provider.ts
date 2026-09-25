import { getAvailableToken, hasValidTokens } from '../../api/tokenManager.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from '../openai-compatible.ts';

type Overrides = Partial<Pick<OpenAICompatibleConfig, 'env' | 'fetch' | 'resolveApiKey' | 'hasApiKey'>>;

const DEFAULT_BASE_URL = 'https://qwen.aikit.club/v1';

export const QWEN_FALLBACK_MODELS = [
  'qwen3.8-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3-coder-plus',
  'qwen-deep-research',
  'qwen-web-dev',
  'qwen-full-stack',
  'qwen-slides',
];

export function createQwenProvider(overrides: Overrides = {}) {
  const env = overrides.env ?? process.env;
  return new OpenAICompatibleProvider({
    id: 'qwen',
    ownedBy: 'qwen-api',
    label: 'Qwen API',
    baseUrl: env.QWEN_API_BASE_URL || DEFAULT_BASE_URL,
    apiKeyEnv: 'QWEN_TOKEN',
    prefixes: ['qwen'],
    models: QWEN_FALLBACK_MODELS,
    upstreamModels: true,
    capabilities: { reasoning: true, vision: true },
    resolveApiKey: async () => (await getAvailableToken())?.token,
    hasApiKey: hasValidTokens,
    ...overrides,
  });
}
