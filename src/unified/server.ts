import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { serve } from 'bun';
import crypto from 'crypto';

import { isEmptyToolCallResponse } from '../providers/deepseek/client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from '../api/routes.ts';
import { bearerToken, tokenMatches } from '../gateway/security.ts';
import { chatResponseToResponses, responsesSseEvents, responsesToChatRequest } from '../gateway/responses.ts';
import { anthropicError, anthropicSseEvents, anthropicToChatRequest, chatToAnthropicMessage, estimateInputTokens } from '../api/anthropic/messages.ts';
import type { ProviderStream } from '../core/providers/provider.ts';
import { ProviderRegistry, type ModelEntry } from '../core/providers/registry.ts';
import { collectChunks } from '../core/streaming/sse.ts';
import { toHttpError } from '../core/providers/errors.ts';
import { AUTO_MODEL, parseAutoModels, SmartRouter } from '../core/router/smart-router.ts';
import { openDatabase, recordRequest, type RequestLog } from '../core/store/database.ts';
import { gatewayStatus } from '../core/status.ts';
import type { Database } from 'bun:sqlite';
import { createNvidiaProvider, createZenMuxProviders } from '../providers/catalog.ts';
import { createDeepSeekProvider } from '../providers/deepseek/provider.ts';
import { createQwenProvider } from '../providers/qwen/provider.ts';

export const app = new Hono();
const port = Number(process.env.UNIFIED_PORT || 3260);
const host = process.env.HOST || '0.0.0.0';
const apiKey = process.env.GATEWAY_API_KEY || undefined;
const maxBodyBytes = 25 * 1024 * 1024;

app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (tokenMatches(bearerToken(c.req.header('authorization')) ?? c.req.header('x-api-key') ?? null, apiKey)) return next();
    return c.json({ error: { message: 'Invalid bearer token', type: 'authentication_error' } }, 401);
});

app.use('*', bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413),
}));

export const registry = new ProviderRegistry()
    .register(createNvidiaProvider())
    .register(createDeepSeekProvider())
    .register(createQwenProvider());
for (const provider of createZenMuxProviders()) registry.register(provider);

export const router = new SmartRouter(registry, parseAutoModels(process.env.AUTO_MODELS));

let database: Database | undefined;
function db() {
    database ??= openDatabase();
    return database;
}

function logRequest(entry: RequestLog) {
    try {
        recordRequest(db(), entry);
    } catch (error) {
        console.error('Failed to record request log:', error instanceof Error ? error.message : error);
    }
}

let allModels: ModelEntry[] = [];

async function refreshModelLists() {
    allModels = [{ id: AUTO_MODEL, ownedBy: 'gateway' }, ...await registry.listModels()];
}

function isCodebaseActionRequest(messages: Array<Record<string, any>>) {
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content.toLowerCase() : '';
    return /рефактор|исправ|измени|добав|удал|проверь|тест|review|refactor|implement|fix|change|inspect|test/.test(text);
}

function fallbackInspectionToolCall(tools: Array<Record<string, any>> | null) {
    if (!Array.isArray(tools)) return null;
    const names = new Set(tools.map(tool => (tool?.function || tool)?.name));
    if (names.has('ls')) return { name: 'ls', arguments: { path: '.', description: 'List files in current directory' } };
    if (names.has('bash')) return { name: 'bash', arguments: { command: 'ls -la', description: 'List files in current directory' } };
    if (names.has('find')) return { name: 'find', arguments: { path: '.', pattern: '*', description: 'Find files in current directory' } };
    return null;
}

function buildToolCallResponse(toolCalls: Array<Record<string, any>>) {
    return toolCalls.map(({ index: _index, ...call }) => call);
}

function processToolCalls(
    content: string,
    captureToolCalls: boolean,
    combinedTools: Array<Record<string, any>> | null,
    messages: Array<Record<string, any>>
) {
    const recoveredShell = captureToolCalls ? recoverBrokenBashToolCall(content) : null;
    const conversationalText = recoveredShell
        ? conversationalShellText(recoveredShell.name, recoveredShell.arguments)
        : null;
    if (conversationalText) content = conversationalText;
    let toolCalls = captureToolCalls && !conversationalText ? parseToolCallJson(content, combinedTools) : null;
    if (!toolCalls?.length && captureToolCalls && isCodebaseActionRequest(messages)) {
        const fallback = fallbackInspectionToolCall(combinedTools);
        if (fallback) {
            toolCalls = [{
                id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
                type: 'function',
                function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) },
                index: 0
            }];
        }
    }
    return { content, toolCalls, conversationalText };
}

function streamChunk(
    id: string,
    created: number,
    model: string,
    delta: Record<string, unknown>,
    finishReason: string | null = null
) {
    return `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`;
}

