import { describe, expect, test } from 'bun:test';

import { AnthropicStreamTranslator } from '../src/api/anthropic/stream.ts';

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

function parse(events: string[]) {
  return events.map(item => {
    const [head, data] = item.split('\ndata: ');
    return { name: head!.replace('event: ', ''), data: JSON.parse(data!) };
  });
}

function run(includeThinking: boolean, chunks: Array<Record<string, unknown>>) {
  const translator = new AnthropicStreamTranslator('msg_1', 'claude-sonnet-5', includeThinking);
  return parse([...translator.start(), ...chunks.flatMap(item => translator.push(item)), ...translator.finish()]);
}

describe('AnthropicStreamTranslator', () => {
  test('streams thinking then text deltas as separate blocks', () => {
    const events = run(true, [
      chunk({ role: 'assistant' }),
      chunk({ reasoning_content: 'Let me ' }),
      chunk({ reasoning_content: 'think.' }),
      chunk({ content: 'po' }),
      chunk({ content: 'ng' }),
      chunk({}, 'stop'),
    ]);
    expect(events.map(item => item.name)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    expect(events[1]!.data.content_block).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(events[2]!.data.delta).toEqual({ type: 'thinking_delta', thinking: 'Let me ' });
    expect(events[5]!.data).toMatchObject({ index: 1, content_block: { type: 'text', text: '' } });
    expect(events[7]!.data.delta).toEqual({ type: 'text_delta', text: 'ng' });
    expect(events[9]!.data.delta.stop_reason).toBe('end_turn');
  });

  test('drops reasoning when thinking was not requested', () => {
    const events = run(false, [chunk({ reasoning_content: 'hidden' }), chunk({ content: 'ok' }), chunk({}, 'stop')]);
    expect(events.filter(item => item.name === 'content_block_start').map(item => item.data.content_block.type)).toEqual(['text']);
    expect(JSON.stringify(events)).not.toContain('hidden');
  });

  test('turns tool calls into tool_use blocks with the tool_use stop reason', () => {
    const events = run(false, [
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }),
      chunk({}, 'tool_calls'),
    ]);
    const start = events.find(item => item.name === 'content_block_start')!;
    expect(start.data.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'read', input: {} });
    expect(events.find(item => item.data.delta?.type === 'input_json_delta')!.data.delta.partial_json).toBe('{"path":"a"}');
    expect(events.find(item => item.name === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  test('reports upstream errors as an Anthropic error event and stops', () => {
    const translator = new AnthropicStreamTranslator('msg_1', 'm', false);
    translator.start();
    translator.push(chunk({ content: 'partial' }));
    const events = parse(translator.push({ error: { message: 'limit hit', type: 'rate_limit_exceeded' } }));
    expect(events.map(item => item.name)).toEqual(['content_block_stop', 'error']);
    expect(events[1]!.data).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'limit hit' } });
    expect(translator.finish()).toEqual([]);
  });
});
