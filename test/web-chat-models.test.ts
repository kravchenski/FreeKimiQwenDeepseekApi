import { describe, expect, test } from 'bun:test';

import type { ChatSite } from '../src/browser/browser-chat.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { loadWebChatModels, openDatabase, saveWebChatModels } from '../src/core/store/database.ts';
import { parseArenaModels } from '../src/providers/arena/web.ts';
import { createBrowserChatProvider } from '../src/providers/browser-chat-provider.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';
import { endStreamError, KIMI_CHAT_SITE, parseKimiModels } from '../src/providers/kimi/web.ts';
import { parseOpenWebUiModels } from '../src/providers/qwen/web.ts';

const site: ChatSite = { id: 'fake-chat', url: 'https://fake', inputSelector: 'textarea', responseUrl: /x/, defaultModels: [{ id: 'fallback-id', name: 'Fallback' }] };

function provider(listed?: Array<{ id: string; name: string }>) {
  const sent: Array<string | undefined> = [];
  const chat = createBrowserChatProvider({
    id: 'fake-chat',
    ownedBy: 'fake-web',
    model: 'fake-chat',
    site,
    parse: async function* () { yield { type: 'content', text: 'ok' }; },
    sessions: () => [{ profile: 'default', session: { send: async (_site, _prompt, model) => { sent.push(model); return (async function* () {})(); } } }],
    models: () => listed,
  });
  return { chat, sent };
}

describe('web chat models', () => {
  test('lists the site models under the chat id and sends the upstream id', async () => {
    const { chat, sent } = provider([{ id: 'x-preview-l', name: 'GLM-5.3-Flash' }, { id: 'glm-5.3', name: 'GLM-5.3' }]);
    expect(await chat.listModels()).toEqual(['fake-chat', 'fake-chat/glm-5.3-flash', 'fake-chat/glm-5.3']);
    expect(chat.supports('fake-chat/glm-5.3')).toBeTrue();
    expect(chat.supports('other-chat/glm-5.3')).toBeFalse();
    await collectChunks((await chat.stream({ model: 'fake-chat/glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] })).chunks);
    await collectChunks((await chat.stream({ model: 'fake-chat', messages: [{ role: 'user', content: 'hi' }] })).chunks);
    expect(sent).toEqual(['x-preview-l', undefined]);
  });

  test('falls back to the default models until the site was read', async () => {
    expect(await provider().chat.listModels()).toEqual(['fake-chat', 'fake-chat/fallback']);
  });

  test('reads the model lists of every site', () => {
    expect(parseOpenWebUiModels({ data: [{ id: 'qwen3.8-max', name: 'Qwen3.8-Max' }, { id: 'old', name: 'Old', info: { is_active: false } }, { id: 'glm-4-flash', name: '任务专用' }] }))
      .toEqual([{ id: 'qwen3.8-max', name: 'Qwen3.8-Max' }]);
    expect(parseKimiModels({ availableModels: [{ id: 'k3-agent', displayName: 'K3', scenario: 'SCENARIO_OK_COMPUTER' }, { id: 'k2d6-chat', displayName: 'Instant', scenario: 'SCENARIO_CHAT' }, { id: 'x', scenario: 'SCENARIO_SLIDES' }] }))
      .toEqual([{ id: 'k3-agent', name: 'K3' }, { id: 'k2d6-chat', name: 'Instant' }]);
    const text = { inputCapabilities: { text: true }, outputCapabilities: { text: true } };
    expect(parseArenaModels(JSON.stringify([
      { id: 'u1', publicName: 'claude-sonnet-4-6', capabilities: text },
      { id: 'u2', publicName: 'claude-sonnet-4-6', capabilities: text },
      { id: 'u3', publicName: 'image-only', capabilities: { inputCapabilities: { text: true }, outputCapabilities: { image: {} } } },
      { id: 'u4', publicName: 'hidden', userSelectable: false, capabilities: text },
    ]))).toEqual([{ id: 'u1', name: 'claude-sonnet-4-6' }]);
    expect(parseArenaModels('not json')).toEqual([]);
  });

  test('puts the model where each site expects it', () => {
    expect(ZAI_CHAT_SITE.modelFields!('glm-5.3')).toEqual({ model: 'glm-5.3' });
    expect(KIMI_CHAT_SITE.modelFields!('k2d6-chat')).toEqual({ 'options.model': 'k2d6-chat' });
    expect(KIMI_CHAT_SITE.modelFields!('k3-agent')).toMatchObject({ 'options.model': 'k3-agent', scenario: 'SCENARIO_OK_COMPUTER' });
  });

  test('reports Kimi errors sent at the end of the stream', () => {
    expect(endStreamError('{"error":{"code":"resource_exhausted","debug":{"reason":"REASON_SERVER_OVERLOADED_FOR_FREE_USER"}}}')?.kind).toBe('rate_limit');
    expect(endStreamError('{}')).toBeUndefined();
  });

  test('keeps discovered models in the database', () => {
    const db = openDatabase(':memory:');
    saveWebChatModels(db, 'glm-chat', [{ id: 'glm-5.3', name: 'GLM-5.3' }]);
    saveWebChatModels(db, 'glm-chat', [{ id: 'glm-5.4', name: 'GLM-5.4' }]);
    expect(loadWebChatModels(db).get('glm-chat')).toEqual([{ id: 'glm-5.4', name: 'GLM-5.4' }]);
  });
});
