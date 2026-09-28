import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { loadConfig } from '../config.ts';
import { serve } from 'bun';
import crypto from 'crypto';

import { isEmptyToolCallResponse } from '../providers/deepseek/client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from '../core/tools/tool-calls.ts';
import { bearerToken, tokenMatches } from '../gateway/security.ts';
import { chatResponseToResponses, responsesToChatRequest } from '../gateway/responses.ts';
import { ResponsesStreamTranslator } from '../gateway/responses-stream.ts';
import { anthropicError, anthropicToChatRequest, chatToAnthropicMessage, estimateInputTokens } from '../api/anthropic/messages.ts';
import { AnthropicStreamTranslator } from '../api/anthropic/stream.ts';
import { editImage, generateImage, type ImageUpstream } from '../api/images.ts';
import { readLines } from '../core/streaming/sse.ts';
import type { ProviderStream } from '../core/providers/provider.ts';
import { ProviderRegistry, type ModelEntry } from '../core/providers/registry.ts';
import { collectChunks } from '../core/streaming/sse.ts';
import { ProviderError, toHttpError } from '../core/providers/errors.ts';
import { buildAutoChain } from '../core/router/auto-chain.ts';
import { AUTO_MODEL, parseAutoModels, SmartRouter } from '../core/router/smart-router.ts';
import { conversationKey, SessionAffinity } from '../core/router/session-affinity.ts';
import { loadModelStats, loadSignIn, openDatabase, recordRequest, saveModelStat, saveSignIn, type RequestLog } from '../core/store/database.ts';
import { WebSignInStatus } from '../core/accounts/sign-in-status.ts';
import { WEB_CHAT_SITES } from '../providers/web-chat-sites.ts';
import { gatewayStatus } from '../core/status.ts';
import { Metrics, requestIdFrom } from '../observability/metrics.ts';
import type { Database } from 'bun:sqlite';
import { createNvidiaProvider } from '../providers/catalog.ts';
import { openCredentialStore } from '../core/accounts/credential-store.ts';
import { createDeepSeekProvider } from '../providers/deepseek/provider.ts';
import { createQwenProvider } from '../providers/qwen/provider.ts';
import { BrowserChatSession, notSignedIn } from '../browser/browser-chat.ts';
import { createBrowserChatProvider } from '../providers/browser-chat-provider.ts';
import { parseZaiStream, ZAI_CHAT_SITE } from '../providers/glm/web.ts';
import { KIMI_CHAT_SITE, parseKimiStream } from '../providers/kimi/web.ts';

export const app = new Hono();
const config = loadConfig();
const port = config.UNIFIED_PORT;
const host = config.HOST;
const apiKey = config.GATEWAY_API_KEY;
const maxBodyBytes = 25 * 1024 * 1024;

const requestIds = new WeakMap<Request, string>();

app.use('*', async (c, next) => {
    const requestId = requestIdFrom(c.req.header('x-request-id'));
    requestIds.set(c.req.raw, requestId);
    await next();
    try {
        c.res.headers.set('x-request-id', requestId);
    } catch {
        c.res = new Response(c.res.body, c.res);
        c.res.headers.set('x-request-id', requestId);
    }
});

app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (tokenMatches(bearerToken(c.req.header('authorization')) ?? c.req.header('x-api-key') ?? null, apiKey)) return next();
    return c.json({ error: { message: 'Invalid bearer token', type: 'authentication_error' } }, 401);
});

app.use('*', bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413),
}));

const qwenProvider = createQwenProvider();

export const registry = new ProviderRegistry()
    .register(createNvidiaProvider({}, openCredentialStore()))
    .register(createDeepSeekProvider())
    .register(qwenProvider);

let browserChat: BrowserChatSession | undefined;
const signIns = new WebSignInStatus({
    load: provider => loadSignIn(db(), provider),
    save: record => saveSignIn(db(), record),
});
const browserChatSession = () => (browserChat ??= new BrowserChatSession({
    onSignIn: (siteId, result) => {
        const site = WEB_CHAT_SITES.find(entry => entry.id === siteId);
        signIns.record(siteId, result.signedIn, result.signedIn || !site ? undefined : notSignedIn(site, result));
    },
}));

