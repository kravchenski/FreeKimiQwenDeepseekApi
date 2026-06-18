import { Hono } from 'hono';
import { serve } from 'bun';
import crypto from 'crypto';

import { deepSeekCompletion, isEmptyToolCallResponse, parseDeepSeekEvent, fetchDeepSeekModels, getDeepSeekModels } from '../providers/deepseek/client.ts';
import { qwenCompletion as qwenWebCompletion, parseQwenEvent, fetchQwenModels as fetchQwenWebModels, getQwenModels as getQwenWebModels } from '../providers/qwen/client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from '../api/routes.ts';
import { kimiCompletion, parseKimiEvent } from '../providers/kimi/client.ts';
import { glmCompletion, parseGlmEvent } from '../providers/glm/client.ts';
import { sapiensCompletion, parseSapiensEvent } from '../providers/sapiens/client.ts';
import { stepfunCompletion, parseStepfunEvent } from '../providers/stepfun/client.ts';
import { nvidiaCompletion, parseNvidiaEvent } from '../providers/nvidia/client.ts';

const app = new Hono();
const port = Number(process.env.UNIFIED_PORT || 3260);
const host = process.env.HOST || '0.0.0.0';

let allModels: string[] = [];

async function refreshModelLists() {
    const [deepseek, qwen, kimi, glm, sapiens, stepfun, nvidia] = await Promise.allSettled([
        fetchDeepSeekModels(),
        fetchQwenWebModels(),
        Promise.resolve(['kimi-k2.7-code-free']),
        Promise.resolve(['glm-5.2-free', 'glm-4.7-flash-free', 'glm-4.6v-flash-free']),
        Promise.resolve(['sapiens-ai/agnes-2.0-flash']),
        Promise.resolve(['stepfun/step-3.7-flash-free']),
        Promise.resolve(['deepseek-ai/deepseek-v4-pro', 'nvidia/nemotron-3-ultra-550b-a55b']),
    ]);
    const ds = deepseek.status === 'fulfilled' ? deepseek.value : getDeepSeekModels();
    const qw = qwen.status === 'fulfilled' ? qwen.value : getQwenWebModels();
    const km = kimi.status === 'fulfilled' ? kimi.value : [];
    const gl = glm.status === 'fulfilled' ? glm.value : [];
    const sa = sapiens.status === 'fulfilled' ? sapiens.value : [];
    const st = stepfun.status === 'fulfilled' ? stepfun.value : [];
    const nv = nvidia.status === 'fulfilled' ? nvidia.value : [];
    allModels = [...ds, ...qw, ...km, ...gl, ...sa, ...st, ...nv];
}

function detectProvider(model: string): 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'sapiens' | 'stepfun' | 'nvidia' | 'unknown' {
    if (model.startsWith('deepseek-')) return 'deepseek';
    if (model.startsWith('qwen') || model.startsWith('qwq') || model.startsWith('qvq')) return 'qwen';
    if (model.startsWith('kimi-')) return 'kimi';
    if (model.startsWith('glm-')) return 'glm';
    if (model.startsWith('sapiens-ai/')) return 'sapiens';
    if (model.startsWith('stepfun/')) return 'stepfun';
    if (model.startsWith('nvidia/')) return 'nvidia';
    return 'unknown';
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

function createSSEResponse(
    id: string,
    created: number,
    model: string,
    captureToolCalls: boolean,
    combinedTools: Array<Record<string, any>> | null,
    messages: Array<Record<string, any>>,
    content: string,
    reasoning = ''
) {
    const encoder = new TextEncoder();
    const { toolCalls, conversationalText } = processToolCalls(content, captureToolCalls, combinedTools, messages);
    if (conversationalText) content = conversationalText;
    const chunks: string[] = [];

    if (toolCalls?.length) {
        for (const call of toolCalls) {
            chunks.push(streamChunk(id, created, model, {
                tool_calls: [{ index: call.index, id: call.id, type: call.type, function: call.function }]
            }));
        }
        chunks.push(streamChunk(id, created, model, {}, 'tool_calls'));
    } else {
        if (captureToolCalls && reasoning) {
            chunks.push(streamChunk(id, created, model, { reasoning_content: reasoning }));
        }
        if (captureToolCalls && content) {
            chunks.push(streamChunk(id, created, model, { content }));
        }
        chunks.push(streamChunk(id, created, model, {}, 'stop'));
    }
    chunks.push('data: [DONE]\n\n');
    return new Response(encoder.encode(chunks.join('')), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    });
}