function handleProviderStream(
    id: string,
    created: number,
    model: string,
    captureToolCalls: boolean,
    combinedTools: Array<Record<string, any>> | null,
    messages: Array<Record<string, any>>,
    first: ProviderStream,
    retry: () => Promise<ProviderStream>,
    extraHeaders: Record<string, string> = {}
) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                await writeStream(controller);
            } catch (error) {
                const { message, type } = toHttpError(error);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type } })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        }
    });

    async function writeStream(controller: ReadableStreamDefaultController) {
        const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
            controller.enqueue(encoder.encode(streamChunk(id, created, model, delta, finishReason)));
        send({ role: 'assistant' });

        let content = '';
        let reasoning = '';
        for await (const chunk of first.chunks) {
            if (chunk.type === 'content') content += chunk.text;
            else reasoning += chunk.text;
            if (captureToolCalls) continue;
            send(chunk.type === 'content' ? { content: chunk.text } : { reasoning_content: chunk.text });
        }

        if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
            ({ content, reasoning } = await collectChunks((await retry()).chunks));
        }

        const { toolCalls, conversationalText } = processToolCalls(content, captureToolCalls, combinedTools, messages);
        if (conversationalText) content = conversationalText;

        if (toolCalls?.length) {
            for (const call of toolCalls) {
                send({ tool_calls: [{ index: call.index, id: call.id, type: call.type, function: call.function }] });
            }
            send({}, 'tool_calls');
        } else {
            if (captureToolCalls && reasoning) send({ reasoning_content: reasoning });
            if (captureToolCalls && content) send({ content });
            send({}, 'stop');
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
    }

    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...extraHeaders }
    });
}

app.get('/v1/gateway/status', (c) => c.json(gatewayStatus(registry, db())));

app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'unified' });
});

app.get('/api/models', (c) => {
    return c.json({
        object: 'list',
        data: allModels.map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
    });
});

app.get('/api/v1/models', (c) => {
    return c.json({
        object: 'list',
        data: allModels.map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
    });
});

app.post('/api/chat/completions', async (c) => {
    let body: Record<string, any>;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
    }
    try {
        const { messages, model = 'deepseek-default', stream = false, tools, functions } = body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: { message: 'messages must be a non-empty array' } }, 400);
        }

        if (!router.knows(model)) {
            return c.json({ error: { message: `Unknown model: ${model}. Available: ${allModels.map(entry => entry.id).join(', ')}` } }, 400);
        }

        const conversationId = body.conversation_id || body.chat_id || c.req.header('x-conversation-id') || undefined;
        const combinedTools = tools || (Array.isArray(functions)
            ? functions.map((fn: Record<string, unknown>) => ({ type: 'function', function: fn }))
            : null);
        const toolPrompt = toolsToPrompt(combinedTools);
        const upstreamMessages = toolPrompt
            ? [{ role: 'system', content: toolPrompt }, ...messages]
            : messages;
        const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);
        const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;

        const startedAt = Date.now();
        const first = await router.open(model, route => ({ model: route.model, messages: upstreamMessages, conversationId }))
            .catch(error => {
                logRequest({ provider: registry.resolve(model)?.id ?? 'none', model, status: 'error', latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
                throw error;
            });
        const { provider, model: routedModel } = first.route;
        logRequest({ provider: provider.id, model: routedModel, status: 'success', latencyMs: Date.now() - startedAt });
        const open = () => provider.stream({ model: routedModel, messages: upstreamMessages, conversationId });
        const routeHeaders = { 'x-gateway-route': `${provider.id}/${routedModel}` };

        if (stream) {
            return handleProviderStream(id, created, routedModel, captureToolCalls, combinedTools, messages, first, open, routeHeaders);
        }

        let { content, reasoning } = await collectChunks(first.chunks);
        let responseFields = first.responseFields;
        if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
            const retried = await open();
            ({ content, reasoning } = await collectChunks(retried.chunks));
            responseFields = retried.responseFields;
        }
        const { toolCalls, conversationalText } = processToolCalls(content, captureToolCalls, combinedTools, messages);
        c.header('x-gateway-route', routeHeaders['x-gateway-route']);
        return c.json({
            id, object: 'chat.completion', created, model: routedModel,
            choices: [{
                index: 0,
                message: toolCalls?.length
                    ? { role: 'assistant', content: null, tool_calls: buildToolCallResponse(toolCalls) }
                    : { role: 'assistant', content: conversationalText || content, reasoning_content: reasoning || undefined },
                finish_reason: toolCalls?.length ? 'tool_calls' : 'stop'
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            ...responseFields
        });
    } catch (error) {
        const { status, type, message, retryAfterSeconds } = toHttpError(error);
        if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
        return c.json({ error: { message, type } }, status);
    }
});

