import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProfile, deleteProfile, listProfiles, profileDir } from '../src/browser/profiles.ts';
import { ProfileRotation } from '../src/core/accounts/profile-rotation.ts';
import { ProviderError } from '../src/core/providers/errors.ts';
import type { BrowserProfileRow } from '../src/core/store/database.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { createBrowserChatProvider } from '../src/providers/browser-chat-provider.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';

function memoryStore() {
  const rows: BrowserProfileRow[] = [];
  return {
    rows,
    list: () => [...rows],
    add: (row: BrowserProfileRow) => { rows.push(row); },
    remove: (id: string) => {
      const index = rows.findIndex(row => row.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

describe('browser accounts', () => {
  test('keeps the existing profile as the main account and creates new ones in their own folders', () => {
    const env = { SESSION_DIR: mkdtempSync(join(tmpdir(), 'accounts-')) };
    const store = memoryStore();
    expect(listProfiles(store)).toEqual([{ id: 'default', label: 'Main' }]);
    expect(profileDir('default', env)).toBe(join(env.SESSION_DIR, 'browser-profile'));
    const work = createProfile(store, '  Work  ', { env, now: () => 5, random: () => 'a1b2c3' });
    expect(work).toEqual({ id: 'acct-a1b2c3', label: 'Work' });
    expect(existsSync(join(env.SESSION_DIR, 'profiles', 'acct-a1b2c3'))).toBeTrue();
    expect(listProfiles(store).map(profile => profile.label)).toEqual(['Main', 'Work']);
    expect(deleteProfile(store, 'acct-a1b2c3', env)).toBeTrue();
    expect(existsSync(join(env.SESSION_DIR, 'profiles', 'acct-a1b2c3'))).toBeFalse();
  });

  test('refuses unsafe ids, empty names and removing the main account', () => {
    const store = memoryStore();
    expect(() => profileDir('../../etc')).toThrow('Unknown account');
    expect(() => createProfile(store, '   ')).toThrow('Enter a name');
    expect(() => createProfile(store, 'x'.repeat(41))).toThrow('40 characters');
    expect(() => deleteProfile(store, 'default')).toThrow('main account');
  });

  test('rotates between signed-in accounts, then tries unchecked ones and rests failed ones', () => {
    let now = 0;
    const states: Record<string, 'signed-in' | 'unknown'> = { a: 'signed-in', b: 'signed-in', c: 'unknown' };
    const rotation = new ProfileRotation(() => ['a', 'b', 'c'], {
      usable: (_provider, profiles) => ({
        signedIn: profiles.filter(profile => states[profile] === 'signed-in'),
        unknown: profiles.filter(profile => states[profile] === 'unknown'),
      }),
    }, () => now);
    expect(rotation.order('glm-chat')).toEqual(['a', 'b', 'c']);
    expect(rotation.order('glm-chat')).toEqual(['b', 'a', 'c']);
    expect(rotation.order('kimi-chat')).toEqual(['a', 'b', 'c']);
    rotation.failed('glm-chat', 'a');
    expect(rotation.order('glm-chat')).toEqual(['b', 'c']);
    rotation.failed('glm-chat', 'b');
    rotation.failed('glm-chat', 'c');
    expect(rotation.order('glm-chat')).toHaveLength(3);
    now = 5 * 60_000;
    rotation.succeeded('glm-chat', 'a');
    expect(rotation.order('glm-chat')).toContain('a');
  });

  test('falls through to the next account before the first chunk and reports each result', async () => {
    const results: Array<[string, boolean]> = [];
    const answer = async function* () { yield new TextEncoder().encode('data: {"type":"chat:completion","data":{"delta_content":"pong","phase":"answer"}}\n\n'); };
    const provider = createBrowserChatProvider({
      id: 'glm-chat',
      ownedBy: 'z-ai-web',
      model: 'glm-chat',
      site: ZAI_CHAT_SITE,
      parse: async function* (bytes) {
        for await (const chunk of bytes) {
          if (new TextDecoder().decode(chunk).includes('pong')) yield { type: 'content' as const, text: 'pong' };
        }
      },
      sessions: () => [
        { profile: 'a', session: { send: async () => { throw new ProviderError('chat.z.ai: not signed in', 'auth'); } } },
        { profile: 'b', session: { send: async () => answer() } },
      ],
      onResult: (profile, ok) => results.push([profile, ok]),
    });
    const { chunks } = await provider.stream({ model: 'glm-chat', messages: [{ role: 'user', content: 'hi' }] });
    expect((await collectChunks(chunks)).content).toBe('pong');
    expect(results).toEqual([['a', false], ['b', true]]);
  });

  test('explains when no account can be used', async () => {
    const provider = createBrowserChatProvider({
      id: 'kimi-chat', ownedBy: 'kimi-web', model: 'kimi-chat', site: ZAI_CHAT_SITE,
      parse: async function* () {},
      sessions: () => [],
    });
    await expect(provider.stream({ model: 'kimi-chat', messages: [] })).rejects.toThrow('no account is signed in');
    const failing = createBrowserChatProvider({
      id: 'kimi-chat', ownedBy: 'kimi-web', model: 'kimi-chat', site: ZAI_CHAT_SITE,
      parse: async function* () {},
      sessions: () => ['a', 'b'].map(profile => ({ profile, session: { send: async () => { throw new Error(`${profile} broke`); } } })),
    });
    await expect(failing.stream({ model: 'kimi-chat', messages: [] })).rejects.toThrow('kimi-chat failed on every account: a: a broke; b: b broke');
  });
});
