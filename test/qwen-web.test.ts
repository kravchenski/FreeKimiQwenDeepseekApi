import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { parseQwenEvent, parseQwenStream } from '../src/providers/qwen/web.ts';

const event = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}`;

async function* bytes(lines: string[]) {
  const encoder = new TextEncoder();
  for (const line of lines) yield encoder.encode(`${line}\n\n`);
}

describe('Qwen web chat stream', () => {
  test('splits thinking and answer phases and stops when the answer finishes', async () => {
    const result = await collectChunks(parseQwenStream(bytes([
      'data: {"response.created":{"chat_id":"c","response_id":"r"}}',
      event({ role: 'assistant', content: 'hmm', phase: 'think', status: 'typing' }),
      event({ role: 'assistant', content: 'po', phase: 'answer', status: 'typing' }),
      event({ role: 'assistant', content: 'ng', phase: 'answer', status: 'typing' }),
      event({ role: 'assistant', content: '', phase: 'answer', status: 'finished' }),
      event({ role: 'assistant', content: 'ignored', phase: 'answer' }),
    ])));
    expect(result).toEqual({ content: 'pong', reasoning: 'hmm' });
  });

  test('ignores keep-alives and malformed lines', () => {
    expect(parseQwenEvent(': ping')).toBeNull();
    expect(parseQwenEvent('data: {broken')).toBeNull();
    expect(parseQwenEvent(event({ content: '', phase: 'think', status: 'finished' }))).toBeNull();
  });

  test('reports the Alibaba verification page as an actionable error', () => {
    const punish = '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::busy"],"data":{"url":"https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=x&action=captcha"}}';
    expect(() => parseQwenEvent(punish)).toThrow(ProviderError);
    expect(() => parseQwenEvent(punish)).toThrow('bun run account open https://chat.qwen.ai/');
  });

  test('surfaces upstream error events', () => {
    expect(() => parseQwenEvent('data: {"error":{"message":"The chat is in progress"}}')).toThrow('Qwen chat failed: The chat is in progress');
  });
});
