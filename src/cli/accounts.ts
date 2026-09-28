import type { ApiKeyCredential, Credential } from '../core/accounts/credential-store.ts';
import type { SiteSignIn } from '../browser/sign-in-check.ts';
import { notSignedIn } from '../browser/browser-chat.ts';
import { formatOverview, type ProviderOverview } from './overview.ts';

export interface AccountsCliDeps {
  store: {
    list(provider?: string): Credential[];
    addApiKey(input: ApiKeyCredential): Credential;
    remove(id: string): boolean;
  };
  askHidden: (question: string) => Promise<string>;
  log: (line: string) => void;
  openGoogleSignIn?: () => Promise<void>;
  listGoogleAccounts?: () => Promise<string[]>;
  openWindow?: (url: string) => Promise<void>;
  verifyApiKey?: (provider: string, apiKey: string) => Promise<number>;
  checkSignIns?: (url?: string) => Promise<SiteSignIn[]>;
  overview?: () => ProviderOverview[];
  initSecret?: () => Promise<string>;
  secretSource?: () => Promise<string>;
  providerAuto?: (provider: string, auto?: boolean) => boolean;
}

const API_KEY_PROVIDERS = new Set(['nvidia']);

export const ACCOUNTS_USAGE = `Usage: bun run account <command>

  (no command) [--json]                           Show every provider and whether it is connected
  init                                            Create ACCOUNTS_SECRET in the system keyring (moves it out of .env)
  secret                                          Show where ACCOUNTS_SECRET is loaded from
  provider <id> [--auto on|off]                   Show or change whether model=auto may use a provider
  add <provider> --api-key [--label <name>]       Save an API key (the key is always prompted)
  list [provider]                                 List saved API keys
  remove <id>                                     Delete a saved API key
  test <id>                                       Check a saved API key
  google [--list]                                 Sign in to Google in the browser profile, then list its accounts
  open <https-url>                                Open a site in the browser profile to sign in manually
  status                                          Show which web chats the browser profile is signed in to

API key providers: ${[...API_KEY_PROVIDERS].join(', ')}
Web chats sign in through the browser profile: bun run account open <url>`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireProvider(provider: string | undefined) {
  if (!provider || !API_KEY_PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider ?? '(none)'}\n\n${ACCOUNTS_USAGE}`);
  return provider;
}

function reportSignIns(results: SiteSignIn[], log: (line: string) => void) {
  for (const { site, result } of results) {
    const host = new URL(site.url).hostname;
    log(result.signedIn ? `✓ ${site.id.padEnd(10)} ${host}` : `○ ${site.id.padEnd(10)} ${notSignedIn(site, result)}`);
  }
  return results.every(entry => entry.result.signedIn) ? 0 : 1;
}

export async function runAccountsCommand(args: string[], deps: AccountsCliDeps) {
  const [command, target] = args;

  if ((command === undefined || command === '--json' || command === 'overview') && deps.overview) {
    const rows = deps.overview();
    deps.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : formatOverview(rows));
    return 0;
  }

  if (command === 'init' && deps.initSecret) {
    deps.log(await deps.initSecret());
    return 0;
  }

  if (command === 'provider' && target && deps.providerAuto) {
    const value = option(args, '--auto');
    if (value !== undefined && value !== 'on' && value !== 'off') throw new Error('Use --auto on or --auto off');
    const auto = deps.providerAuto(target, value === undefined ? undefined : value === 'on');
    deps.log(`${target} auto: ${auto ? 'on' : 'off'}`);
    return 0;
  }

  if (command === 'secret' && deps.secretSource) {
    deps.log(`ACCOUNTS_SECRET: ${await deps.secretSource()}`);
    return 0;
  }

  if (command === 'google' && deps.listGoogleAccounts) {
    if (!args.includes('--list') && deps.openGoogleSignIn) {
      deps.log('Sign in to your Google accounts in the opened browser window, then close the window.');
      await deps.openGoogleSignIn();
    }
    const accounts = await deps.listGoogleAccounts();
    if (!accounts.length) deps.log('No Google accounts found in the browser profile.');
    for (const email of accounts) deps.log(`google\t${email}`);
    return 0;
  }

  if (command === 'open' && deps.openWindow) {
    let url: URL;
    try {
      url = new URL(target ?? '');
    } catch {
      throw new Error(`Enter a full https URL, e.g. https://www.kimi.com\n\n${ACCOUNTS_USAGE}`);
    }
    if (url.protocol !== 'https:') throw new Error('Only https URLs can be opened');
    deps.log(`Sign in on ${url.hostname} in the opened browser window, then close the window.`);
    await deps.openWindow(url.href);
    if (!deps.checkSignIns) return 0;
    const results = await deps.checkSignIns(url.href);
    return results.length ? reportSignIns(results, deps.log) : 0;
  }

  if (command === 'status' && deps.checkSignIns) {
    return reportSignIns(await deps.checkSignIns(), deps.log);
  }

  if (command === 'add' && args.includes('--api-key')) {
    const provider = requireProvider(target);
    const label = option(args, '--label') ?? 'default';
    const apiKey = (await deps.askHidden('API key: ')).trim();
    if (!apiKey) throw new Error('API key is required');
    if (!args.includes('--no-verify') && deps.verifyApiKey) {
      deps.log(`Key works: ${await deps.verifyApiKey(provider, apiKey)} models available`);
    }
    const credential = deps.store.addApiKey({ provider, label, apiKey });
    deps.log(`Saved ${credential.id} (${credential.email})`);
    return 0;
  }

  if (command === 'add') {
    requireProvider(target);
    throw new Error(`Use: bun run account add ${target} --api-key`);
  }

  if (command === 'list') {
    const credentials = deps.store.list(target);
    if (!credentials.length) deps.log('No saved accounts.');
    for (const credential of credentials) deps.log(`${credential.id}\t${credential.provider}\t${credential.email}`);
    return 0;
  }

  if (command === 'remove' && target) {
    const removed = deps.store.remove(target);
    deps.log(removed ? `Removed ${target}` : `Account not found: ${target}`);
    return removed ? 0 : 1;
  }

  if (command === 'test' && target) {
    const credential = deps.store.list().find(entry => entry.id === target);
    if (!credential) {
      deps.log(`Account not found: ${target}`);
      return 1;
    }
    if (credential.method === 'api-key') {
      if (!deps.verifyApiKey || !credential.token) throw new Error('API key checks are not available');
      deps.log(`OK ${credential.email}: ${await deps.verifyApiKey(credential.provider, credential.token)} models available`);
      return 0;
    }
    deps.log(`${credential.email} is not an API key; nothing to check`);
    return 1;
  }

  deps.log(ACCOUNTS_USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
}