app.post('/api/v1/chat/completions', async (c) => {
    return app.fetch(new Request(c.req.url.replace('/v1', ''), {
        method: 'POST',
        headers: c.req.raw.headers,
        body: c.req.raw.body
    }));
});

app.get('/v1/models', (c) => {
    return c.json({
        object: 'list',
        data: allModels.map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
    });
});

app.post('/v1/chat/completions', async (c) => {
    return app.fetch(new Request(new URL(c.req.url).href.replace('/v1/chat/completions', '/api/chat/completions'), {
        method: 'POST',
        headers: c.req.raw.headers,
        body: c.req.raw.body
    }));
});

async function handleResponses(c: Context) {
    let body: Record<string, any>;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
    }
    const { request, routes } = responsesToChatRequest(body);
    const headers = new Headers({ 'content-type': 'application/json' });
    const authorization = c.req.header('authorization');
    if (authorization) headers.set('authorization', authorization);
    const chat = await app.fetch(new Request(new URL('/api/chat/completions', c.req.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
    }));
    const payload = await chat.json() as Record<string, any>;
    const passthrough: Record<string, string> = {};
    for (const name of ['x-gateway-route', 'retry-after']) {
        const value = chat.headers.get(name);
        if (value) passthrough[name] = value;
    }
    if (!chat.ok) return c.json(payload, chat.status as ContentfulStatusCode, passthrough);
    const converted = chatResponseToResponses(payload, routes);
    if (!body.stream) return c.json(converted, 200, passthrough);
    return new Response(responsesSseEvents(converted).join(''), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...passthrough },
    });
}

async function handleMessages(c: Context) {
    let body: Record<string, any>;
    try {
        body = await c.req.json();
    } catch {
        return c.json(anthropicError(400, 'Invalid JSON body'), 400);
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
        return c.json(anthropicError(400, 'messages must be a non-empty array'), 400);
    }
    const headers = new Headers({ 'content-type': 'application/json' });
    const authorization = c.req.header('authorization');
    if (authorization) headers.set('authorization', authorization);
    else if (c.req.header('x-api-key')) headers.set('authorization', `Bearer ${c.req.header('x-api-key')}`);
    const chat = await app.fetch(new Request(new URL('/api/chat/completions', c.req.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(anthropicToChatRequest(body)),
    }));
    const payload = await chat.json() as Record<string, any>;
    const passthrough: Record<string, string> = {};
    for (const name of ['x-gateway-route', 'retry-after']) {
        const value = chat.headers.get(name);
        if (value) passthrough[name] = value;
    }
    if (!chat.ok) {
        return c.json(anthropicError(chat.status, payload?.error?.message ?? 'Upstream error'), chat.status as ContentfulStatusCode, passthrough);
    }
    const message = chatToAnthropicMessage(payload, typeof body.model === 'string' ? body.model : payload.model);
    if (!body.stream) return c.json(message, 200, passthrough);
    return new Response(anthropicSseEvents(message).join(''), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...passthrough },
    });
}

app.post('/v1/messages', handleMessages);
app.post('/api/v1/messages', handleMessages);
app.post('/v1/messages/count_tokens', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json(anthropicError(400, 'Invalid JSON body'), 400);
    return c.json({ input_tokens: estimateInputTokens(body) });
});

app.post('/v1/responses', handleResponses);
app.post('/api/v1/responses', handleResponses);

export async function startUnifiedServer() {
    await refreshModelLists();
    const modelCount = allModels.length;

    serve({
        fetch: app.fetch,
        port,
        hostname: host,
        idleTimeout: 255,
    });

    console.log(`
  FreeQwenApi — OpenCode-compatible API

  Endpoint: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}
  Models:   ${modelCount} total (fetched from upstream APIs)

  Providers: deepseek qwen kimi glm sapiens stepfun nvidia
  Kimi, GLM, Sapiens, and StepFun use ZenMux proxy; set ZENMUX_API_KEY in .env.
  NVIDIA models use NVIDIA API; set NVIDIA_API_KEY in .env.
  Qwen models use the Qwen API proxy (QWEN_API_BASE_URL); set QWEN_TOKEN or add accounts via bun run auth.

  ${apiKey ? 'API key required (GATEWAY_API_KEY).' : 'No API key required. Set GATEWAY_API_KEY to protect the API.'} Configure OpenCode:
    OPENCODE_API_URL=http://${host === '0.0.0.0' ? 'localhost' : host}:${port}
    OPENCODE_API_KEY=${apiKey ? '<GATEWAY_API_KEY>' : ''}
`);
}

if (import.meta.main) {
    startUnifiedServer().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
