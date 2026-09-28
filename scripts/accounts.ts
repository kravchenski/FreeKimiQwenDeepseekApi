#!/usr/bin/env bun

import { runAccountsCommand } from '../src/cli/accounts.ts';
import { openCredentialStore } from '../src/core/accounts/credential-store.ts';
import { verifyNvidiaKey } from '../src/providers/catalog.ts';
import { qwenLogin } from '../src/providers/qwen/provider.ts';
import { askHidden } from '../src/utils/hiddenPrompt.ts';
import { listGoogleAccounts, openGoogleSignIn, openProfileWindow } from '../src/browser/google-profile.ts';
import { captureSiteSession, QWEN_SITE } from '../src/browser/site-session.ts';
import { prompt } from '../src/utils/prompt.ts';

try {
  process.exitCode = await runAccountsCommand(process.argv.slice(2), {
    store: openCredentialStore(),
    signIn: qwenLogin(),
    ask: question => prompt(question),
    askHidden,
    log: line => console.log(line),
    openGoogleSignIn: () => openGoogleSignIn(),
    listGoogleAccounts: () => listGoogleAccounts(),
    openWindow: url => openProfileWindow(url),
    verifyApiKey: (provider, apiKey) => {
      if (provider !== 'nvidia') throw new Error(`API keys are not supported for ${provider}`);
      return verifyNvidiaKey(apiKey);
    },
    captureSession: provider => {
      if (provider !== 'qwen') throw new Error(`Browser sign-in is not supported for ${provider}`);
      return captureSiteSession(QWEN_SITE);
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
