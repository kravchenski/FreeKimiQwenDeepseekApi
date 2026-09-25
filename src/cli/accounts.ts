import type { Credential } from '../core/accounts/credential-store.ts';
import type { QwenSession } from '../providers/qwen/auth.ts';

export interface AccountsCliDeps {
  store: {
    list(provider?: string): Credential[];
    add(input: Omit<Credential, 'id'>): Credential;
    remove(id: string): boolean;
  };
  signIn: (email: string, password: string) => Promise<QwenSession>;
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
  log: (line: string) => void;
}

const PROVIDERS = new Set(['qwen']);

export const ACCOUNTS_USAGE = `Usage: bun run account <command>

  add <provider> [--email <email>] [--no-verify]  Save an account (password is always prompted)
  list [provider]                                 List saved accounts
  remove <id>                                     Delete an account
  test <id>                                       Sign in with a saved account

Providers: ${[...PROVIDERS].join(', ')}`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireProvider(provider: string | undefined) {
  if (!provider || !PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider ?? '(none)'}\n\n${ACCOUNTS_USAGE}`);
  return provider;
}

function describeExpiry(session: QwenSession) {
  return session.expiresAt ? `token valid until ${new Date(session.expiresAt).toISOString()}` : 'token has no expiry';
}

export async function runAccountsCommand(args: string[], deps: AccountsCliDeps) {
  const [command, target] = args;

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
    deps.log(`OK ${credential.email}: ${describeExpiry(await deps.signIn(credential.email, credential.password))}`);
    return 0;
  }

  deps.log(ACCOUNTS_USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
}
