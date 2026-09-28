import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_PROFILE } from '../core/accounts/sign-in-status.ts';
import type { BrowserProfileRow } from '../core/store/database.ts';
import { googleProfileDir } from './google-profile.ts';

export interface BrowserProfile {
  id: string;
  label: string;
}

export interface ProfileStore {
  list(): BrowserProfileRow[];
  add(profile: BrowserProfileRow): void;
  remove(id: string): boolean;
}

export const DEFAULT_PROFILE_LABEL = 'Main';
const PROFILE_ID = /^acct-[0-9a-f]{6}$/;

function profilesRoot(env: Record<string, string | undefined>) {
  return path.resolve(env.SESSION_DIR || 'session', 'profiles');
}

export function profileDir(id: string, env: Record<string, string | undefined> = process.env) {
  if (id === DEFAULT_PROFILE) return googleProfileDir(env);
  if (!PROFILE_ID.test(id)) throw new Error(`Unknown account: ${id}`);
  return path.join(profilesRoot(env), id);
}

export function listProfiles(store: Pick<ProfileStore, 'list'>): BrowserProfile[] {
  return [{ id: DEFAULT_PROFILE, label: DEFAULT_PROFILE_LABEL }, ...store.list().map(({ id, label }) => ({ id, label }))];
}

export function createProfile(
  store: ProfileStore,
  label: string,
  options: { env?: Record<string, string | undefined>; now?: () => number; random?: () => string } = {},
): BrowserProfile {
  const name = label.trim();
  if (!name) throw new Error('Enter a name for the account');
  if (name.length > 40) throw new Error('Account names are limited to 40 characters');
  const id = `acct-${(options.random ?? (() => crypto.randomBytes(3).toString('hex')))()}`;
  store.add({ id, label: name, createdAt: (options.now ?? Date.now)() });
  fs.mkdirSync(profileDir(id, options.env), { recursive: true, mode: 0o700 });
  return { id, label: name };
}

export function deleteProfile(store: ProfileStore, id: string, env: Record<string, string | undefined> = process.env) {
  if (id === DEFAULT_PROFILE) throw new Error('The main account cannot be removed');
  const dir = profileDir(id, env);
  const removed = store.remove(id);
  if (dir.startsWith(profilesRoot(env) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  return removed;
}
