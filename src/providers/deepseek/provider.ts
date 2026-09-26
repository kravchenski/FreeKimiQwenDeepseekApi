import { AccountPool } from '../../core/accounts/account-pool.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../../core/providers/provider.ts';
import { openDatabase } from '../../core/store/database.ts';
import { readLines } from '../../core/streaming/sse.ts';
import { hasValidDeepSeekAccounts, loadDeepSeekAccounts, markDeepSeekAccountInvalid, type DeepSeekAccount } from './accounts.ts';
import { deepSeekCompletion, envAccount, fetchDeepSeekModels, parseDeepSeekEvent } from './client.ts';

type Completion = { response: Response; sessionId: string };

interface DeepSeekDependencies {
  complete: (request: ChatRequest & { account?: DeepSeekAccount }) => Promise<Completion>;
  listModels: () => Promise<string[]>;
  hasAccount: () => boolean;
  accounts: () => DeepSeekAccount[];
  fallbackAccount: () => DeepSeekAccount | null;
  pool: () => AccountPool;
  markInvalid: (id: string) => void;
  now: () => number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;

let sharedPool: AccountPool | undefined;

const defaults: DeepSeekDependencies = {
  complete: deepSeekCompletion,
  listModels: fetchDeepSeekModels,
  hasAccount: () => hasValidDeepSeekAccounts() || Boolean(process.env.DEEPSEEK_TOKEN),
  accounts: () => loadDeepSeekAccounts().filter(account => !account.invalid),
  fallbackAccount: envAccount,
  pool: () => (sharedPool ??= new AccountPool(openDatabase(), 'deepseek')),
  markInvalid: markDeepSeekAccountInvalid,
  now: Date.now,
};

async function* deepSeekChunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<ChatChunk> {
  const state: Parameters<typeof parseDeepSeekEvent>[1] = { phase: 'content' };
  for await (const line of readLines(body)) {
    const event = parseDeepSeekEvent(line, state);
    if (!event) continue;
    if (event.reasoning) yield { type: 'reasoning', text: event.reasoning };
    if (event.content) yield { type: 'content', text: event.content };
    if (event.done) return;
  }
}

function recordFailure(deps: DeepSeekDependencies, pool: AccountPool, account: DeepSeekAccount, error: unknown) {
  if (!(error instanceof ProviderError)) {
    pool.markFailure(account.id, error instanceof Error ? error.message : String(error));
    return false;
  }
  if (error.kind === 'auth') {
    pool.markUnauthorized(account.id, error.message.slice(0, 200));
    deps.markInvalid(account.id);
    return true;
  }
  if (error.kind === 'rate_limit') {
    pool.markRateLimited(account.id, deps.now() + (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000);
    return true;
  }
  if (error.kind === 'quota_exhausted') {
    pool.markQuotaExhausted(account.id, error.retryAfterSeconds === undefined ? undefined : deps.now() + error.retryAfterSeconds * 1000);
    return true;
  }
  pool.markFailure(account.id, error.message.slice(0, 200));
  return false;
}

async function completeWithPool(deps: DeepSeekDependencies, request: ChatRequest): Promise<Completion> {
  const accounts = deps.accounts();
  if (!accounts.length) return deps.complete({ ...request, account: deps.fallbackAccount() ?? undefined });
  const pool = deps.pool();
  pool.sync(accounts.map(account => account.id));
  const remaining = new Set(accounts.map(account => account.id));
  let lastError: unknown;
  while (remaining.size) {
    const id = pool.acquire([...remaining]);
    if (!id) break;
    remaining.delete(id);
    const account = accounts.find(candidate => candidate.id === id)!;
    try {
      const completion = await deps.complete({ ...request, account });
      pool.markSuccess(id);
      return completion;
    } catch (error) {
      lastError = error;
      if (!recordFailure(deps, pool, account, error)) throw error;
    }
  }
  const fallback = deps.fallbackAccount();
  if (fallback) return deps.complete({ ...request, account: fallback });
  if (lastError) throw lastError;
  throw new ProviderError('All DeepSeek accounts are cooling down or unavailable', 'unavailable');
}

export function createDeepSeekProvider(overrides: Partial<DeepSeekDependencies> = {}): Provider {
  const deps = { ...defaults, ...overrides };
  return {
    id: 'deepseek',
    ownedBy: 'deepseek-web',
    supports: model => model.startsWith('deepseek-') && !model.startsWith('deepseek-ai/'),
    listModels: deps.listModels,
    capabilities: model => ({
      nativeTools: false,
      reasoning: model.includes('reasoner') || model.includes('r1'),
      vision: false,
    }),
    health: () =>
      deps.hasAccount() ? { available: true } : { available: false, reason: 'No active DeepSeek accounts' },
    async stream(request): Promise<ProviderStream> {
      const { response, sessionId } = await completeWithPool(deps, request);
      return { chunks: deepSeekChunks(response.body), responseFields: { x_deepseek_chat_id: sessionId } };
    },
  };
}
