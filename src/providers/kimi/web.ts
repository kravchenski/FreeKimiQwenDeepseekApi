import type { ChatSite } from '../../browser/browser-chat.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';

export const KIMI_CHAT_SITE: ChatSite = {
  id: 'kimi-chat',
  url: 'https://www.kimi.ai/',
  inputSelector: '[contenteditable="true"], textarea',
  responseUrl: /kimi\.gateway\.chat\.v1\.ChatService\/Chat(?:\?|$)/,
  verificationText: /security verification|verify you are human|captcha/i,
  signIn: { storageKey: 'refresh_token', expiring: true },
};

const HEADER_BYTES = 5;
const END_STREAM_FLAG = 0x02;

export async function* connectFrames(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<{ flags: number; payload: string }> {
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();
  for await (const chunk of bytes) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= HEADER_BYTES) {
      const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0);
      if (buffer.length < HEADER_BYTES + length) break;
      yield { flags: buffer[0]!, payload: decoder.decode(buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)) };
      buffer = buffer.subarray(HEADER_BYTES + length);
    }
  }
}

export function parseKimiEvent(payload: string): ChatChunk | 'done' | null {
  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return null;
  }
  if (event?.done) return 'done';
  const block = event?.block;
  if (!block || (event.op !== 'set' && event.op !== 'append')) return null;
  const think = block.think?.content;
  if (typeof think === 'string' && think) return { type: 'reasoning', text: think };
  const text = block.text?.content;
  if (typeof text === 'string' && text) return { type: 'content', text };
  return null;
}

export async function* parseKimiStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk> {
  for await (const frame of connectFrames(bytes)) {
    if (frame.flags & END_STREAM_FLAG) return;
    const parsed = parseKimiEvent(frame.payload);
    if (parsed === 'done') return;
    if (parsed) yield parsed;
  }
}
