import type { ChatSite } from '../../browser/browser-chat.ts';
import { readOpenWebUiModels } from '../qwen/web.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';
import { bytesToLines } from '../browser-chat-provider.ts';

export const ZAI_CHAT_SITE: ChatSite = {
  id: 'glm-chat',
  url: 'https://chat.z.ai/',
  inputSelector: 'textarea',
  responseUrl: /\/api\/v2\/chat\/completions/,
  verificationText: /security verification/i,
  signIn: { storageKey: 'token', claim: 'email', guestPattern: /guest/i },
  modelFields: model => ({ model }),
  pageModels: page => readOpenWebUiModels(page).then(models => models.filter(model => !/research|rumination|-DR$/i.test(`${model.id} ${model.name}`))),
  defaultModels: [
    { id: 'x-preview-l', name: 'GLM-5.3-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo' },
    { id: 'glm-4.7', name: 'GLM-4.7' },
  ],
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
