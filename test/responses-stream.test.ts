import { describe, expect, test } from 'bun:test';

import { flattenResponsesTools } from '../src/gateway/responses.ts';
import { ResponsesStreamTranslator } from '../src/gateway/responses-stream.ts';

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

function parse(events: string[]) {
  return events.map(item => JSON.parse(item.split('\ndata: ')[1]!));
}

function run(chunks: Array<Record<string, unknown>>, includeReasoning = false, routes = new Map()) {
  const translator = new ResponsesStreamTranslator('resp_abc', 'auto', routes, includeReasoning);
  return parse([...translator.start(), ...chunks.flatMap(item => translator.push(item)), ...translator.finish()]);
}

describe('ResponsesStreamTranslator', () => {
  test('streams text deltas with typed events and sequence numbers', () => {
    const events = run([chunk({ role: 'assistant' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop')]);
    expect(events.map(item => item.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map(item => item.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter(item => item.type === 'response.output_text.delta').map(item => item.delta)).toEqual(['Hel', 'lo']);
    const completed = events.at(-1)!.response;
    expect(completed.status).toBe('completed');
    expect(completed.output).toEqual([
      { type: 'message', id: 'msg_abc_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] },
    ]);
  });

  test('emits reasoning summaries only when requested', () => {
    const chunks = [chunk({ reasoning_content: 'think ' }), chunk({ reasoning_content: 'more' }), chunk({ content: 'ok' }), chunk({}, 'stop')];
    expect(run(chunks).some(item => item.type.startsWith('response.reasoning'))).toBeFalse();

    const events = run(chunks, true);
    expect(events.filter(item => item.type === 'response.reasoning_summary_text.delta').map(item => item.delta)).toEqual(['think ', 'more']);
    expect(events.at(-1)!.response.output[0]).toEqual({ type: 'reasoning', id: 'rs_abc_0', summary: [{ type: 'summary_text', text: 'think more' }] });
    expect(events.at(-1)!.response.output[1].content[0].text).toBe('ok');
  });

  test('emits function calls and restores namespaced tools', () => {
    const { routes } = flattenResponsesTools([
      { type: 'namespace', name: 'fs', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    ]);
    const flatName = [...routes.keys()][0]!;
    const events = run([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: flatName, arguments: '{"path":"a"}' } }] }),
      chunk({}, 'tool_calls'),
    ], false, routes);
    expect(events.find(item => item.type === 'response.function_call_arguments.delta')!.delta).toBe('{"path":"a"}');
    expect(events.at(-1)!.response.output[0]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read', namespace: 'fs', arguments: '{"path":"a"}' });
  });

  test('fails the response on upstream errors and stops', () => {
    const translator = new ResponsesStreamTranslator('resp_abc', 'auto', new Map(), false);
    translator.start();
    translator.push(chunk({ content: 'partial' }));
    const events = parse(translator.push({ error: { message: 'limit hit', type: 'rate_limit_exceeded' } }));
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'limit hit' } } });
    expect(translator.finish()).toEqual([]);
  });
});
