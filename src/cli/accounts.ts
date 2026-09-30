import type { ApiKeyCredential, Credential } from '../core/accounts/credential-store.ts';
import type { SiteSignIn } from '../browser/sign-in-check.ts';
import type { BrowserProfile } from '../browser/profiles.ts';
import { notSignedIn } from '../browser/browser-chat.ts';
import { formatOverview, type ProviderOverview } from './overview.ts';
import { API_KEY_PROVIDERS as API_KEY_DEFINITIONS } from '../providers/catalog.ts';

export interface AccountsCliDeps {
  store: {
    list(provider?: string): Credential[];
    addApiKey(input: ApiKeyCredential): Credential;
    remove(id: string): boolean;
  };
  askHidden: (question: string) => Promise<string>;
  log: (line: string) => void;
  openGoogleSignIn?: (profile: string) => Promise<void>;
  listGoogleAccounts?: (profile: string) => Promise<string[]>;
  openWindow?: (urls: string[], profile: string) => Promise<void>;
  verifyApiKey?: (provider: string, apiKey: string) => Promise<number>;
  accountLabel?: (provider: string) => string | undefined;
  checkSignIns?: (url: string | undefined, profile?: string) => Promise<ProfileSignIn[]>;
  profiles?: {
    list(): BrowserProfile[];
    add(label: string): BrowserProfile;
    remove(id: string): boolean;
    summary?(): unknown;
  };
  chatUrls?: string[];
  overview?: () => ProviderOverview[];
  initSecret?: () => Promise<string>;
  secretSource?: () => Promise<string>;
  providerAuto?: (provider: string, auto?: boolean) => boolean;
  autoSettings?: (change: { focus?: string; mode?: string; agents?: Record<string, string | undefined> }) => { focus: string; mode: string; agents?: Record<string, boolean> };
}

const API_KEY_PROVIDERS = new Set(API_KEY_DEFINITIONS.map(provider => provider.id));

export type ProfileSignIn = SiteSignIn & { profile?: BrowserProfile };

const DEFAULT_ACCOUNT = 'default';
const GOOGLE_SIGN_IN_URL = 'https://accounts.google.com/';

