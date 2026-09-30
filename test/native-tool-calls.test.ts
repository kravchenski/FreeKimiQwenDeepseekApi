import { describe, expect, test } from 'bun:test';

import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';
import { parseToolCallJson } from '../src/core/tools/tool-calls.ts';
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

describe('text tool calls from web chats', () => {
  const bash = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
  const commands = (text: string) => (parseToolCallJson(text, bash) ?? []).map(call => JSON.parse(call.function.arguments).command);

  test('reads DeepSeek DSML tool calls', () => {
    const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="arguments" string="true">{"command":"bun test 2>&1 | tail -8"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    expect(commands(dsml)).toEqual(['bun test 2>&1 | tail -8']);
    const named = '<|DSML|invoke name="bash"><|DSML|parameter name="command" string="true">ls -la</|DSML|parameter></|DSML|invoke>';
    expect(commands(named)).toEqual(['ls -la']);
  });

  test('repairs a command string that was never closed', () => {
    expect(commands('{"tool_calls":[{"name":"bash","arguments":{"command":"cd bench && ls && bun test 2>&1 | tail -40}}]}')).toEqual(['cd bench && ls && bun test 2>&1 | tail -40']);
  });

  test('repairs an extra brace after string arguments in several calls', () => {
    const text = '{"tool_calls":[{"name":"bash","arguments":"{\\"command\\":\\"git log -3\\"}"}},{"name":"bash","arguments":"{\\"command\\":\\"bun test\\"}"}}]}';
    expect(commands(text)).toEqual(['git log -3', 'bun test']);
  });
});

describe('auto for agent requests', () => {
  const provider = (id: string, nativeTools: boolean): Provider => ({
    id,
    ownedBy: id,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    stream: async request => ({ chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() }),
  });

  test('tries models with native tool calling before web chats, and keeps the order for plain chat', async () => {
    const registry = new ProviderRegistry().register(provider('web', false)).register(provider('api', true));
    const router = new SmartRouter(registry, ['web-model', 'api-model']);
    const build = (route: { model: string }) => ({ model: route.model, messages: [] });
    expect((await router.open('auto', build, undefined, undefined, { nativeToolsFirst: true })).route.model).toBe('api-model');
    expect((await router.open('auto', build)).route.model).toBe('web-model');
    expect((await router.open('web-model', build, undefined, undefined, { nativeToolsFirst: true })).route.model).toBe('web-model');
  });

  test('puts strong models ahead of small ones for agent requests', async () => {
    const registry = new ProviderRegistry().register(provider('tiny-mini', true)).register(provider('qwen3-coder', true));
    const router = new SmartRouter(registry, ['tiny-mini-model', 'qwen3-coder-model']);
    const build = (route: { model: string }) => ({ model: route.model, messages: [] });
    expect((await router.open('auto', build, undefined, undefined, { nativeToolsFirst: true })).route.model).toBe('qwen3-coder-model');
  });
});
