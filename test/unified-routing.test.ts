import { beforeAll, describe, expect, test } from 'bun:test';

import type { ChatChunk, ChatRequest, Provider } from '../src/core/providers/provider.ts';

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
});
