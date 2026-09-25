import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.ts';

type Overrides = Pick<OpenAICompatibleConfig, 'env' | 'fetch'>;

const ZENMUX_BASE = 'https://zenmux.ai/api/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

export function createNvidiaProvider(overrides: Overrides = {}) {
  return new OpenAICompatibleProvider({
    id: 'nvidia',
    ownedBy: 'nvidia',
    label: 'NVIDIA',
    baseUrl: NVIDIA_BASE,
    apiKeyEnv: 'NVIDIA_API_KEY',
    prefixes: ['deepseek-ai/', 'nvidia/', 'moonshotai/', 'minimaxai/'],
    models: ['deepseek-ai/deepseek-v4-pro', 'moonshotai/kimi-k2.6'],
    extraBody: { temperature: 1, top_p: 0.95, max_tokens: 8192 },
    capabilities: { reasoning: true },
    ...overrides,
  });
}

export function createZenMuxProviders(overrides: Overrides = {}) {
  const shared = { baseUrl: ZENMUX_BASE, apiKeyEnv: 'ZENMUX_API_KEY', ...overrides };
  return [
    new OpenAICompatibleProvider({
      ...shared,
      id: 'kimi',
      ownedBy: 'kimi-zenmux',
      label: 'Kimi (ZenMux)',
      prefixes: ['kimi-'],
      models: ['kimi-k2.7-code-free'],
      upstreamModel: model => `moonshotai/${model}`,
    }),
    new OpenAICompatibleProvider({
      ...shared,
      id: 'glm',
      ownedBy: 'glm-zenmux',
      label: 'GLM (ZenMux)',
      prefixes: ['glm-'],
      models: ['glm-5.2-free', 'glm-4.7-flash-free'],
      upstreamModel: model => `z-ai/${model}`,
    }),
    new OpenAICompatibleProvider({
      ...shared,
      id: 'sapiens',
      ownedBy: 'sapiens-zenmux',
      label: 'Sapiens (ZenMux)',
      prefixes: ['sapiens-ai/'],
      models: ['sapiens-ai/agnes-2.0-flash'],
    }),
    new OpenAICompatibleProvider({
      ...shared,
      id: 'stepfun',
      ownedBy: 'stepfun-zenmux',
      label: 'StepFun (ZenMux)',
      prefixes: ['stepfun/'],
      models: ['stepfun/step-3.7-flash-free'],
    }),
  ];
}
