#!/usr/bin/env bun

import { runAccountsCommand, type ProfileSignIn } from '../src/cli/accounts.ts';
import { openCredentialStore } from '../src/core/accounts/credential-store.ts';
import { API_KEY_PROVIDERS, apiKeyProvider, verifyProviderKey } from '../src/providers/catalog.ts';
import { askHidden } from '../src/utils/hiddenPrompt.ts';
import { listGoogleAccounts, openGoogleSignIn, openProfileWindow } from '../src/browser/google-profile.ts';
import { checkSignIns } from '../src/browser/sign-in-check.ts';
import { notSignedIn } from '../src/browser/browser-chat.ts';
import { WebSignInStatus } from '../src/core/accounts/sign-in-status.ts';
import type { Database } from 'bun:sqlite';
import {
  addBrowserProfile, listBrowserProfiles, loadGatewaySetting, loadProviderSetting, loadSignIn, loadSignIns, openDatabase, removeBrowserProfile,
  saveGatewaySetting, saveProviderSetting, saveSignIn, type BrowserProfileRow,
} from '../src/core/store/database.ts';
import { createProfile, deleteProfile, listProfiles, profileDir } from '../src/browser/profiles.ts';
import { ProviderSettings } from '../src/core/providers/settings.ts';
import { GatewaySettings } from '../src/core/settings/gateway-settings.ts';
import { siteForUrl, WEB_CHAT_SITES } from '../src/providers/web-chat-sites.ts';
import { buildOverview } from '../src/cli/overview.ts';
import { INIT_MESSAGES, initAccountsSecret } from '../src/cli/accounts-secret.ts';
import { loadAccountsSecret, systemKeyring } from '../src/core/secrets/accounts-secret.ts';
import { accountStates } from '../src/core/status.ts';
import { loadDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';

function withDb<T>(run: (db: Database) => T) {
  const db = openDatabase();
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function profileStore(db: Database) {
  return { list: () => listBrowserProfiles(db), add: (row: BrowserProfileRow) => addBrowserProfile(db, row), remove: (id: string) => removeBrowserProfile(db, id) };
}

const environmentSecret = process.env.ACCOUNTS_SECRET;
const secretSource = await loadAccountsSecret();
const store = openCredentialStore();

try {
  process.exitCode = await runAccountsCommand(process.argv.slice(2), {
    store,
    askHidden,
    log: line => console.log(line),
    openGoogleSignIn: profile => openGoogleSignIn(profileDir(profile)),
    listGoogleAccounts: profile => listGoogleAccounts(profileDir(profile)),
    openWindow: (urls, profile) => openProfileWindow(urls, profileDir(profile)),
    chatUrls: WEB_CHAT_SITES.map(site => site.url),
    profiles: {
      list: () => withDb(db => listProfiles(profileStore(db))),
      add: label => withDb(db => createProfile(profileStore(db), label)),
      remove: id => withDb(db => deleteProfile(profileStore(db), id)),
      summary: () => withDb(db => listProfiles(profileStore(db)).map(profile => ({
        ...profile,
        chats: WEB_CHAT_SITES.filter(site => site.signIn).map(site => {
          const record = loadSignIn(db, site.id, profile.id);
          return { id: site.id, signedIn: record?.signedIn ?? null, checkedAt: record?.checkedAt ?? null, reason: record?.reason ?? null };
        }),
      }))),
    },
    initSecret: async () => INIT_MESSAGES[await initAccountsSecret({ envFile: '.env', env: { ACCOUNTS_SECRET: environmentSecret }, keyring: systemKeyring })],
    secretSource: async () => secretSource,
    autoSettings: change => withDb(db => {
      const settings = new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: (key, value) => saveGatewaySetting(db, key, value) });
      if (change.focus !== undefined) settings.setAutoFocus(change.focus);
      if (change.mode !== undefined) settings.setAutoMode(change.mode);
      return { focus: settings.autoFocus(), mode: settings.autoMode() };
    }),
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
          accountSignIns: provider => loadSignIns(db, provider),
          webSites: WEB_CHAT_SITES,
          apiKeyProviders: API_KEY_PROVIDERS,
          autoEnabled: provider => loadProviderSetting(db, provider)?.auto ?? true,
        });
      } finally {
        db.close();
      }
    },
    checkSignIns: async (url, profile) => {
      const sites = url ? [siteForUrl(url)].filter(site => site !== undefined) : WEB_CHAT_SITES;
      if (!sites.length) return [];
      const accounts = withDb(db => listProfiles(profileStore(db))).filter(entry => !profile || entry.id === profile);
      const results: ProfileSignIn[] = [];
      for (const account of accounts) {
        for (const entry of await checkSignIns(sites, undefined, profileDir(account.id))) results.push({ ...entry, profile: account });
      }
      withDb(db => {
        const status = new WebSignInStatus({ load: (provider, id) => loadSignIn(db, provider, id), save: record => saveSignIn(db, record) });
        for (const { site, result, profile: account } of results) {
          status.record(site.id, result.signedIn, result.signedIn ? undefined : notSignedIn(site, result), account?.id);
        }
      });
      return results;
    },
    verifyApiKey: (provider, apiKey) => {
      const definition = apiKeyProvider(provider);
      if (!definition) throw new Error(`API keys are not supported for ${provider}`);
      return verifyProviderKey(definition, apiKey);
    },
    accountLabel: provider => apiKeyProvider(provider)?.account?.label,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
