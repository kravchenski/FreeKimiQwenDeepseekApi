import type { ChatSite } from '../../browser/browser-chat.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';
import { bytesToLines } from '../browser-chat-provider.ts';

export const ARENA_CHAT_URL = 'https://arena.ai/text/direct';

export const ARENA_CHAT_SITE: ChatSite = {
  id: 'arena-chat',
  url: ARENA_CHAT_URL,
  inputSelector: 'textarea[name="message"]',
  responseUrl: /\/nextjs-api\/stream\/(?:create|post-to)-evaluation/,
  verificationText: /verify you are human|security verification/i,
};

function decode(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function failure(value: unknown) {
  const message = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message)
    : JSON.stringify(value);
  const text = String(message).slice(0, 300);
  if (/recaptcha|captcha|verif/i.test(text)) {
    return new ProviderError(`Arena asks for a verification; complete it in the browser window or run: bun run account open ${ARENA_CHAT_URL}`, 'unavailable');
  }
  if (/rate|limit|too many/i.test(text)) return new ProviderError(`Arena rate limit: ${text}`, 'rate_limit', 429);
  return new ProviderError(`Arena chat failed: ${text}`, 'upstream');
}

export function parseArenaEvent(line: string): ChatChunk | 'done' | null {
  const match = /^a([0-9a-z]):(.*)$/.exec(line.trim());
  if (!match) {
    const body = line.trim().startsWith('{') ? decode(line.trim()) : undefined;
    if (body?.error) throw failure(body.error);
    return null;
  }
  const [, kind, payload] = match;
  const value = decode(payload!);
  if (kind === '3') throw failure(value ?? payload);
  if (kind === 'd') return 'done';
  if (typeof value !== 'string' || !value) return null;
  if (kind === '0') return { type: 'content', text: value };
  if (kind === 'g') return { type: 'reasoning', text: value };
  return null;
}

export async function* parseArenaStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk> {
  for await (const line of bytesToLines(bytes)) {
    const parsed = parseArenaEvent(line);
    if (parsed === 'done') return;
    if (parsed) yield parsed;
  }
}
