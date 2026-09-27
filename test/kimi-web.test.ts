import { describe, expect, test } from 'bun:test';

import { collectChunks } from '../src/core/streaming/sse.ts';
import { connectFrames, parseKimiEvent, parseKimiStream } from '../src/providers/kimi/web.ts';

function frame(payload: unknown, flags = 0) {
  const body = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const out = new Uint8Array(5 + body.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

async function* split(parts: Uint8Array[], size: number) {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  for (let index = 0; index < all.length; index += size) yield all.slice(index, index + size);
}

const stream = [
  frame({ heartbeat: {} }),
  frame({ op: 'set', eventOffset: 1, chat: { id: 'c1', name: 'Untitled' } }),
  frame({ op: 'set', mask: 'block.multiStage', block: { id: '1', multiStage: { stages: [] } } }),
  frame({ op: 'set', mask: 'block.think', block: { id: '3', parentId: '2', think: { content: 'The user' } } }),
  frame({ op: 'append', mask: 'block.think.content', block: { id: '3', think: { content: ' wants pong.' } } }),
  frame({ op: 'set', mask: 'block.text', block: { id: '4', text: { content: 'p' } } }),
  frame({ op: 'append', mask: 'block.text.content', block: { id: '4', text: { content: 'ong ✓' } } }),
  frame({ op: 'set', mask: 'message.status', message: { id: 'm', status: 'MESSAGE_STATUS_COMPLETED' } }),
  frame({ eventOffset: 44, done: {} }),
  frame({ op: 'append', block: { text: { content: 'ignored' } } }),
  frame('{}', 2),
];

describe('Kimi web chat', () => {
  test('parses Connect frames split at arbitrary byte boundaries', async () => {
    for (const size of [1, 3, 64, 4096]) {
      expect(await collectChunks(parseKimiStream(split(stream, size)))).toEqual({ content: 'pong ✓', reasoning: 'The user wants pong.' });
    }
  });

  test('stops at the end-of-stream frame', async () => {
    const frames = [];
    for await (const item of connectFrames(split([frame({ heartbeat: {} }), frame('{}', 2)], 2))) frames.push(item.flags);
    expect(frames).toEqual([0, 2]);
    expect(await collectChunks(parseKimiStream(split([frame('{}', 2), frame({ op: 'set', block: { text: { content: 'late' } } })], 8)))).toEqual({ content: '', reasoning: '' });
  });

  test('ignores non-content events and malformed payloads', () => {
    expect(parseKimiEvent('{"heartbeat":{}}')).toBeNull();
    expect(parseKimiEvent('{"op":"set","chat":{"id":"c"}}')).toBeNull();
    expect(parseKimiEvent('not json')).toBeNull();
    expect(parseKimiEvent('{"done":{}}')).toBe('done');
  });
});