export const ACCOUNTS_USAGE = `Usage: bun run account <command>

  (no command) [--json]                           Show every provider and whether it is connected
  init                                            Create ACCOUNTS_SECRET in the system keyring (moves it out of .env)
  secret                                          Show where ACCOUNTS_SECRET is loaded from
  provider <id> [--auto on|off]                   Show or change whether model=auto may use a provider
  auto [--focus <f>] [--mode <m>] [--compact on|off]
                                                  Show or change model=auto (focus general|coding|reasoning|fast, mode fallback|race|decide)
                                                  and coding agent requests (--compact trims tool output)
  add <provider> --api-key [--label <name>]       Save an API key (the key is always prompted)
  list [provider]                                 List saved API keys
  remove <id>                                     Delete a saved API key
  test <id>                                       Check a saved API key
  profiles [--json]                               List browser accounts and their web chat sign-ins
  profile add <name>                              Create a browser account (its own browser profile)
  profile remove <id>                             Delete a browser account and its browser profile
  connect [--profile <id>]                        Open Google and every web chat in an account to sign in, then check them
  google [--list] [--profile <id>]                Sign in to Google in a browser account, then list its Google accounts
  open <https-url> [--profile <id>]               Open a site in a browser account to sign in manually
  status [--profile <id>]                         Show which web chats each browser account is signed in to

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

function reportSignIns(results: ProfileSignIn[], log: (line: string) => void) {
  const labelled = new Set(results.map(entry => entry.profile?.id ?? DEFAULT_ACCOUNT)).size > 1;
  for (const { site, result, profile } of results) {
    const host = new URL(site.url).hostname;
    const suffix = labelled && profile ? `  [${profile.label}]` : '';
    log(result.signedIn ? `✓ ${site.id.padEnd(10)} ${host}${suffix}` : `○ ${site.id.padEnd(10)} ${notSignedIn(site, result)}${suffix}`);
  }
  return results.every(entry => entry.result.signedIn) ? 0 : 1;
}

function profileOption(args: string[], deps: AccountsCliDeps) {
  const id = option(args, '--profile') ?? DEFAULT_ACCOUNT;
  if (deps.profiles && !deps.profiles.list().some(profile => profile.id === id)) {
    throw new Error(`Unknown account: ${id}. See: bun run account profiles`);
  }
  return id;
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

  if (command === 'auto' && deps.autoSettings) {
    const current = deps.autoSettings({ focus: option(args, '--focus'), mode: option(args, '--mode'), agents: { compact: option(args, '--compact') } });
    deps.log(`auto focus: ${current.focus}`);
    deps.log(`auto mode: ${current.mode}`);
    for (const [name, on] of Object.entries(current.agents ?? {})) deps.log(`agents ${name}: ${on ? 'on' : 'off'}`);
    return 0;
  }

  if (command === 'secret' && deps.secretSource) {
    deps.log(`ACCOUNTS_SECRET: ${await deps.secretSource()}`);
    return 0;
  }

  if (command === 'profiles' && deps.profiles) {
    if (args.includes('--json')) {
      deps.log(JSON.stringify(deps.profiles.summary?.() ?? deps.profiles.list(), null, 2));
      return 0;
    }
    for (const profile of deps.profiles.list()) deps.log(`${profile.id}\t${profile.label}`);
    return 0;
  }

  if (command === 'profile' && target === 'add' && deps.profiles) {
    const label = args.slice(2).join(' ');
    const profile = deps.profiles.add(label);
    deps.log(`Created ${profile.id} (${profile.label}). Sign it in to the web chats: bun run account connect --profile ${profile.id}`);
    return 0;
  }

  if (command === 'profile' && target === 'remove' && deps.profiles) {
    const id = args[2];
    if (!id) throw new Error('Use: bun run account profile remove <id>');
    const removed = deps.profiles.remove(id);
    deps.log(removed ? `Removed ${id}` : `Account not found: ${id}`);
    return removed ? 0 : 1;
  }

  if (command === 'connect' && deps.openWindow) {
    const profile = profileOption(args, deps);
    deps.log('Sign in to Google, then to every web chat tab in the opened window (use "Sign in with Google"). Close the window when done.');
    await deps.openWindow([GOOGLE_SIGN_IN_URL, ...(deps.chatUrls ?? [])], profile);
    return deps.checkSignIns ? reportSignIns(await deps.checkSignIns(undefined, profile), deps.log) : 0;
  }

  if (command === 'google' && deps.listGoogleAccounts) {
    const profile = profileOption(args, deps);
    if (!args.includes('--list') && deps.openGoogleSignIn) {
      deps.log('Sign in to your Google accounts in the opened browser window, then close the window.');
      await deps.openGoogleSignIn(profile);
    }
    const accounts = await deps.listGoogleAccounts(profile);
    if (!accounts.length) deps.log('No Google accounts found in the browser profile.');
    for (const email of accounts) deps.log(`google\t${email}`);
    return 0;
  }

  if (command === 'open' && deps.openWindow) {
    const profile = profileOption(args, deps);
    let url: URL;
    try {
      url = new URL(target ?? '');
    } catch {
      throw new Error(`Enter a full https URL, e.g. https://www.kimi.com\n\n${ACCOUNTS_USAGE}`);
    }
    if (url.protocol !== 'https:') throw new Error('Only https URLs can be opened');
    deps.log(`Sign in on ${url.hostname} in the opened browser window, then close the window.`);
    await deps.openWindow([url.href], profile);
    if (!deps.checkSignIns) return 0;
    const results = await deps.checkSignIns(url.href, profile);
    return results.length ? reportSignIns(results, deps.log) : 0;
  }

  if (command === 'status' && deps.checkSignIns) {
    const profile = args.includes('--profile') ? profileOption(args, deps) : undefined;
    return reportSignIns(await deps.checkSignIns(undefined, profile), deps.log);
  }

  if (command === 'add' && args.includes('--api-key')) {
    const provider = requireProvider(target);
    const label = option(args, '--label') ?? 'default';
    let apiKey = (await deps.askHidden('API key: ')).trim();
    if (!apiKey) throw new Error('API key is required');
    const accountLabel = deps.accountLabel?.(provider);
    if (accountLabel && !apiKey.includes(':')) {
      const account = (await deps.askHidden(`${accountLabel}: `)).trim();
      if (!account) throw new Error(`${accountLabel} is required`);
      apiKey = `${account}:${apiKey}`;
    }
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
