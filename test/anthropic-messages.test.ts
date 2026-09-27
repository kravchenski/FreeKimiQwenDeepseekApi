import { describe, expect, test } from 'bun:test';

import {
  anthropicError,
  anthropicToChatRequest,
  chatToAnthropicMessage,
  estimateInputTokens,
} from '../src/api/anthropic/messages.ts';

describe('anthropicToChatRequest', () => {
  test('converts system, text, images, tool use and tool results', () => {
    const request = anthropicToChatRequest({
      model: 'glm-5.2-free',
      max_tokens: 512,
      system: [{ type: 'text', text: 'Be brief.' }],
      tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file body' }] }, { type: 'text', text: 'Now?' }] },
      ],
    });

    expect(request).toEqual({
      model: 'glm-5.2-free',
      max_tokens: 512,
      stream: false,
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
        { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
        { role: 'tool', tool_call_id: 'tu_1', content: 'file body' },
        { role: 'user', content: 'Now?' },
      ],
    });
  });

  test('routes claude model names to auto', () => {
    expect(anthropicToChatRequest({ model: 'claude-sonnet-5', messages: [] }).model).toBe('auto');
    expect(anthropicToChatRequest({ messages: [] }).model).toBe('auto');
  });
});

describe('chatToAnthropicMessage', () => {
  test('maps text and tool calls with the right stop reason', () => {
    const message = chatToAnthropicMessage({
      id: 'chatcmpl-abc',
      choices: [{ message: { content: 'Sure', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{"path":"a"}' } }] } }],
    }, 'claude-sonnet-5');
    expect(message).toMatchObject({
      id: 'msg_abc',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Sure' }, { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }],
    });
    expect(chatToAnthropicMessage({ choices: [{ message: { content: 'hi' } }] }, 'm').stop_reason).toBe('end_turn');
  });

  test('includes reasoning as a thinking block only when requested', () => {
    const chat = { choices: [{ message: { content: 'pong', reasoning_content: 'thinking hard' } }] };
    expect(chatToAnthropicMessage(chat, 'm').content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(chatToAnthropicMessage(chat, 'm', true).content).toEqual([
      { type: 'thinking', thinking: 'thinking hard', signature: '' },
      { type: 'text', text: 'pong' },
    ]);
  });

  test('keeps malformed tool arguments instead of throwing', () => {
    const message = chatToAnthropicMessage({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{bad' } }] } }] }, 'm');
    expect(message.content[0]).toMatchObject({ input: { raw: '{bad' } });
  });
});

describe('helpers', () => {
  test('formats errors and estimates tokens', () => {
    expect(anthropicError(429, 'slow')).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } });
    expect(anthropicError(502, 'boom').error.type).toBe('api_error');
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).toBeGreaterThan(100);
  });
});
