import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from 'bun';
import crypto from 'crypto';

import { isEmptyToolCallResponse } from '../providers/deepseek/client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from '../api/routes.ts';
import { bearerToken, tokenMatches } from '../gateway/security.ts';
import type { ProviderStream } from '../core/providers/provider.ts';
import { ProviderRegistry, type ModelEntry } from '../core/providers/registry.ts';
import { collectChunks } from '../core/streaming/sse.ts';
import { toHttpError } from '../core/providers/errors.ts';
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
    if (tokenMatches(bearerToken(c.req.header('authorization')), apiKey)) return next();
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

let allModels: ModelEntry[] = [];

async function refreshModelLists() {
    allModels = await registry.listModels();
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
    retry: () => Promise<ProviderStream>
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
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    });
}

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

        const provider = registry.resolve(model);
        if (!provider) {
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

        const open = () => provider.stream({ model, messages: upstreamMessages, conversationId });
        const first = await open();

        if (stream) {
            return handleProviderStream(id, created, model, captureToolCalls, combinedTools, messages, first, open);
        }

        let { content, reasoning } = await collectChunks(first.chunks);
        let responseFields = first.responseFields;
        if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
            const retried = await open();
            ({ content, reasoning } = await collectChunks(retried.chunks));
            responseFields = retried.responseFields;
        }
        const { toolCalls, conversationalText } = processToolCalls(content, captureToolCalls, combinedTools, messages);
        return c.json({
            id, object: 'chat.completion', created, model,
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
