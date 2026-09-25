#!/usr/bin/env bun

import { runAccountsCommand } from '../src/cli/accounts.ts';
import { CredentialStore } from '../src/core/accounts/credential-store.ts';
import { qwenSignIn } from '../src/providers/qwen/auth.ts';
import { QWEN_CREDENTIALS_FILE } from '../src/providers/qwen/provider.ts';
import { askHidden } from '../src/utils/hiddenPrompt.ts';
import { prompt } from '../src/utils/prompt.ts';

try {
  process.exitCode = await runAccountsCommand(process.argv.slice(2), {
    store: new CredentialStore(QWEN_CREDENTIALS_FILE, process.env.ACCOUNTS_SECRET),
    signIn: qwenSignIn,
    ask: question => prompt(question) as Promise<string>,
    askHidden,
    log: line => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