registry.register(createBrowserChatProvider({
    id: 'glm-chat',
    ownedBy: 'z-ai-web',
    model: 'glm-chat',
    site: ZAI_CHAT_SITE,
    session: browserChatSession,
    health: () => signIns.health('glm-chat'),
    parse: parseZaiStream,
}));

registry.register(createBrowserChatProvider({
    id: 'kimi-chat',
    ownedBy: 'kimi-web',
    model: 'kimi-chat',
    site: KIMI_CHAT_SITE,
    session: browserChatSession,
    health: () => signIns.health('kimi-chat'),
    parse: parseKimiStream,
}));

export const router = new SmartRouter(registry, parseAutoModels(config.AUTO_MODELS), Date.now, {
    firstChunkTimeoutMs: config.AUTO_FIRST_CHUNK_TIMEOUT_MS,
});

let database: Database | undefined;
function db() {
    database ??= openDatabase();
    return database;
}

let affinityStore: SessionAffinity | undefined;
function affinity() {
    try {
        affinityStore ??= new SessionAffinity(db());
        return affinityStore;
    } catch (error) {
        console.error('Session affinity unavailable:', errorText(error));
        return undefined;
    }
}

function errorText(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

const metrics = new Metrics();

function logRequest(entry: RequestLog) {
    metrics.record(entry);
    try {
        recordRequest(db(), entry);
    } catch (error) {
        console.error('Failed to record request log:', error instanceof Error ? error.message : error);
    }
}

let allModels: ModelEntry[] = [];

async function refreshModelLists() {
    allModels = [{ id: AUTO_MODEL, ownedBy: 'gateway' }, ...await registry.listModels()];
    rebuildAutoChain();
}

function rebuildAutoChain() {
    if (config.AUTO_MODELS) return;
    const candidates = allModels.flatMap(entry => {
        const provider = registry.resolve(entry.id);
        return provider ? [{ id: entry.id, provider: provider.id, fallback: provider.fallback ?? false }] : [];
    });
    router.setAutoModels(buildAutoChain(candidates, registry.stats, model => registry.availability.isAvailable(model)));
}

function loadModelStatistics() {
    try {
        registry.stats.load(loadModelStats(db()));
    } catch (error) {
        console.error('Model statistics unavailable:', errorText(error));
    }
}

registry.availability.onChange(rebuildAutoChain);
registry.stats.onChange(stat => {
    try {
        saveModelStat(db(), stat);
    } catch (error) {
        console.error('Failed to save model statistics:', errorText(error));
    }
    rebuildAutoChain();
});

function visibleModels() {
    return allModels.filter(entry => registry.availability.isAvailable(entry.id));
}

function scheduleModelRefresh() {
    if (!config.MODEL_REFRESH_MINUTES) return;
    setInterval(() => {
        refreshModelLists().catch(error => console.error('Model list refresh failed:', errorText(error)));
    }, config.MODEL_REFRESH_MINUTES * 60_000).unref();
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
    extraHeaders: Record<string, string> = {},
    onFinish: (error?: unknown) => void = () => {}
) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                await writeStream(controller);
            } catch (error) {
                onFinish(error);
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
        onFinish();
    }

    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...extraHeaders }
    });
}

app.get('/v1/gateway/status', (c) => c.json({ ...gatewayStatus(registry, db()), autoModels: router.autoChain(), modelStats: registry.stats.list() }));

app.get('/metrics', (c) => {
    let accounts: Array<{ provider: string; status: string }> = [];
    try {
        accounts = gatewayStatus(registry, db()).accounts;
    } catch (error) {
        console.error('Metrics could not read account states:', errorText(error));
    }
    const providers = registry.list().map(provider => ({ id: provider.id, available: provider.health().available }));
    const unavailableModels = registry.availability.list();
    return c.text(metrics.render({ providers, accounts, unavailableModels }), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
});

app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'unified', pid: process.pid });
});

