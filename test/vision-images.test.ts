import { describe, expect, test } from 'bun:test';

import { collectImageUrls, messagesToPrompt, stripImages } from '../src/core/providers/prompt.ts';
import { createBrowserChatProvider } from '../src/providers/browser-chat-provider.ts';
import type { ChatSite } from '../src/browser/browser-chat.ts';
import type { ChatChunk } from '../src/core/providers/provider.ts';

const DATA_URL = 'data:image/png;base64,QUJD';

function imageMessage() {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'look at this chart' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ],
  }];
}

describe('image handling in prompts', () => {
  test('collectImageUrls picks image_url and anthropic image parts', () => {
    expect(collectImageUrls(imageMessage())).toEqual([DATA_URL]);
    expect(collectImageUrls([{ role: 'user', content: 'plain' }])).toEqual([]);
    expect(collectImageUrls([{
      role: 'user',
      content: [
        { type: 'text', text: 'x' },
        { type: 'image_url', image_url: 'https://example.com/a.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } },
      ],
    }])).toEqual(['https://example.com/a.png', 'data:image/jpeg;base64,QUJD', 'https://example.com/b.png']);
  });

  test('stripImages replaces image parts with a marker for supported sites', () => {
    const stripped = stripImages(imageMessage(), true);
    expect(stripped[0]!.content).toBe('look at this chart\n[image]');
    expect(JSON.stringify(stripped)).not.toContain('base64');
  });

  test('stripImages marks omitted images when the site cannot process them', () => {
    const stripped = stripImages(imageMessage(), false);
    expect(stripped[0]!.content).toBe('look at this chart\n[image omitted: this model cannot process images]');
    expect(JSON.stringify(stripped)).not.toContain('base64');
  });

  test('stripImages leaves messages without images untouched', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    expect(stripImages(messages, false)).toEqual(messages);
    expect(messagesToPrompt(stripImages(messages, false))).toBe('user: hello');
  });
});

describe('browser chat provider vision wiring', () => {
  const parse = async function* (bytes: AsyncIterable<Uint8Array>): AsyncIterable<ChatChunk> {
    let text = '';
    for await (const byte of bytes) text += new TextDecoder().decode(byte);
    yield { type: 'content', text };
  };

  function harness(site: ChatSite) {
    const calls: Array<{ prompt: string; context: Record<string, any> }> = [];
    const provider = createBrowserChatProvider({
      id: 'fake-chat',
      ownedBy: 'fake',
      model: 'fake-chat',
      site,
      sessions: () => [{
        profile: 'default',
        session: {
          send: async (_site, prompt, _model, context) => {
            calls.push({ prompt, context: context as Record<string, any> });
            return (async function* () { yield new TextEncoder().encode('ok'); })();
          },
        },
      }],
      parse,
    });
    return { calls, provider };
  }

  const visionSite: ChatSite = { id: 'vision', url: 'https://vision.test/', inputSelector: 'textarea', responseUrl: /\/chat/, images: true };
  const textSite: ChatSite = { id: 'text', url: 'https://text.test/', inputSelector: 'textarea', responseUrl: /\/chat/ };

  test('strips images from the prompt and hands urls to the session', async () => {
    const { calls, provider } = harness(visionSite);
    expect(provider.capabilities('fake-chat').vision).toBeTrue();
    await provider.stream({ model: 'fake-chat', messages: imageMessage() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe('user: look at this chart\n[image]');
    expect(calls[0]!.context.extractImages(imageMessage())).toEqual([DATA_URL]);
    expect(calls[0]!.context.toPrompt(imageMessage())).toBe('user: look at this chart\n[image]');
  });

  test('drops images with a marker when the site has no image support', async () => {
    const { calls, provider } = harness(textSite);
    expect(provider.capabilities('fake-chat').vision).toBeFalse();
    await provider.stream({ model: 'fake-chat', messages: imageMessage() });
    expect(calls[0]!.prompt).toBe('user: look at this chart\n[image omitted: this model cannot process images]');
    expect(calls[0]!.context.extractImages(imageMessage())).toEqual([]);
  });
});
