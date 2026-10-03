import { describe, expect, test } from 'bun:test';

import { collectChunks } from '../src/core/streaming/sse.ts';
import { createBrowserChatProvider } from '../src/providers/browser-chat-provider.ts';
import { parseZaiEvent, parseZaiStream, ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';

const sample = [
  'data: {"type":"chat:completion","data":{"delta_content":"The user wants","phase":"thinking"}}',
  'data: {"type":"chat:completion","data":{"delta_content":" pong.","phase":"thinking"}}',
  'data: {"type":"chat:completion","data":{"phase":"other","usage":{"total_tokens":41}}}',
  'data: {"type":"chat:completion","data":{"delta_content":"po","phase":"answer"}}',
  'data: {"type":"chat:completion","data":{"delta_content":"ng","phase":"answer"}}',
  'data: {"type":"chat:completion","data":{"phase":"done","done":true}}',
  'data: {"type":"chat:completion","data":{"delta_content":"ignored","phase":"answer"}}',
].join('\n\n');

async function* bytes(text: string, size = 7) {
  const encoded = new TextEncoder().encode(text);
  for (let index = 0; index < encoded.length; index += size) yield encoded.slice(index, index + size);
}

describe('Z.ai web chat', () => {
  test('parses thinking, answer and done events across chunk boundaries', async () => {
    expect(await collectChunks(parseZaiStream(bytes(sample)))).toMatchObject({ content: 'pong', reasoning: 'The user wants pong.' });
  });

  test('ignores unrelated and malformed lines', () => {
    expect(parseZaiEvent(': ping')).toBeNull();
    expect(parseZaiEvent('data: {broken')).toBeNull();
    expect(parseZaiEvent('data: {"type":"other","data":{"delta_content":"x"}}')).toBeNull();
  });

  test('sends the folded conversation through the browser session', async () => {
    const sent: Array<[string, string]> = [];
    const provider = createBrowserChatProvider({
      id: 'glm-chat',
      ownedBy: 'z-ai-web',
      model: 'glm-chat',
      site: ZAI_CHAT_SITE,
      sessions: () => [{
        profile: 'default',
        session: {
          send: async (site, prompt) => {
            sent.push([site.id, prompt]);
            return bytes(sample);
          },
        },
      }],
      parse: parseZaiStream,
    });

    expect(provider.supports('glm-chat')).toBeTrue();
    expect(provider.supports('glm-5.3')).toBeFalse();
    const { chunks } = await provider.stream({ model: 'glm-chat', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Say pong' }] });
    expect((await collectChunks(chunks)).content).toBe('pong');
    expect(sent).toEqual([['glm-chat', 'system: Be brief\n\nuser: Say pong']]);
  });

  test('rejects a model the site does not offer once its model list is known', async () => {
    const sent: Array<string | undefined> = [];
    const provider = createBrowserChatProvider({
      id: 'glm-chat',
      ownedBy: 'z-ai-web',
      model: 'glm-chat',
      site: ZAI_CHAT_SITE,
      sessions: () => [{
        profile: 'default',
        session: {
          send: async (_site, _prompt, model) => {
            sent.push(model);
            return bytes(sample);
          },
        },
      }],
      parse: parseZaiStream,
      models: () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    });

    const { chunks } = await provider.stream({ model: 'glm-chat/glm-5.3', messages: [{ role: 'user', content: 'Say pong' }] });
    expect((await collectChunks(chunks)).content).toBe('pong');
    await expect(provider.stream({ model: 'glm-chat/no-such-model', messages: [{ role: 'user', content: 'Say pong' }] })).rejects.toMatchObject({ kind: 'model_unavailable' });
    expect(sent).toEqual(['glm-5.3']);
  });
});
