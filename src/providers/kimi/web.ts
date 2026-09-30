import type { ChatSite, WebChatModel } from '../../browser/browser-chat.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';

export const KIMI_CHAT_SITE: ChatSite = {
  id: 'kimi-chat',
  url: 'https://www.kimi.ai/',
  inputSelector: '[contenteditable="true"], textarea',
  responseUrl: /kimi\.gateway\.chat\.v1\.ChatService\/Chat(?:\?|$)/,
  verificationText: /security verification|verify you are human|captcha/i,
  signIn: { storageKey: 'refresh_token', expiring: true },
  modelFields: model => /-chat$/.test(model)
    ? { 'options.model': model }
    : { 'options.model': model, scenario: 'SCENARIO_OK_COMPUTER', 'message.scenario': 'SCENARIO_OK_COMPUTER' },
  modelsResponse: /ConfigService\/GetAvailableModels/,
  parseModels: parseKimiModels,
  defaultModels: [{ id: 'k2d6-chat', name: 'Instant' }, { id: 'k3-agent', name: 'K3' }],
};

export function parseKimiModels(body: unknown): WebChatModel[] {
  const models = (body as { availableModels?: Array<{ id?: unknown; displayName?: unknown; scenario?: unknown }> })?.availableModels ?? [];
  return models
    .filter(model => typeof model.id === 'string' && (model.scenario === 'SCENARIO_CHAT' || model.scenario === 'SCENARIO_OK_COMPUTER'))
    .map(model => ({ id: model.id as string, name: typeof model.displayName === 'string' ? model.displayName : model.id as string }));
}

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

export function endStreamError(payload: string) {
  let body: { error?: { code?: string; message?: string; debug?: { reason?: string } } };
  try {
    body = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!body?.error) return undefined;
  const detail = [body.error.code, body.error.debug?.reason, body.error.message].filter(Boolean).join(': ');
  return new ProviderError(`Kimi chat failed: ${detail}`, body.error.code === 'resource_exhausted' ? 'rate_limit' : 'upstream', body.error.code === 'resource_exhausted' ? 429 : 502);
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
  let done = false;
  for await (const frame of connectFrames(bytes)) {
    if (frame.flags & END_STREAM_FLAG) {
      const failure = endStreamError(frame.payload);
      if (failure) throw failure;
      return;
    }
    const parsed = parseKimiEvent(frame.payload);
    if (parsed === 'done') {
      done = true;
      continue;
    }
    if (parsed && !done) yield parsed;
  }
}
