import type { ChatSite } from '../../browser/browser-chat.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';
import { bytesToLines } from '../browser-chat-provider.ts';

export const QWEN_CHAT_URL = 'https://chat.qwen.ai/';

export const QWEN_CHAT_SITE: ChatSite = {
  id: 'qwen-chat',
  url: QWEN_CHAT_URL,
  inputSelector: 'textarea',
  responseUrl: /\/api\/v2\/chat\/completions/,
  signIn: { storageKey: 'token', claim: 'id' },
  challengeResponse: /FAIL_SYS_USER_VALIDATE|\/punish\?/,
  ignoredResponse: /^\{"code":0,[^\n]*"sig":"from bx"/,
};

const VERIFICATION = /FAIL_SYS_USER_VALIDATE|action=captcha|\/punish\?/;

export function parseQwenEvent(line: string): ChatChunk | 'done' | null {
  if (VERIFICATION.test(line)) {
    throw new ProviderError(`Qwen asks for a security verification; complete it in the browser window or run: bun run account open ${QWEN_CHAT_URL}`, 'unavailable');
  }
  const data = line.startsWith('data:') ? line.slice(5).trim() : line;
  let event: any;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event?.error) {
    const message = typeof event.error === 'string' ? event.error : event.error.message ?? JSON.stringify(event.error);
    throw new ProviderError(`Qwen chat failed: ${String(message).slice(0, 300)}`, 'upstream');
  }
  const delta = event?.choices?.[0]?.delta;
  if (!delta) return null;
  const text = typeof delta.content === 'string' ? delta.content : '';
  if (text) return delta.phase === 'think' || delta.phase === 'thinking_summary' ? { type: 'reasoning', text } : { type: 'content', text };
  if (delta.status === 'finished' && delta.phase === 'answer') return 'done';
  return null;
}

export async function* parseQwenStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk> {
  for await (const line of bytesToLines(bytes)) {
    const parsed = parseQwenEvent(line);
    if (parsed === 'done') return;
    if (parsed) yield parsed;
  }
}
