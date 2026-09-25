import { beforeAll, describe, expect, test } from 'bun:test';

let app: { fetch: (request: Request) => Response | Promise<Response> };

let key = '';

beforeAll(async () => {
    key = process.env.GATEWAY_API_KEY ||= 'test-key';
    ({ app } = await import('../src/unified/server.ts'));
});

const chat = (headers: Record<string, string>, body: BodyInit) =>
    app.fetch(new Request('http://local/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
    }));

describe('unified server security', () => {
    test('health is public', async () => {
        const response = await app.fetch(new Request('http://local/health'));
        expect(response.status).toBe(200);
    });

    test('rejects requests without a valid bearer token', async () => {
        expect((await app.fetch(new Request('http://local/v1/models'))).status).toBe(401);
        const wrong = await app.fetch(new Request('http://local/v1/models', { headers: { authorization: 'Bearer nope' } }));
        expect(wrong.status).toBe(401);
    });

    test('accepts a valid bearer token', async () => {
        const response = await app.fetch(new Request('http://local/v1/models', { headers: { authorization: `Bearer ${key}` } }));
        expect(response.status).toBe(200);
    });

    test('returns 400 for malformed JSON', async () => {
        const response = await chat({ authorization: `Bearer ${key}` }, '{bad');
        expect(response.status).toBe(400);
    });

    test('returns 413 for oversized bodies', async () => {
        const response = await chat({ authorization: `Bearer ${key}` }, 'a'.repeat(26 * 1024 * 1024));
        expect(response.status).toBe(413);
    });
});
