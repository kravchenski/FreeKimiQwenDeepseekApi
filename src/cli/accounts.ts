import type { ApiKeyCredential, BrowserSession, Credential } from '../core/accounts/credential-store.ts';
import type { CapturedSession } from '../browser/site-session.ts';
import type { SiteSignIn } from '../browser/sign-in-check.ts';
import { notSignedIn } from '../browser/browser-chat.ts';
import type { QwenSession } from '../providers/qwen/auth.ts';

export interface AccountsCliDeps {
  store: {
    list(provider?: string): Credential[];
    add(input: Omit<Credential, 'id'>): Credential;
    addBrowserSession?(input: BrowserSession): Credential;
    addApiKey?(input: ApiKeyCredential): Credential;
    remove(id: string): boolean;
  };
  signIn: (email: string, password: string) => Promise<QwenSession>;
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
  log: (line: string) => void;
  openGoogleSignIn?: () => Promise<void>;
  listGoogleAccounts?: () => Promise<string[]>;
  captureSession?: (provider: string) => Promise<CapturedSession>;
  openWindow?: (url: string) => Promise<void>;
  verifyApiKey?: (provider: string, apiKey: string) => Promise<number>;
  checkSignIns?: (url?: string) => Promise<SiteSignIn[]>;
}

const PASSWORD_PROVIDERS = new Set(['qwen']);
const API_KEY_PROVIDERS = new Set(['nvidia']);
const PROVIDERS = new Set([...PASSWORD_PROVIDERS, ...API_KEY_PROVIDERS]);

export const ACCOUNTS_USAGE = `Usage: bun run account <command>

  add <provider> [--email <email>] [--no-verify]  Save an account (password is always prompted)
  add <provider> --browser [--label <name>]       Sign in yourself in the browser; the session is captured
  add <provider> --api-key [--label <name>]       Save an API key (the key is always prompted)
  list [provider]                                 List saved accounts
  remove <id>                                     Delete an account
  test <id>                                       Sign in with a saved account
  google [--list]                                 Sign in to Google in the browser profile, then list its accounts
  open <https-url>                                Open a site in the browser profile to sign in manually
  status                                          Show which web chats the browser profile is signed in to

Providers: ${[...PASSWORD_PROVIDERS].join(', ')} (email or browser), ${[...API_KEY_PROVIDERS].join(', ')} (API key)`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireProvider(provider: string | undefined, allowed: Set<string> = PASSWORD_PROVIDERS) {
  if (!provider || !PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider ?? '(none)'}\n\n${ACCOUNTS_USAGE}`);
  if (!allowed.has(provider)) {
    const hint = API_KEY_PROVIDERS.has(provider) ? `use: bun run account add ${provider} --api-key` : `use: bun run account add ${provider}`;
    throw new Error(`${provider} does not support this sign-in method; ${hint}`);
  }
  return provider;
}

function reportSignIns(results: SiteSignIn[], log: (line: string) => void) {
  for (const { site, result } of results) {
    const host = new URL(site.url).hostname;
    log(result.signedIn ? `✓ ${site.id.padEnd(10)} ${host}` : `○ ${site.id.padEnd(10)} ${notSignedIn(site, result)}`);
  }
  return results.every(entry => entry.result.signedIn) ? 0 : 1;
}

function describeExpiry(session: QwenSession) {
  return session.expiresAt ? `token valid until ${new Date(session.expiresAt).toISOString()}` : 'token has no expiry';
}

export async function runAccountsCommand(args: string[], deps: AccountsCliDeps) {
  const [command, target] = args;

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

  if (command === 'add' && args.includes('--browser')) {
    const provider = requireProvider(target);
    if (!deps.captureSession || !deps.store.addBrowserSession) throw new Error('Browser sign-in is not available');
    deps.log('Sign in in the opened browser window. When the chat is open, close the window.');
    const session = await deps.captureSession(provider);
    const label = session.email ?? option(args, '--label') ?? await deps.ask('Account label (e.g. email): ');
    const credential = deps.store.addBrowserSession({ provider, email: label, token: session.token, expiresAt: session.expiresAt });
    deps.log(`Saved ${credential.id} (${credential.email}): ${describeExpiry(session)}`);
    return 0;
  }

  if (command === 'add' && args.includes('--api-key')) {
    const provider = requireProvider(target, API_KEY_PROVIDERS);
    if (!deps.store.addApiKey) throw new Error('API keys are not supported by this store');
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
    const provider = requireProvider(target);
    const email = option(args, '--email') ?? await deps.ask('Email: ');
    const password = await deps.askHidden('Password: ');
    if (!args.includes('--no-verify')) {
      deps.log(`Signed in as ${email}: ${describeExpiry(await deps.signIn(email, password))}`);
    }
    const credential = deps.store.add({ provider, email, password });
    deps.log(`Saved ${credential.id} (${credential.email})`);
    return 0;
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
    if (credential.method === 'browser') {
      deps.log(`${credential.email} is a browser session; send a request through the gateway to check it`);
      return 0;
    }
    deps.log(`OK ${credential.email}: ${describeExpiry(await deps.signIn(credential.email, credential.password))}`);
    return 0;
  }

  deps.log(ACCOUNTS_USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
}
