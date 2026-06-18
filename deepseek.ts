import { Hono } from 'hono';
import { serve } from 'bun';
import crypto from 'crypto';

import { deepSeekCompletion, isEmptyToolCallResponse, parseDeepSeekEvent } from './src/providers/deepseek/client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from './src/api/routes.ts';
import { hasValidDeepSeekAccounts } from './src/providers/deepseek/accounts.ts';
import { runDeepSeekAccountMenu } from './src/providers/deepseek/auth.ts';

const app = new Hono();
const port = Number(process.env.DEEPSEEK_PORT || 3265);
const host = process.env.HOST || '0.0.0.0';
const models = ['deepseek-default', 'deepseek-reasoner', 'deepseek-expert', 'deepseek-search'];

function isCodebaseActionRequest(messages: Array<Record<string, any>>) {
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content.toLowerCase() : '';
    return /рефактор|исправ|измени|добав|удал|проверь|тест|review|refactor|implement|fix|change|inspect|test/.test(text);
}

function fallbackInspectionToolCall(tools: Array<Record<string, any>> | null) {
    if (!Array.isArray(tools)) return null;
    const names = new Set(tools.map(tool => (tool?.function || tool)?.name));
    if (names.has('ls')) return { name: 'ls', arguments: { path: '.' } };
    if (names.has('bash')) return { name: 'bash', arguments: { command: 'ls -la' } };
    if (names.has('find')) return { name: 'find', arguments: { path: '.', pattern: '*' } };
    return null;
}

async function collectResponse(response: Response, onEvent?: (event: Record<string, any>) => void) {
    const state = {
        phase: 'content' as const,
        fragment: undefined as string | undefined,
        contentSnapshot: '',
        thinkingSnapshot: ''
    };
    const reader = response.body?.getReader();
    if (!reader) throw new Error('DeepSeek returned an empty response body');
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    let reasoning = '';

    while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
            const event = parseDeepSeekEvent(line.trim(), state);
            if (event?.content) content += event.content;
            if (event?.reasoning) reasoning += event.reasoning;
            if (event) onEvent?.(event);
        }
        if (done) break;
    }
    return { content, reasoning };
}

function streamChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
    return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

app.get('/health', (c) => {
    const ready = hasValidDeepSeekAccounts() || Boolean(process.env.DEEPSEEK_TOKEN);
    return c.json({ status: ready ? 'ok' : 'unauthenticated', service: 'deepseek' }, ready ? 200 : 503);
});

app.get('/api/models', (c) => {
    return c.json({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'deepseek-web' })) });
});

app.get('/api/v1/models', (c) => {
    return c.json({ object: 'list', data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'deepseek-web' })) });
});

app.post('/api/chat/completions', async (c) => {
    try {
        const body = await c.req.json();
        const { messages, model = 'deepseek-default', stream = false, tools, functions } = body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: { message: 'messages must be a non-empty array' } }, 400);
        }
        const conversationId = body.conversation_id || body.chat_id || c.req.header('x-conversation-id') || undefined;
        const combinedTools = tools || (Array.isArray(functions) ? functions.map((fn: Record<string, unknown>) => ({ type: 'function', function: fn })) : null);
        const toolPrompt = toolsToPrompt(combinedTools);
        const upstreamMessages = toolPrompt ? [{ role: 'system', content: toolPrompt }, ...messages] : messages;
        const { response, sessionId } = await deepSeekCompletion({ messages: upstreamMessages, model, conversationId });
        const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);
        const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;

        if (stream) {
            const encoder = new TextEncoder();
            const readable = new ReadableStream({
                async start(controller) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, { role: 'assistant' })));
                    let { content, reasoning } = await collectResponse(response, event => {
                        if (!captureToolCalls && event.content) controller.enqueue(encoder.encode(streamChunk(id, created, model, { content: event.content })));
                        if (!captureToolCalls && event.reasoning) controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: event.reasoning })));
                    });
                    if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
                        const retry = await deepSeekCompletion({ messages, model, conversationId });
                        ({ content, reasoning } = await collectResponse(retry.response));
                    }
                    const recoveredShell = captureToolCalls ? recoverBrokenBashToolCall(content) : null;
                    const conversationalText = recoveredShell ? conversationalShellText(recoveredShell.name, recoveredShell.arguments) : null;
                    if (conversationalText) content = conversationalText;
                    let toolCalls = captureToolCalls && !conversationalText ? parseToolCallJson(content, combinedTools) : null;
                    if (!toolCalls?.length && captureToolCalls && isCodebaseActionRequest(messages)) {
                        const fallback = fallbackInspectionToolCall(combinedTools);
                        if (fallback) toolCalls = [{ id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, type: 'function', function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) }, index: 0 }];
                    }
                    if (toolCalls?.length) {
                        for (const call of toolCalls) controller.enqueue(encoder.encode(streamChunk(id, created, model, { tool_calls: [{ index: call.index, id: call.id, type: call.type, function: call.function }] })));
                        controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'tool_calls')));
                    } else {
                        if (captureToolCalls && reasoning) controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: reasoning })));
                        if (captureToolCalls && content) controller.enqueue(encoder.encode(streamChunk(id, created, model, { content })));
                        controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'stop')));
                    }
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            });
            return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
        }

        let { content, reasoning } = await collectResponse(response);
        if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
            const retry = await deepSeekCompletion({ messages, model, conversationId });
            ({ content, reasoning } = await collectResponse(retry.response));
        }
        const recoveredShell = captureToolCalls ? recoverBrokenBashToolCall(content) : null;
        const conversationalText = recoveredShell ? conversationalShellText(recoveredShell.name, recoveredShell.arguments) : null;
        if (conversationalText) content = conversationalText;
        let toolCalls = captureToolCalls && !conversationalText ? parseToolCallJson(content, combinedTools) : null;
        if (!toolCalls?.length && captureToolCalls && isCodebaseActionRequest(messages)) {
            const fallback = fallbackInspectionToolCall(combinedTools);
            if (fallback) toolCalls = [{ id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, type: 'function', function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) }, index: 0 }];
        }

        return c.json({
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message: toolCalls?.length ? { role: 'assistant', content: null, tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : { role: 'assistant', content, reasoning_content: reasoning || undefined }, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            x_deepseek_chat_id: sessionId
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: { message, type: 'upstream_error' } }, 502);
    }
});

app.post('/api/v1/chat/completions', async (c) => {
    return app.fetch(new Request(c.req.url.replace('/v1', ''), { method: 'POST', headers: c.req.raw.headers, body: c.req.raw.body }));
});

function enabled(value: string | undefined) {
    return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

async function start() {
    console.log(`\n=====================================================\n   FREE DEEPSEEK WEB API\n   Browser-backed proxy for https://chat.deepseek.com/\n=====================================================\n`);
    const skipMenu = enabled(process.env.SKIP_ACCOUNT_MENU) || enabled(process.env.NON_INTERACTIVE);
    if (skipMenu) {
        if (!hasValidDeepSeekAccounts() && !process.env.DEEPSEEK_TOKEN) throw new Error('Нет активных аккаунтов DeepSeek.');
    } else {
        await runDeepSeekAccountMenu();
    }
    serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
    console.log(`DeepSeek web proxy listening on http://${host}:${port}/api`);
    console.log('Models: deepseek-default, deepseek-reasoner, deepseek-expert, deepseek-search');
}

start().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
