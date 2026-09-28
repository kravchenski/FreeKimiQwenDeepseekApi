#!/usr/bin/env bun

import { runAccountsCommand } from '../src/cli/accounts.ts';
import { openCredentialStore } from '../src/core/accounts/credential-store.ts';
import { API_KEY_PROVIDERS, apiKeyProvider, verifyProviderKey } from '../src/providers/catalog.ts';
import { askHidden } from '../src/utils/hiddenPrompt.ts';
import { listGoogleAccounts, openGoogleSignIn, openProfileWindow } from '../src/browser/google-profile.ts';
import { checkSignIns } from '../src/browser/sign-in-check.ts';
import { notSignedIn } from '../src/browser/browser-chat.ts';
import { WebSignInStatus } from '../src/core/accounts/sign-in-status.ts';
import { loadProviderSetting, loadSignIn, openDatabase, saveProviderSetting, saveSignIn } from '../src/core/store/database.ts';
import { ProviderSettings } from '../src/core/providers/settings.ts';
import { siteForUrl, WEB_CHAT_SITES } from '../src/providers/web-chat-sites.ts';
import { buildOverview } from '../src/cli/overview.ts';
import { INIT_MESSAGES, initAccountsSecret } from '../src/cli/accounts-secret.ts';
import { loadAccountsSecret, systemKeyring } from '../src/core/secrets/accounts-secret.ts';
import { accountStates } from '../src/core/status.ts';
import { loadDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';

const environmentSecret = process.env.ACCOUNTS_SECRET;
const secretSource = await loadAccountsSecret();
const store = openCredentialStore();

try {
  process.exitCode = await runAccountsCommand(process.argv.slice(2), {
    store,
    askHidden,
    log: line => console.log(line),
    openGoogleSignIn: () => openGoogleSignIn(),
    listGoogleAccounts: () => listGoogleAccounts(),
    openWindow: url => openProfileWindow(url),
    initSecret: async () => INIT_MESSAGES[await initAccountsSecret({ envFile: '.env', env: { ACCOUNTS_SECRET: environmentSecret }, keyring: systemKeyring })],
    secretSource: async () => secretSource,
    providerAuto: (provider, auto) => {
      const known = new Set(['deepseek', ...API_KEY_PROVIDERS.map(entry => entry.id), ...WEB_CHAT_SITES.map(site => site.id)]);
      if (!known.has(provider)) throw new Error(`Unknown provider: ${provider}`);
      const db = openDatabase();
      try {
        const settings = new ProviderSettings({ load: id => loadProviderSetting(db, id), save: setting => saveProviderSetting(db, setting) });
        return auto === undefined ? settings.autoEnabled(provider) : settings.setAuto(provider, auto).auto;
      } finally {
        db.close();
      }
    },
    overview: () => {
      const db = openDatabase();
      try {
        return buildOverview({
          env: process.env,
          credentials: () => store.list(),
          deepseekAccounts: loadDeepSeekAccounts,
          accountStates: () => accountStates(db),
          signIn: provider => loadSignIn(db, provider),
          webSites: WEB_CHAT_SITES,
          apiKeyProviders: API_KEY_PROVIDERS,
          autoEnabled: provider => loadProviderSetting(db, provider)?.auto ?? true,
        });
      } finally {
        db.close();
      }
    },
    checkSignIns: async url => {
      const sites = url ? [siteForUrl(url)].filter(site => site !== undefined) : WEB_CHAT_SITES;
      if (!sites.length) return [];
      const results = await checkSignIns(sites);
      const db = openDatabase();
      const status = new WebSignInStatus({ load: provider => loadSignIn(db, provider), save: record => saveSignIn(db, record) });
      for (const { site, result } of results) status.record(site.id, result.signedIn, result.signedIn ? undefined : notSignedIn(site, result));
      db.close();
      return results;
    },
    verifyApiKey: (provider, apiKey) => {
      const definition = apiKeyProvider(provider);
      if (!definition) throw new Error(`API keys are not supported for ${provider}`);
      return verifyProviderKey(definition, apiKey);
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