async function collectDeepSeekResponse(response: Response, onEvent?: (event: Record<string, any>) => void) {
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

function collectKimiResponse(
    response: Response,
    _updateContext: any,
    onEvent?: (event: Record<string, any>) => void
) {
    return collectSseResponse(parseKimiEvent as any, response, onEvent);
}

function collectSseResponse(
    parseEvent: (line: string, state: any) => Record<string, any> | null,
    response: Response,
    onEvent?: (event: Record<string, any>) => void
) {
    const state = { contentSnapshot: '', reasoningSnapshot: '' };
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is empty');
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    let reasoning = '';

    return new Promise<{ content: string; reasoning: string }>(async (resolve, reject) => {
        try {
            while (true) {
                const { value, done } = await reader.read();
                pending += decoder.decode(value || new Uint8Array(), { stream: !done });
                const lines = pending.split('\n');
                pending = lines.pop() || '';
                for (const line of lines) {
                    const event = parseEvent(line.trim(), state);
                    if (event?.content) content += event.content;
                    if (event?.reasoning) reasoning += event.reasoning;
                    if (event) onEvent?.(event);
                }
                if (done) break;
            }
            resolve({ content, reasoning });
        } catch (err) {
            reject(err);
        }
    });
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

async function handleWebProviderStream(
    id: string,
    created: number,
    model: string,
    captureToolCalls: boolean,
    combinedTools: Array<Record<string, any>> | null,
    messages: Array<Record<string, any>>,
    response: Response,
    collectFn: (response: Response, onEvent?: (event: Record<string, any>) => void) => Promise<{ content: string; reasoning: string }>,
    retryFn?: () => Promise<Response>,
    extraMeta?: Record<string, any>
) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode(streamChunk(id, created, model, { role: 'assistant' })));

            let { content, reasoning } = await collectFn(response, event => {
                if (!captureToolCalls && event.content) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, { content: event.content })));
                }
                if (!captureToolCalls && event.reasoning) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: event.reasoning })));
                }
            });

            if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages) && retryFn) {
                ({ content, reasoning } = await collectFn(await retryFn()));
            }

            const { toolCalls, conversationalText } = processToolCalls(content, captureToolCalls, combinedTools, messages);
            if (conversationalText) content = conversationalText;

            if (toolCalls?.length) {
                for (const call of toolCalls) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, {
                        tool_calls: [{ index: call.index, id: call.id, type: call.type, function: call.function }]
                    })));
                }
                controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'tool_calls')));
            } else {
                if (captureToolCalls && reasoning) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: reasoning })));
                }
                if (captureToolCalls && content) {
                    controller.enqueue(encoder.encode(streamChunk(id, created, model, { content })));
                }
                controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'stop')));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });

    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    });
}

async function handleWebProviderNonStream(
    response: Response,
    collectFn: (response: Response) => Promise<{ content: string; reasoning: string }>,
    retryFn?: () => Promise<Response>,
    captureToolCalls?: boolean,
    combinedTools?: Array<Record<string, any>> | null,
    messages?: Array<Record<string, any>>
) {
    let { content, reasoning } = await collectFn(response);

    if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages || []) && retryFn) {
        ({ content, reasoning } = await collectFn(await retryFn()));
    }

    return { content, reasoning };
}

