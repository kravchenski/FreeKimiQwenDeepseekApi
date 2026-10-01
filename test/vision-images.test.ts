import { describe, expect, test } from 'bun:test';

import { collectImageUrls, messagesToPrompt, stripImages } from '../src/core/providers/prompt.ts';

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
