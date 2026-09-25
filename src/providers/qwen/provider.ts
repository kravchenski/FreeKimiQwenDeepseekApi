import path from 'node:path';

import { getAvailableToken, hasValidTokens } from '../../api/tokenManager.ts';
import { SESSION_DIR } from '../../config.ts';
import { CredentialStore } from '../../core/accounts/credential-store.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from '../openai-compatible.ts';
import { QwenAccountPool } from './account-pool.ts';
import { qwenSignIn } from './auth.ts';
import { qwenBrowserSignIn } from './browser-login.ts';

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

export const QWEN_CREDENTIALS_FILE = path.resolve(SESSION_DIR, 'qwen', 'accounts.enc');

export function qwenLogin(env: Record<string, string | undefined> = process.env) {
  if (env.QWEN_LOGIN_MODE === 'http') return (email: string, password: string) => qwenSignIn(email, password);
  return (email: string, password: string) => qwenBrowserSignIn(email, password, { headless: env.QWEN_BROWSER_HEADFUL !== '1' });
}

export function createQwenAccountPool(env: Record<string, string | undefined> = process.env) {
  return new QwenAccountPool(new CredentialStore(QWEN_CREDENTIALS_FILE, env.ACCOUNTS_SECRET), qwenLogin(env));
}

export function createQwenProvider(overrides: Overrides = {}, accounts = createQwenAccountPool(overrides.env)) {
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
    resolveApiKey: async () => (await accounts.token()) ?? (await getAvailableToken())?.token,
    hasApiKey: () => accounts.hasAccounts() || hasValidTokens(),
    ...overrides,
  });
}