app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'unified' });
});

function ownedBy(id: string): string {
    if (id.startsWith('deepseek-')) return 'deepseek-web';
    if (id.startsWith('qwen') || id.startsWith('qwq') || id.startsWith('qvq')) return 'qwen-web';
    if (id.startsWith('kimi-')) return 'kimi-zenmux';
    if (id.startsWith('glm-')) return 'glm-zenmux';
    if (id.startsWith('sapiens-ai/')) return 'sapiens-zenmux';
    if (id.startsWith('stepfun/')) return 'stepfun-zenmux';
    if (id.startsWith('nvidia/')) return 'nvidia';
    return 'unknown';
}

app.get('/api/models', (c) => {
    return c.json({
        object: 'list',
        data: allModels.map(id => ({ id, object: 'model', created: 0, owned_by: ownedBy(id) }))
    });
});

app.get('/api/v1/models', (c) => {
    return c.json({
        object: 'list',
        data: allModels.map(id => ({ id, object: 'model', created: 0, owned_by: ownedBy(id) }))
    });
});

app.post('/api/chat/completions', async (c) => {
    try {
        const body = await c.req.json();
        const { messages, model = 'deepseek-default', stream = false, tools, functions } = body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: { message: 'messages must be a non-empty array' } }, 400);
        }

        const provider = detectProvider(model);
        if (provider === 'unknown') {
            return c.json({ error: { message: `Unknown model: ${model}. Available: deepseek-*, kimi-*, glm-*, sapiens/*, stepfun/*, qwen-*` } }, 400);
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

        // --- Web + ZenMux providers ---
        if (provider === 'deepseek') {
            const { response, sessionId } = await deepSeekCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) => collectDeepSeekResponse(r, cb);
            const retry = () => deepSeekCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(response, collect, retry, captureToolCalls, combinedTools, messages);
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
                x_deepseek_chat_id: sessionId
            });
        }

        if (provider === 'sapiens') {
            const result = await sapiensCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseSapiensEvent as any, r, cb);
            const retry = () => sapiensCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        if (provider === 'qwen') {
            const result = await qwenWebCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseQwenEvent as any, r, cb);
            const retry = () => qwenWebCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        if (provider === 'stepfun') {
            const result = await stepfunCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseStepfunEvent as any, r, cb);
            const retry = () => stepfunCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        if (provider === 'kimi') {
            const result = await kimiCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseKimiEvent as any, r, cb);
            const retry = () => kimiCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        if (provider === 'glm') {
            const result = await glmCompletion({ messages: upstreamMessages, model, conversationId });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseGlmEvent as any, r, cb);
            const retry = () => glmCompletion({ messages, model, conversationId }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        if (provider === 'nvidia') {
            const result = await nvidiaCompletion({ messages: upstreamMessages, model, stream });
            const collect = (r: Response, cb?: (e: Record<string, any>) => void) =>
                collectSseResponse(parseNvidiaEvent as any, r, cb);
            const retry = () => nvidiaCompletion({ messages, model, stream }).then(r => r.response);

            if (stream) {
                return handleWebProviderStream(id, created, model, captureToolCalls, combinedTools, messages, result.response, collect, retry);
            }
            const { content, reasoning } = await handleWebProviderNonStream(result.response, collect, retry, captureToolCalls, combinedTools, messages);
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
            });
        }

        return c.json({ error: { message: 'Unhandled provider' } }, 500);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: { message, type: 'upstream_error' } }, 502);
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
        data: allModels.map(id => ({ id, object: 'model', created: 0, owned_by: ownedBy(id) }))
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
  No API keys required — authenticate via browser.

  No API key required for OpenCode. Configure:
    OPENCODE_API_URL=http://${host === '0.0.0.0' ? 'localhost' : host}:${port}
    OPENCODE_API_KEY=
`);
}

if (import.meta.main) {
    startUnifiedServer().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