app.get('/api/models', (c) => {
    return c.json({
        object: 'list',
        data: visibleModels().map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
    });
});

app.get('/api/v1/models', (c) => {
    return c.json({
        object: 'list',
        data: visibleModels().map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
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
            return c.json({ error: { message: `Unknown model: ${model}. Available: ${visibleModels().map(entry => entry.id).join(', ')}` } }, 400);
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
        const sessionKey = model === AUTO_MODEL ? conversationId ?? conversationKey(messages) : undefined;
        const sessions = sessionKey ? affinity() : undefined;
        const pinned = sessionKey ? sessions?.get(sessionKey, AUTO_MODEL) : undefined;
        const first = await router.open(model, route => ({ model: route.model, messages: upstreamMessages, conversationId }), pinned?.model)
            .catch(error => {
                logRequest({ provider: registry.resolve(model)?.id ?? 'none', model, status: 'error', latencyMs: Date.now() - startedAt, error: errorText(error) });
                throw error;
            });
        const { provider, model: routedModel } = first.route;
        if (sessionKey) sessions?.set(sessionKey, AUTO_MODEL, { provider: provider.id, model: routedModel });
        const finish = (error?: unknown) => logRequest({
            provider: provider.id,
            model: routedModel,
            status: error === undefined ? 'success' : 'error',
            latencyMs: Date.now() - startedAt,
            ...(error === undefined ? {} : { error: errorText(error) }),
        });
        const open = () => provider.stream({ model: routedModel, messages: upstreamMessages, conversationId });
        const routeHeaders = { 'x-gateway-route': `${provider.id}/${routedModel}` };

        if (stream) {
            return handleProviderStream(id, created, routedModel, captureToolCalls, combinedTools, messages, first, open, routeHeaders, finish);
        }

        let content: string;
        let reasoning: string;
        let responseFields = first.responseFields;
        try {
            ({ content, reasoning } = await collectChunks(first.chunks));
            if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
                const retried = await open();
                ({ content, reasoning } = await collectChunks(retried.chunks));
                responseFields = retried.responseFields;
            }
        } catch (error) {
            finish(error);
            throw error;
        }
        finish();
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
        data: visibleModels().map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy }))
    });
});

app.post('/v1/chat/completions', async (c) => {
    return app.fetch(new Request(new URL(c.req.url).href.replace('/v1/chat/completions', '/api/chat/completions'), {
        method: 'POST',
        headers: c.req.raw.headers,
        body: c.req.raw.body
    }));
});

interface StreamTranslator {
    start(): string[];
    push(chunk: Record<string, any>): string[];
    finish(): string[];
}

