import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'bun:test';

import type { ChatChunk, ChatRequest, Provider } from '../src/core/providers/provider.ts';
import { ProviderError } from '../src/core/providers/errors.ts';

type ServerModule = typeof import('../src/unified/server.ts');

let server: ServerModule;
const requests: ChatRequest[] = [];
const replies: ChatChunk[][] = [];

const fakeProvider: Provider = {
  id: 'fake',
  ownedBy: 'fake-owner',
  supports: model => model.startsWith('fake-'),
  listModels: async () => ['fake-model'],
  capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
  health: () => ({ available: true }),
  async stream(request) {
    requests.push(request);
    const chunks = replies.shift() ?? [];
    return {
      chunks: (async function* () {
        yield* chunks;
      })(),
      responseFields: { x_fake_id: 'abc' },
    };
  },
};

let key = '';
let lateModels: string[] = [];

const lateProvider: Provider = {
  id: 'late',
  ownedBy: 'late-owner',
  supports: model => lateModels.includes(model),
  listModels: async () => lateModels,
  capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
  health: () => ({ available: lateModels.length > 0 }),
  async stream() {
    throw new Error('not used');
  },
};

beforeAll(async () => {
  key = process.env.GATEWAY_API_KEY ||= 'test-key';
  process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'gateway-test-'));
  server = await import('../src/unified/server.ts');
  server.registry.register(fakeProvider);
  server.registry.register(lateProvider);
});

function chat(body: Record<string, unknown>) {
  requests.length = 0;
  return server.app.fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hello' }], ...body }),
  }));
}

