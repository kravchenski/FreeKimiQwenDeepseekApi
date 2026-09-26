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

beforeAll(async () => {
  key = process.env.GATEWAY_API_KEY ||= 'test-key';
  server = await import('../src/unified/server.ts');
  server.registry.register(fakeProvider);
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
    server.registry.register(throwing('keyless', new ProviderError('ZENMUX_API_KEY is not set', 'unavailable')));

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
});

