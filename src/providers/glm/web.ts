import type { ChatSite } from '../../browser/browser-chat.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';
import { bytesToLines } from '../browser-chat-provider.ts';

export const ZAI_CHAT_SITE: ChatSite = {
  id: 'glm-chat',
  url: 'https://chat.z.ai/',
  inputSelector: 'textarea',
  responseUrl: /\/api\/v2\/chat\/completions/,
  verificationText: /security verification/i,
};

export function parseZaiEvent(line: string): ChatChunk | 'done' | null {
  if (!line.startsWith('data:')) return null;
  let event: any;
  try {
    event = JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
  const data = event?.data;
  if (event?.type !== 'chat:completion' || !data) return null;
  if (data.done || data.phase === 'done') return 'done';
  const text = typeof data.delta_content === 'string' ? data.delta_content : '';
  if (!text) return null;
  return data.phase === 'thinking' ? { type: 'reasoning', text } : { type: 'content', text };
}

export async function* parseZaiStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk> {
  for await (const line of bytesToLines(bytes)) {
    const parsed = parseZaiEvent(line);
    if (parsed === 'done') return;
    if (parsed) yield parsed;
  }
}
