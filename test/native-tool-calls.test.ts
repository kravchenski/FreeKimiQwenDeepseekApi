import { describe, expect, test } from 'bun:test';

import { collectChunks } from '../src/core/streaming/sse.ts';
import { apiKeyProvider, createApiProvider } from '../src/providers/catalog.ts';

const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];

function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}

describe('native tool calls', () => {
  test('sends the tools to an API provider and assembles streamed tool calls', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: string, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([
        { choices: [{ delta: { reasoning_content: 'List files.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '{"comm' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] } }] },
      ]);
    }) as unknown as typeof fetch;
    const provider = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'k' }, fetch: fetchFn });
    expect(provider.capabilities('groq/llama').nativeTools).toBeTrue();
    const result = await collectChunks((await provider.stream({ model: 'groq/llama', messages: [{ role: 'user', content: 'ls' }], tools })).chunks);
    expect(bodies[0]).toMatchObject({ model: 'llama', tools, tool_choice: 'auto' });
    expect(result.reasoning).toBe('List files.');
    expect(result.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      { id: 'call_b', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
    ]);
    await collectChunks((await provider.stream({ model: 'groq/llama', messages: [] })).chunks);
    expect(bodies[1].tools).toBeUndefined();
  });

  test('remembers a model that refuses tools and stops sending them to it', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return Response.json({ error: { message: 'tools are not supported for this model' } }, { status: 400 });
    }) as unknown as typeof fetch;
    const provider = createApiProvider(apiKeyProvider('groq')!, { env: { GROQ_API_KEY: 'k' }, fetch: fetchFn });
    await expect(provider.stream({ model: 'groq/old', messages: [], tools })).rejects.toThrow('tools are not supported');
    expect(provider.capabilities('groq/old').nativeTools).toBeFalse();
    expect(provider.capabilities('groq/other').nativeTools).toBeTrue();
    expect(calls).toBe(1);
  });
});
