import type { ChatSite } from '../browser/browser-chat.ts';
import type { AccountStatus } from '../core/accounts/account-pool.ts';
import type { Credential } from '../core/accounts/credential-store.ts';
import type { SignInRecord } from '../core/accounts/sign-in-status.ts';

export type ConnectionState = 'connected' | 'degraded' | 'not-connected' | 'unknown';

export interface ProviderOverview {
  id: string;
  kind: 'account' | 'web' | 'api-key';
  state: ConnectionState;
  detail: string;
  fix?: string;
  auto: boolean;
  url?: string;
}

type Row = Omit<ProviderOverview, 'auto'>;

export interface OverviewInput {
  env: Record<string, string | undefined>;
  credentials: () => Credential[];
  deepseekAccounts: () => Array<{ id: string; invalid?: boolean }>;
  accountStates: () => Array<{ provider: string; accountId: string; status: AccountStatus }>;
  signIn: (provider: string) => SignInRecord | undefined;
  accountSignIns?: (provider: string) => SignInRecord[];
  webSites: ChatSite[];
  autoEnabled?: (provider: string) => boolean;
  apiKeyProviders?: Array<{ id: string; apiKeyEnv: string; keyUrl?: string }>;
  now?: number;
}

const DEFAULT_API_KEY_PROVIDERS: Array<{ id: string; apiKeyEnv: string; keyUrl?: string }> = [{ id: 'nvidia', apiKeyEnv: 'NVIDIA_API_KEY' }];

const STATUS_LABELS: Record<Exclude<AccountStatus, 'healthy'>, string> = {
  cooldown: 'cooling down',
  quota_exhausted: 'quota exhausted',
  unauthorized: 'signed out',
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function ago(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function pooled(id: string, ids: string[], extra: string[], states: OverviewInput['accountStates'], fix: string): Row {
  if (!ids.length && !extra.length) return { id, kind: 'account', state: 'not-connected', detail: 'no accounts', fix };
  const byId = new Map(states().filter(state => state.provider === id).map(state => [state.accountId, state.status]));
  const problems = new Map<string, number>();
  for (const accountId of ids) {
    const status = byId.get(accountId);
    if (status && status !== 'healthy') problems.set(STATUS_LABELS[status], (problems.get(STATUS_LABELS[status]) ?? 0) + 1);
  }
  const usable = ids.length - [...problems.values()].reduce((sum, count) => sum + count, 0) + extra.length;
  const parts = [ids.length ? plural(ids.length, 'account') : '', ...extra].filter(Boolean);
  const issues = [...problems].map(([label, count]) => `${count} ${label}`);
  return {
    id,
    kind: 'account',
    state: usable === 0 ? 'not-connected' : issues.length ? 'degraded' : 'connected',
    detail: `${parts.join(' + ')}${issues.length ? ` (${issues.join(', ')})` : ''}`,
    ...(usable === 0 ? { fix } : {}),
  };
}

export function buildOverview(input: OverviewInput): ProviderOverview[] {
  const autoEnabled = (provider: string) => {
    try {
      return input.autoEnabled?.(provider) ?? true;
    } catch {
      return true;
    }
  };
  return collectRows(input).map(row => ({ ...row, auto: autoEnabled(row.id) }));
}

function collectRows(input: OverviewInput): Row[] {
  const now = input.now ?? Date.now();
  let credentials: Credential[] = [];
  let registryError: string | undefined;
  try {
    credentials = input.credentials();
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error);
  }
  const safeStates = () => {
    try {
      return input.accountStates();
    } catch {
      return [];
    }
  };
  const rows: Row[] = [];

  let deepseek: Array<{ id: string; invalid?: boolean }> = [];
  try {
    deepseek = input.deepseekAccounts();
  } catch {}
  const invalid = deepseek.filter(account => account.invalid).length;
  const deepseekRow = pooled('deepseek', deepseek.filter(account => !account.invalid).map(account => account.id), [], safeStates, 'bun run auth:deepseek');
  if (invalid) deepseekRow.detail += `; ${invalid} invalid`;
  rows.push(deepseekRow);

  for (const site of input.webSites) {
    if (!site.signIn) {
      rows.push({ id: site.id, kind: 'web', state: 'connected', detail: `${new URL(site.url).hostname}: no sign-in needed`, url: site.url });
      continue;
    }
    let records: SignInRecord[] = [];
    try {
      records = input.accountSignIns ? input.accountSignIns(site.id) : [input.signIn(site.id)].filter(record => record !== undefined);
    } catch {}
    const host = new URL(site.url).hostname;
    const signedIn = records.filter(record => record.signedIn);
    const latest = Math.max(...records.map(record => record.checkedAt));
    const accounts = records.length > 1 ? ` on ${signedIn.length} of ${records.length} accounts` : '';
    if (!records.length) {
      rows.push({ id: site.id, kind: 'web', state: 'unknown', detail: `${host}: not checked yet`, fix: 'bun run account status', url: site.url });
    } else if (signedIn.length) {
      rows.push({ id: site.id, kind: 'web', state: signedIn.length < records.length ? 'degraded' : 'connected', detail: `${host}: signed in${accounts} (checked ${ago(now - latest)})`, url: site.url });
    } else {
      rows.push({ id: site.id, kind: 'web', state: 'not-connected', detail: records.length > 1 ? `${host}: not signed in on any of ${records.length} accounts` : records[0]!.reason ?? `${host}: not signed in`, fix: `bun run account open ${site.url}`, url: site.url });
    }
  }

  for (const provider of input.apiKeyProviders ?? DEFAULT_API_KEY_PROVIDERS) {
    const fromEnvironment = Boolean(input.env[provider.apiKeyEnv]);
    const saved = credentials.some(entry => entry.provider === provider.id && entry.method === 'api-key' && entry.token);
    const url = provider.keyUrl ? { url: provider.keyUrl } : {};
    if (fromEnvironment || saved) {
      rows.push({ id: provider.id, kind: 'api-key', state: 'connected', detail: `API key (${fromEnvironment ? 'environment' : 'saved'})`, ...url });
    } else if (registryError) {
      rows.push({ id: provider.id, kind: 'api-key', state: 'unknown', detail: `registry locked: ${registryError}`, fix: 'bun run account init', ...url });
    } else {
      rows.push({ id: provider.id, kind: 'api-key', state: 'not-connected', detail: 'no API key', fix: `bun run account add ${provider.id} --api-key`, ...url });
    }
  }

  return rows;
}

const MARKS: Record<ConnectionState, string> = { connected: '✓', degraded: '!', 'not-connected': '○', unknown: '?' };

export function formatOverview(rows: ProviderOverview[]) {
  const lines = rows.map(row => `  ${MARKS[row.state]} ${row.id.padEnd(10)} ${row.detail}${row.fix ? `\n               → ${row.fix}` : ''}`);
  const connected = rows.filter(row => row.state === 'connected' || row.state === 'degraded').length;
  return [`Providers (${connected}/${rows.length} connected)`, '', ...lines, '', 'More: bun run account help'].join('\n');
}
