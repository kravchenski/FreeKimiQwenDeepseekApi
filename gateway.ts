import { Hono } from 'hono';
import { serve } from 'bun';
import { extractConversationId, mergeModelLists, targetForModel } from './src/gateway/routing.ts';
import { bearerToken, isForwardableResponseHeader, tokenMatches } from './src/gateway/security.ts';
import { chatResponseToResponses, responsesToChatRequest, writeResponsesSse } from './src/gateway/responses.ts';

const app = new Hono();
const port = Number(process.env.GATEWAY_PORT || 3263);
const host = process.env.GATEWAY_HOST || process.env.HOST || '127.0.0.1';
const apiKey = process.env.GATEWAY_API_KEY;
const configuredUpstreamTimeout = Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 180_000);
const upstreamTimeout = Number.isFinite(configuredUpstreamTimeout) && configuredUpstreamTimeout > 0 ? configuredUpstreamTimeout : 180_000;
const qwenUrl = process.env.QWEN_URL || 'http://qwen-proxy:3264/api';
const deepSeekUrl = process.env.DEEPSEEK_URL || 'http://deepseek-proxy:3265/api';
const kimiUrl = process.env.KIMI_URL || 'http://kimi-proxy:3266/api';
const providerUrls = [qwenUrl, deepSeekUrl, kimiUrl];

app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'gateway' }));

app.get('/ready', async (c) => {
    const providers = await Promise.allSettled(providerUrls.map(url => fetch(`${url}/models`, { signal: AbortSignal.timeout(10_000) })));
    const ready = providers.every(result => result.status === 'fulfilled' && result.value.ok);
    return c.json({ status: ready ? 'ready' : 'degraded', providers: providers.map(result => result.status === 'fulfilled' && result.value.ok) }, ready ? 200 : 503);
});

app.use('/api/*', async (c, next) => {
    if (tokenMatches(bearerToken(c.req.header('authorization')), apiKey)) return next();
    return c.json({ error: { message: 'Invalid gateway bearer token' } }, 401);
});

app.get('/api/models', async (c) => {
    try {
        const responses = await Promise.all(providerUrls.map(url => fetch(`${url}/models`, { signal: AbortSignal.timeout(10_000) })));
        const failed = responses.find(response => !response.ok);
        if (failed) throw new Error(`Provider model list failed with HTTP ${failed.status}`);
        const payloads = await Promise.all(responses.map(response => response.json()));
        const data = mergeModelLists(payloads);
        return c.json({ object: 'list', data });
    } catch (error) {
        return c.json({ error: { message: error instanceof Error ? error.message : String(error) } }, 502);
    }
});

app.get('/api/v1/models', async (c) => {
    try {
        const responses = await Promise.all(providerUrls.map(url => fetch(`${url}/models`, { signal: AbortSignal.timeout(10_000) })));
        const failed = responses.find(response => !response.ok);
        if (failed) throw new Error(`Provider model list failed with HTTP ${failed.status}`);
        const payloads = await Promise.all(responses.map(response => response.json()));
        const data = mergeModelLists(payloads);
        return c.json({ object: 'list', data });
    } catch (error) {
        return c.json({ error: { message: error instanceof Error ? error.message : String(error) } }, 502);
    }
});

app.post('/api/v1/responses', async (c) => {
    try {
        const body = await c.req.json();
        const upstream = targetForModel(body.model, qwenUrl, deepSeekUrl, kimiUrl);
        const { request, routes } = responsesToChatRequest(body);
        const response = await fetch(`${upstream}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(upstreamTimeout)
        });
        const payload = await response.json();
        if (!response.ok) return c.json(payload, response.status as any);
        const converted = chatResponseToResponses(payload, routes);
        if (body.stream) {
            const encoder = new TextEncoder();
            const readable = new ReadableStream({
                start(controller) {
                    const chunks = writeResponsesSseChunks(converted);
                    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                    controller.close();
                }
            });
            return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }
        return c.json(converted);
    } catch (error) {
        const message = error instanceof SyntaxError ? 'Request body must be valid JSON' : error instanceof Error ? error.message : String(error);
        return c.json({ error: { message } }, error instanceof SyntaxError ? 400 : 502);
    }
});

function writeResponsesSseChunks(data: any): string[] {
    const chunks: string[] = [];
    chunks.push(`data: ${JSON.stringify(data)}\n\n`);
    chunks.push('data: [DONE]\n\n');
    return chunks;
}

app.all('/api/*', async (c) => {
    try {
        const body = await c.req.arrayBuffer();
        const parsed = body.byteLength > 0 ? JSON.parse(new TextDecoder().decode(body)) : {};
        const upstream = targetForModel(parsed.model, qwenUrl, deepSeekUrl, kimiUrl);
        const path = c.req.url.replace(/^.*\/api/, '');
        const sessionId = extractConversationId(c.req.raw.headers, parsed);
        const response = await fetch(`${upstream}${path}`, {
            method: c.req.method,
            headers: {
                'content-type': c.req.header('content-type') || 'application/json',
                accept: c.req.header('accept') || 'application/json',
                ...(sessionId ? { 'x-conversation-id': sessionId } : {})
            },
            body: body.byteLength > 0 ? body : undefined,
            signal: AbortSignal.timeout(upstreamTimeout)
        });
        const resHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            if (isForwardableResponseHeader(name)) resHeaders[name] = value;
        });
        if (!response.body) return c.body(null, { status: response.status, headers: resHeaders });
        return new Response(response.body, { status: response.status, headers: resHeaders });
    } catch (error) {
        const message = error instanceof SyntaxError ? 'Request body must be valid JSON' : error instanceof Error ? error.message : String(error);
        return c.json({ error: { message } }, error instanceof SyntaxError ? 400 : 502);
    }
});

serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
console.log(`Unified Qwen + DeepSeek + Kimi gateway listening on http://${host}:${port}/api`);
