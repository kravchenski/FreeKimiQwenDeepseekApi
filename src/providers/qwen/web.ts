import type { Page } from 'playwright-core';

import type { ChatSite, WebChatModel } from '../../browser/browser-chat.ts';
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
  captcha: { slider: true },
  modelFields: model => ({ model, 'messages.*.models': [model] }),
  images: true,
  attachImages: async (page, files) => {
    const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /oss-accelerate/.test(response.url()) && response.ok(), { timeout: 60_000 }).catch(() => undefined);
    await page.locator('div.mode-select-open').first().click({ timeout: 15_000 });
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
    await page.getByText(/upload attachment/i).first().click({ timeout: 10_000 });
    (await chooser).setFiles(files);
    if (!(await uploaded)) await Bun.sleep(5_000);
    await Bun.sleep(12_000);
  },
  pageModels: page => readOpenWebUiModels(page),
  defaultModels: [
    { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus' },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'qwen3.7-max', name: 'Qwen3.7-Max' },
    { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash' },
    { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus' },
  ],
};

export function readOpenWebUiModels(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const response = await fetch('/api/models', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return response.ok ? response.json() : null;
  }).then(parseOpenWebUiModels);
}

export function parseOpenWebUiModels(body: unknown): WebChatModel[] {
  const data = (body as { data?: Array<{ id?: unknown; name?: unknown; info?: { is_active?: boolean } }> })?.data ?? [];
  return data
    .filter(model => typeof model.id === 'string' && model.info?.is_active !== false)
    .map(model => ({ id: model.id as string, name: typeof model.name === 'string' ? model.name : model.id as string }))
    .filter(model => /^[\x20-\x7e]+$/.test(model.name));
}

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