describe('unified server routing', () => {
  test('returns a completion with provider response fields', async () => {
    replies.push([{ type: 'reasoning', text: 'think' }, { type: 'content', text: 'Hi there' }]);
    const response = await chat({});
    const json = await response.json() as any;
    expect(response.status).toBe(200);
    expect(json.choices[0].message).toMatchObject({ content: 'Hi there', reasoning_content: 'think' });
    expect(json.x_fake_id).toBe('abc');
    expect(response.headers.get('x-gateway-route')).toBe('fake/fake-model');
  });

  test('streams chunks as OpenAI SSE', async () => {
    replies.push([{ type: 'content', text: 'A' }, { type: 'content', text: 'B' }]);
    const text = await (await chat({ stream: true })).text();
    const deltas = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)).choices[0]);
    expect(deltas.map(choice => choice.delta.content).filter(Boolean)).toEqual(['A', 'B']);
    expect(deltas.at(-1).finish_reason).toBe('stop');
    expect(text.trim().endsWith('data: [DONE]')).toBeTrue();
  });

  test('retries once with the tool prompt when the tool-call reply is empty', async () => {
    replies.push([{ type: 'content', text: '{"tool_calls": []}' }], [{ type: 'content', text: 'plain answer' }]);
    const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
    const json = await (await chat({ tools })).json() as any;
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.messages[0]?.role === 'system')).toBeTrue();
    expect(json.choices[0].message.content).toBe('plain answer');
  });

  test('rejects unknown models', async () => {
    const response = await chat({ model: 'gpt-unknown' });
    expect(response.status).toBe(400);
  });

  test('reports stream errors as SSE error events', async () => {
    const failing: Provider = {
      ...fakeProvider,
      id: 'failing',
      supports: model => model === 'failing-model',
      async stream() {
        return {
          chunks: (async function* (): AsyncGenerator<ChatChunk> {
            yield { type: 'content', text: 'partial' };
            throw new Error('connection reset');
          })(),
        };
      },
    };
    server.registry.register(failing);
    const text = await (await chat({ model: 'failing-model', stream: true })).text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('connection reset');
    expect(text.trim().endsWith('data: [DONE]')).toBeTrue();
  });

  test('maps provider errors to http statuses with retry-after', async () => {
    const throwing = (id: string, error: Error): Provider => ({
      ...fakeProvider,
      id,
      supports: model => model === `${id}-model`,
      async stream() {
        throw error;
      },
    });
    server.registry.register(throwing('limited', new ProviderError('slow down', 'rate_limit', 429, 30)));
    server.registry.register(throwing('keyless', new ProviderError('NVIDIA_API_KEY is not set', 'unavailable')));

    const limited = await chat({ model: 'limited-model' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(((await limited.json()) as any).error.type).toBe('rate_limit_exceeded');

    const keyless = await chat({ model: 'keyless-model' });
    expect(keyless.status).toBe(503);
    expect(((await keyless.json()) as any).error.type).toBe('provider_unavailable');
  });

  test('serves the Responses API through the chat pipeline', async () => {
    const responses = (body: Record<string, unknown>, authorization = `Bearer ${key}`) =>
      server.app.fetch(new Request('http://local/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ model: 'fake-model', input: 'hello', ...body }),
      }));

    replies.push([{ type: 'content', text: 'Hello from responses' }]);
    const plain = await responses({});
    const json = await plain.json() as any;
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-gateway-route')).toBe('fake/fake-model');
    expect(json.object).toBe('response');
    expect(json.output[0].content[0].text).toBe('Hello from responses');

    replies.push([{ type: 'content', text: 'streamed' }]);
    const streamed = await (await responses({ stream: true })).text();
    expect(streamed.startsWith('event: response.created')).toBeTrue();
    expect(streamed).toContain('"delta":"streamed"');
    expect(streamed.trim().split('\n\n').at(-1)).toStartWith('event: response.completed');

    expect((await responses({}, 'Bearer wrong')).status).toBe(401);
    expect((await responses({ model: 'gpt-unknown' })).status).toBe(400);
  });

  test('serves the Anthropic Messages API with x-api-key auth', async () => {
    const messages = (body: Record<string, unknown>, headers: Record<string, string> = { 'x-api-key': key }) =>
      server.app.fetch(new Request('http://local/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
        body: JSON.stringify({ model: 'fake-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...body }),
      }));

    replies.push([{ type: 'content', text: 'Hello Claude Code' }]);
    const plain = await messages({});
    const json = await plain.json() as any;
    expect(plain.status).toBe(200);
    expect(json).toMatchObject({ type: 'message', role: 'assistant', stop_reason: 'end_turn', model: 'fake-model' });
    expect(json.content).toEqual([{ type: 'text', text: 'Hello Claude Code' }]);

    replies.push([{ type: 'content', text: 'streamed' }]);
    const streamed = await (await messages({ stream: true })).text();
    expect(streamed.startsWith('event: message_start')).toBeTrue();
    expect(streamed).toContain('"text":"streamed"');
    expect(streamed.trim().endsWith('"type":"message_stop"}')).toBeTrue();

    expect((await messages({}, { 'x-api-key': 'wrong' })).status).toBe(401);
    const unknown = await messages({ model: 'gpt-unknown' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).type).toBe('error');

    const count = await server.app.fetch(new Request('http://local/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }] }),
    }));
    expect(((await count.json()) as any).input_tokens).toBeGreaterThan(0);
  });

  test('exposes gateway status with providers and logged requests', async () => {
    replies.push([{ type: 'content', text: 'logged' }]);
    await chat({});
    await chat({ model: 'limited-model' });

    const unauthorized = await server.app.fetch(new Request('http://local/v1/gateway/status'));
    expect(unauthorized.status).toBe(401);

    const response = await server.app.fetch(new Request('http://local/v1/gateway/status', { headers: { authorization: `Bearer ${key}` } }));
    const status = await response.json() as any;
    expect(response.status).toBe(200);
    expect(status.providers).toContainEqual({ id: 'fake', ownedBy: 'fake-owner', available: true });
    expect(Array.isArray(status.accounts)).toBeTrue();
    expect(status.requests[0]).toMatchObject({ provider: 'limited', model: 'limited-model', status: 'error' });
    expect(status.requests[1]).toMatchObject({ provider: 'fake', model: 'fake-model', status: 'success' });
    expect(typeof status.requests[1].latencyMs).toBe('number');
  });

  test('logs a stream that fails after output as an error, once', async () => {
    server.registry.register({
      ...fakeProvider,
      id: 'dropping',
      supports: model => model === 'dropping-model',
      async stream() {
        return {
          chunks: (async function* (): AsyncGenerator<ChatChunk> {
            yield { type: 'content', text: 'partial' };
            throw new Error('socket closed mid-answer');
          })(),
        };
      },
    });

    const text = await (await chat({ model: 'dropping-model', stream: true })).text();
    expect(text).toContain('socket closed mid-answer');

    const status = await (await server.app.fetch(new Request('http://local/v1/gateway/status', { headers: { authorization: `Bearer ${key}` } }))).json() as any;
    const entries = status.requests.filter((entry: any) => entry.provider === 'dropping');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'error', model: 'dropping-model' });
    expect(entries[0].error).toContain('socket closed mid-answer');
  });

  test('streams Anthropic messages incrementally with thinking blocks when enabled', async () => {
    replies.push([
      { type: 'reasoning', text: 'plan ' },
      { type: 'content', text: 'Hel' },
      { type: 'content', text: 'lo' },
    ]);
    const response = await server.app.fetch(new Request('http://local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'fake-model',
        max_tokens: 100,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }));
    const events = (await response.text()).trim().split('\n\n').map(item => JSON.parse(item.split('\ndata: ')[1]!));
    const deltas = events.filter(item => item.type === 'content_block_delta').map(item => item.delta);
    expect(deltas).toEqual([
      { type: 'thinking_delta', thinking: 'plan ' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(events.at(-1).type).toBe('message_stop');
  });

  test('keeps the answer after a tool result and trims the tool output', async () => {
    const bash = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    const output = ['\x1b[32mok\x1b[0m', ...Array.from({ length: 600 }, (_, index) => `test ${index} passes`), 'FAIL parseDate', 'Tests: 1 failed'].join('\n');
    replies.push([{ type: 'content', text: 'The parseDate test fails.' }]);
    const response = await chat({
      model: 'fake-model',
      tools: bash,
      messages: [
        { role: 'user', content: 'Run the tests and tell me which one fails.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: output },
      ],
    });
    const body = await response.json();
    expect(body.choices[0].message.content).toBe('The parseDate test fails.');
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(response.headers.get('x-gateway-compacted')).toMatch(/^\d+->\d+$/);
    const sent = requests[0]!.messages.find(message => message.role === 'tool')!.content as string;
    expect(sent.length).toBeLessThan(output.length);
    expect(sent).toContain('FAIL parseDate');
    expect(sent).not.toContain('\x1b[');
  });

  test('asks again with a nudge when the model answers an agent with nothing', async () => {
    const bash = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    replies.push([{ type: 'reasoning', text: 'I should list the files.' }]);
    replies.push([{ type: 'content', text: '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}' }]);
    const response = await chat({
      model: 'fake-model',
      tools: bash,
      messages: [
        { role: 'user', content: 'Fix the failing test.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"bun test"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '2 fail' },
      ],
    });
    const body = await response.json();
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: 'ls' });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain('Your last reply was empty');
  });

  test('nudges a web chat that only announces what it will do', async () => {
    const bash = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    replies.push([{ type: 'content', text: "I'll start by running the tests." }]);
    replies.push([{ type: 'content', text: '{"tool_calls":[{"name":"bash","arguments":{"command":"bun test"}}]}' }]);
    const response = await chat({ model: 'fake-model', tools: bash, messages: [{ role: 'user', content: 'The build is red, find out why.' }] });
    const body = await response.json();
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: 'bun test' });
    expect(requests).toHaveLength(2);
    replies.push([{ type: 'content', text: `Found it: commit 9b3a687 changed the SAVE20 rate from 0.2 to 0.02. ${'The history shows it clearly. '.repeat(20)}Let me check the current file:` }]);
    replies.push([{ type: 'content', text: '{"tool_calls":[{"name":"bash","arguments":{"command":"cat src/cart.ts"}}]}' }]);
    const late = await (await chat({ model: 'fake-model', tools: bash, messages: [{ role: 'user', content: 'The build is red, find out why.' }] })).json();
    expect(JSON.parse(late.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: 'cat src/cart.ts' });
    replies.push([{ type: 'content', text: 'The rate was wrong and is fixed now. Let me know if you need anything else.' }]);
    const done = await (await chat({ model: 'fake-model', tools: bash, messages: [{ role: 'user', content: 'The build is red, find out why.' }] })).json();
    expect(done.choices[0].message.content).toContain('fixed now');
    expect(requests).toHaveLength(1);
  });

  test('passes tools natively to providers that take them and returns their tool calls', async () => {
    const seen: ChatRequest[] = [];
    server.registry.register({
      id: 'native',
      ownedBy: 'native-owner',
      fallback: true,
      supports: model => model === 'native-model',
      listModels: async () => ['native-model'],
      capabilities: () => ({ nativeTools: true, reasoning: false, vision: false }),
      health: () => ({ available: true }),
      async stream(request) {
        seen.push(request);
        return { chunks: (async function* () {
          yield { type: 'tool_call' as const, index: 0, id: 'call_x', name: 'bash', arguments: '{"command":"git status"}' };
        })() };
      },
    });
    const bash = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    for (const stream of [false, true]) {
      seen.length = 0;
      const response = await chat({ model: 'native-model', tools: bash, stream, messages: [{ role: 'user', content: 'status?' }] });
      expect(seen[0]!.tools).toEqual(bash);
      expect(seen[0]!.messages.some(message => message.role === 'system' && String(message.content).includes('bash'))).toBeFalse();
      const text = await response.text();
      expect(text).toContain('"name":"bash"');
      expect(text).toContain('git status');
      expect(text).toContain('tool_calls');
    }
  });

  test('validates image generation requests', async () => {
    const images = (body: unknown) => server.app.fetch(new Request('http://local/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }));
    expect((await images({})).status).toBe(400);
    const unknown = await images({ prompt: 'a fox', model: 'nope/model' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.message).toContain('Unknown image model');
    expect((await images({ prompt: 'a fox', model: 'pollinations/sana', size: 'huge' })).status).toBe(400);
  });


  test('adds request ids, forwards them to subrequests and exposes Prometheus metrics', async () => {
    replies.push([{ type: 'content', text: 'metrics' }]);
    const response = await server.app.fetch(new Request('http://local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-request-id': 'trace-42' },
      body: JSON.stringify({ model: 'fake-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('trace-42');

    const generated = await server.app.fetch(new Request('http://local/health'));
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    expect((await server.app.fetch(new Request('http://local/metrics'))).status).toBe(401);
    const metrics = await server.app.fetch(new Request('http://local/metrics', { headers: { authorization: `Bearer ${key}` } }));
    const text = await metrics.text();
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(text).toMatch(/gateway_requests_total\{provider="fake",model="fake-model",status="success"\} \d+/);
    expect(text).toContain('gateway_provider_available{provider="fake"} 1');
  });

  test('reloads model lists on demand so a newly added key shows its models', async () => {
    const saved = process.env.NVIDIA_API_KEY;
    const realFetch = globalThis.fetch;
    process.env.NVIDIA_API_KEY = '';
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch;
    try {
      const listed = async () => ((await (await server.app.fetch(new Request('http://local/v1/models', { headers: { authorization: `Bearer ${key}` } }))).json()) as any).data.map((model: any) => model.id);
      lateModels = [];
      await server.app.fetch(new Request('http://local/v1/gateway/refresh', { method: 'POST', headers: { authorization: `Bearer ${key}` } }));
      expect(await listed()).not.toContain('late-model');
      lateModels = ['late-model'];
      const refreshed = await server.app.fetch(new Request('http://local/v1/gateway/refresh', { method: 'POST', headers: { authorization: `Bearer ${key}` } }));
      expect(refreshed.status).toBe(200);
      expect(((await refreshed.json()) as any).providers).toContainEqual({ id: 'late', available: true });
      expect(await listed()).toContain('late-model');
      expect((await server.app.fetch(new Request('http://local/v1/gateway/refresh', { method: 'POST' }))).status).toBe(401);
    } finally {
      process.env.NVIDIA_API_KEY = saved;
      globalThis.fetch = realFetch;
    }
  });
});