function translatedStream(body: ReadableStream<Uint8Array> | null, translator: StreamTranslator, headers: Record<string, string>) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = (events: string[]) => events.forEach(item => controller.enqueue(encoder.encode(item)));
            send(translator.start());
            try {
                for await (const line of readLines(body)) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') break;
                    let chunk: Record<string, any>;
                    try {
                        chunk = JSON.parse(data);
                    } catch {
                        continue;
                    }
                    send(translator.push(chunk));
                }
                send(translator.finish());
            } catch (error) {
                send(translator.push({ error: { message: errorText(error) } }));
            }
            controller.close();
        }
    });
    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers },
    });
}

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
    const requestId = requestIds.get(c.req.raw);
    if (requestId) headers.set('x-request-id', requestId);
    const streaming = Boolean(body.stream);
    const includeReasoning = Boolean(body.reasoning?.summary);
    const chat = await app.fetch(new Request(new URL('/api/chat/completions', c.req.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, stream: streaming }),
    }));
    const passthrough: Record<string, string> = {};
    for (const name of ['x-gateway-route', 'retry-after']) {
        const value = chat.headers.get(name);
        if (value) passthrough[name] = value;
    }
    if (!chat.ok) return c.json(await chat.json().catch(() => ({})), chat.status as ContentfulStatusCode, passthrough);
    if (!streaming) {
        return c.json(chatResponseToResponses(await chat.json() as Record<string, any>, routes, includeReasoning), 200, passthrough);
    }
    const responseId = `resp_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const model = typeof body.model === 'string' ? body.model : 'auto';
    return translatedStream(chat.body, new ResponsesStreamTranslator(responseId, model, routes, includeReasoning), passthrough);
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
    const requestId = requestIds.get(c.req.raw);
    if (requestId) headers.set('x-request-id', requestId);
    else if (c.req.header('x-api-key')) headers.set('authorization', `Bearer ${c.req.header('x-api-key')}`);
    const streaming = Boolean(body.stream);
    const includeThinking = body.thinking?.type === 'enabled';
    const requestedModel = typeof body.model === 'string' ? body.model : 'auto';
    const chat = await app.fetch(new Request(new URL('/api/chat/completions', c.req.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...anthropicToChatRequest(body), stream: streaming }),
    }));
    const passthrough: Record<string, string> = {};
    for (const name of ['x-gateway-route', 'retry-after']) {
        const value = chat.headers.get(name);
        if (value) passthrough[name] = value;
    }
    if (!chat.ok) {
        const payload = await chat.json().catch(() => ({})) as Record<string, any>;
        return c.json(anthropicError(chat.status, payload?.error?.message ?? 'Upstream error'), chat.status as ContentfulStatusCode, passthrough);
    }
    if (!streaming) {
        const payload = await chat.json() as Record<string, any>;
        return c.json(chatToAnthropicMessage(payload, requestedModel, includeThinking), 200, passthrough);
    }
    const translator = new AnthropicStreamTranslator(`msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, requestedModel, includeThinking);
    return translatedStream(chat.body, translator, passthrough);
}

app.post('/v1/messages', handleMessages);
app.post('/api/v1/messages', handleMessages);
app.post('/v1/messages/count_tokens', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json(anthropicError(400, 'Invalid JSON body'), 400);
    return c.json({ input_tokens: estimateInputTokens(body) });
});

let imageUpstream: ImageUpstream = qwenProvider;

export function setImageUpstream(upstream: ImageUpstream) {
    imageUpstream = upstream;
}

async function handleImages(c: Context, run: () => Promise<Record<string, unknown>>) {
    const startedAt = Date.now();
    try {
        const result = await run();
        logRequest({ provider: 'qwen', model: 'qwen-image', status: 'success', latencyMs: Date.now() - startedAt });
        return c.json(result);
    } catch (error) {
        const { status, type, message, retryAfterSeconds } = toHttpError(error);
        if (status !== 400) logRequest({ provider: 'qwen', model: 'qwen-image', status: 'error', latencyMs: Date.now() - startedAt, error: errorText(error) });
        if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
        return c.json({ error: { message, type } }, status);
    }
}

const imageGenerations = (c: Context) => handleImages(c, async () => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new ProviderError('Invalid JSON body', 'invalid_request');
    return generateImage(imageUpstream, body as Record<string, unknown>);
});
const imageEdits = (c: Context) => handleImages(c, () => editImage(imageUpstream, c.req.raw));

app.post('/v1/images/generations', imageGenerations);
app.post('/api/v1/images/generations', imageGenerations);
app.post('/v1/images/edits', imageEdits);
app.post('/api/v1/images/edits', imageEdits);

app.post('/v1/responses', handleResponses);
app.post('/api/v1/responses', handleResponses);

async function shutdown() {
    await browserChat?.close();
    process.exit(0);
}

export async function startUnifiedServer() {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    loadModelStatistics();
    await refreshModelLists();
    scheduleModelRefresh();
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

  Providers: deepseek qwen glm-chat kimi-chat (browser) nvidia (fallback)
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
