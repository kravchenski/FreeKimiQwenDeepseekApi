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
import { readLines } from '../core/streaming/sse.ts';
import type { ChatMessage, ProviderStream } from '../core/providers/provider.ts';
import { ProviderRegistry, type ModelEntry } from '../core/providers/registry.ts';
import { checkProviderModels } from '../core/models/model-check.ts';
import { DecisionLog } from '../core/router/decisions.ts';
import { compactToolResults } from '../core/agents/compact.ts';
import { decide, readDecisionRequest, type DecisionAnswer, type DecisionRequest } from '../core/decisions/engine.ts';
import { rankModels } from '../core/models/stats.ts';
import type { ImageProvider } from '../core/images/images.ts';
import { generateImages, listImageModels } from '../api/images.ts';
import { createCloudflareImages } from '../providers/images/cloudflare.ts';
import { createPollinationsImages } from '../providers/images/pollinations.ts';
import { createQwenChatImages } from '../providers/images/qwen-chat.ts';
import { collectChunks } from '../core/streaming/sse.ts';
import { ProviderError, toHttpError } from '../core/providers/errors.ts';
import { buildAutoChain } from '../core/router/auto-chain.ts';
import { focusPreference, type AutoFocus } from '../core/router/focus.ts';
import { GatewaySettings } from '../core/settings/gateway-settings.ts';
import { AUTO_MODEL, parseAutoModels, SmartRouter, type Route } from '../core/router/smart-router.ts';
import { conversationKey, SessionAffinity } from '../core/router/session-affinity.ts';
import { listBrowserProfiles, loadGatewaySetting, loadModelStats, loadWebChatModels, saveWebChatModels, loadUnavailableModels, replaceUnavailableModels, loadProviderSetting, loadSignIn, saveGatewaySetting, saveProviderSetting, openDatabase, recordRequest, saveModelStat, saveSignIn, type RequestLog } from '../core/store/database.ts';
import { WebSignInStatus } from '../core/accounts/sign-in-status.ts';
import { ProviderSettings } from '../core/providers/settings.ts';
import { WEB_CHAT_SITES } from '../providers/web-chat-sites.ts';
import { parseQwenStream, QWEN_CHAT_SITE } from '../providers/qwen/web.ts';
import { gatewayStatus } from '../core/status.ts';
import { Metrics, requestIdFrom } from '../observability/metrics.ts';
import type { Database } from 'bun:sqlite';
import { API_KEY_PROVIDERS, apiKeyProvider, createApiProvider, createNvidiaProvider, defaultAuto, forgetSavedKeys, FREE_API_PROVIDERS } from '../providers/catalog.ts';
import { openCredentialStore, savedApiKey } from '../core/accounts/credential-store.ts';
import { loadAccountsSecret } from '../core/secrets/accounts-secret.ts';
import { createDeepSeekProvider } from '../providers/deepseek/provider.ts';
import { BrowserChatSession, notSignedIn, type ChatSite, type WebChatModel } from '../browser/browser-chat.ts';
import { listProfiles, profileDir } from '../browser/profiles.ts';
import { ProfileRotation } from '../core/accounts/profile-rotation.ts';
import { DEFAULT_PROFILE } from '../core/accounts/sign-in-status.ts';
import { ARENA_CHAT_SITE, parseArenaStream } from '../providers/arena/web.ts';
import { createBrowserChatProvider, type BrowserChatProviderConfig } from '../providers/browser-chat-provider.ts';
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

const credentialStore = openCredentialStore();

export const registry = new ProviderRegistry()
    .register(createNvidiaProvider({}, credentialStore))
    .register(createDeepSeekProvider());

for (const definition of FREE_API_PROVIDERS) registry.register(createApiProvider(definition, {}, credentialStore));

const browserSessions = new Map<string, BrowserChatSession>();
const signIns = new WebSignInStatus({
    load: (provider, profile) => loadSignIn(db(), provider, profile),
    save: record => saveSignIn(db(), record),
});

const PROFILE_CACHE_MS = 30_000;
let profileCache: { ids: string[]; readAt: number } | undefined;
function accountProfiles() {
    if (profileCache && Date.now() - profileCache.readAt < PROFILE_CACHE_MS) return profileCache.ids;
    let ids = [DEFAULT_PROFILE];
    try {
        ids = listProfiles({ list: () => listBrowserProfiles(db()) }).map(profile => profile.id);
    } catch (error) {
        console.error('Accounts unavailable:', errorText(error));
    }
    profileCache = { ids, readAt: Date.now() };
    return ids;
}

let webChatModels: Map<string, WebChatModel[]> | undefined;

function webChatModelsFor(site: string) {
    if (!webChatModels) {
        try {
            webChatModels = loadWebChatModels(db());
        } catch (error) {
            console.error('Web chat models unavailable:', errorText(error));
            webChatModels = new Map();
        }
    }
    return webChatModels.get(site);
}

function rememberWebChatModels(site: string, models: WebChatModel[]) {
    if (JSON.stringify(webChatModelsFor(site)) === JSON.stringify(models)) return;
    webChatModels!.set(site, models);
    try {
        saveWebChatModels(db(), site, models);
    } catch (error) {
        console.error('Failed to save web chat models:', errorText(error));
    }
    refreshModelLists().catch(error => console.error('Model list refresh failed:', errorText(error)));
}

function browserSession(profile: string) {
    let session = browserSessions.get(profile);
    if (!session) {
        session = new BrowserChatSession({
            profileDir: profileDir(profile),
            onSignIn: (siteId, result) => {
                const site = WEB_CHAT_SITES.find(entry => entry.id === siteId);
                signIns.record(siteId, result.signedIn, result.signedIn || !site ? undefined : notSignedIn(site, result), profile);
            },
            onModels: rememberWebChatModels,
        });
        browserSessions.set(profile, session);
    }
    return session;
}

const rotation = new ProfileRotation(accountProfiles, signIns);

function registerWebChat(id: string, ownedBy: string, site: ChatSite, parse: BrowserChatProviderConfig['parse']) {
    registry.register(createBrowserChatProvider({
        id,
        ownedBy,
        model: id,
        site,
        parse,
        sessions: () => rotation.order(id).map(profile => ({ profile, session: browserSession(profile) })),
        health: () => signIns.health(id, accountProfiles()),
        onResult: (profile, ok) => ok ? rotation.succeeded(id, profile) : rotation.failed(id, profile),
        models: () => webChatModelsFor(site.id),
    }));
}

registerWebChat('qwen-chat', 'qwen-web', QWEN_CHAT_SITE, parseQwenStream);
registerWebChat('glm-chat', 'z-ai-web', ZAI_CHAT_SITE, parseZaiStream);
registerWebChat('kimi-chat', 'kimi-web', KIMI_CHAT_SITE, parseKimiStream);
registerWebChat('arena-chat', 'arena-web', ARENA_CHAT_SITE, parseArenaStream);

const providerSettings = new ProviderSettings({
    load: provider => loadProviderSetting(db(), provider),
    save: setting => saveProviderSetting(db(), setting),
}, Date.now, defaultAuto);

const gatewaySettings = new GatewaySettings({
    load: key => loadGatewaySetting(db(), key),
    save: (key, value) => saveGatewaySetting(db(), key, value),
});

const decisions = new DecisionLog();

export const router = new SmartRouter(registry, parseAutoModels(config.AUTO_MODELS), Date.now, {
    onDecision: decision => decisions.add(decision),
    choose: (prompt, routes) => chooseRoute(prompt, routes),
    firstChunkTimeoutMs: config.AUTO_FIRST_CHUNK_TIMEOUT_MS,
    autoEnabled: provider => providerSettings.autoEnabled(provider),
    autoMode: () => gatewaySettings.autoMode(),
    prepareAuto: () => {
        if (gatewaySettings.autoFocus() !== chainFocus) rebuildAutoChain();
    },
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

let chainFocus: AutoFocus | undefined;

function rebuildAutoChain() {
    if (config.AUTO_MODELS) return;
    chainFocus = gatewaySettings.autoFocus();
    const candidates = allModels.flatMap(entry => {
        const provider = registry.resolve(entry.id);
        return provider ? [{ id: entry.id, provider: provider.id, fallback: provider.fallback ?? false }] : [];
    });
    router.setAutoModels(buildAutoChain(candidates, registry.stats, model => registry.availability.isAvailable(model), focusPreference(chainFocus)));
}

function loadModelStatistics() {
    try {
        registry.stats.load(loadModelStats(db()));
        registry.availability.load(loadUnavailableModels(db()));
    } catch (error) {
        console.error('Model statistics unavailable:', errorText(error));
    }
}

registry.availability.onChange(() => {
    try {
        replaceUnavailableModels(db(), registry.availability.list());
    } catch (error) {
        console.error('Failed to save unavailable models:', errorText(error));
    }
    rebuildAutoChain();
});
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

const AVAILABILITY_CHECK_MS = 30_000;
const MODEL_CHECK_TIMEOUT_MS = 30_000;

function providerAvailability() {
    return registry.list().map(provider => `${provider.id}:${provider.health().available}`).join(',');
}

function scheduleModelRefresh() {
    const refresh = () => refreshModelLists().catch(error => console.error('Model list refresh failed:', errorText(error)));
    let availability = providerAvailability();
    setInterval(() => {
        const next = providerAvailability();
        if (next === availability) return;
        availability = next;
        refresh();
    }, AVAILABILITY_CHECK_MS).unref();
    if (config.MODEL_REFRESH_MINUTES) setInterval(refresh, config.MODEL_REFRESH_MINUTES * 60_000).unref();
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

app.post('/v1/gateway/providers/:id/check', async (c) => {
    const provider = registry.list().find(entry => entry.id === c.req.param('id'));
    if (!provider) return c.json({ error: { message: 'Unknown provider', type: 'invalid_request_error' } }, 404);
    forgetSavedKeys();
    const health = provider.health();
    if (!health.available) return c.json({ error: { message: health.reason ?? 'Provider is not available', type: 'provider_unavailable' } }, 409);
    const models = await provider.listModels();
    const report = await checkProviderModels(provider, models, registry, { timeoutMs: MODEL_CHECK_TIMEOUT_MS });
    await refreshModelLists();
    return c.json(report);
});

app.post('/v1/gateway/refresh', async (c) => {
    forgetSavedKeys();
    await refreshModelLists();
    return c.json({
        models: allModels.length - 1,
        providers: registry.list().map(provider => ({ id: provider.id, ...provider.health() })),
    });
});

app.get('/v1/gateway/status', (c) => c.json({
    ...gatewayStatus(registry, db()),
    autoModels: router.autoChain(),
    autoFocus: gatewaySettings.autoFocus(),
    autoMode: gatewaySettings.autoMode(),
    modelStats: registry.stats.list(),
    models: allModels.flatMap(entry => {
        const provider = registry.resolve(entry.id);
        return provider ? [{ id: entry.id, provider: provider.id }] : [];
    }),
}));

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
        const compaction = gatewaySettings.agentOption('compact') ? compactToolResults(messages) : undefined;
        const agentMessages = compaction?.messages ?? messages;
        const upstreamMessages = toolPrompt
            ? [{ role: 'system', content: toolPrompt }, ...agentMessages]
            : agentMessages;
        const details = compaction?.stats.results ? { compaction: compaction.stats } : undefined;
        const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);
        const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;

        const startedAt = Date.now();
        const sessionKey = model === AUTO_MODEL ? conversationId ?? conversationKey(messages) : undefined;
        const sessions = sessionKey ? affinity() : undefined;
        const pinned = sessionKey ? sessions?.get(sessionKey, AUTO_MODEL) : undefined;
        const first = await router.open(model, route => ({ model: route.model, messages: upstreamMessages, conversationId }), pinned?.model, details)
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
        const routeHeaders: Record<string, string> = {
            'x-gateway-route': `${provider.id}/${routedModel}`,
            ...(details ? { 'x-gateway-compacted': `${details.compaction.charsBefore}->${details.compaction.charsAfter}` } : {}),
        };

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
        for (const [name, value] of Object.entries(routeHeaders)) c.header(name, value);
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

const imageProviders: ImageProvider[] = [
    createQwenChatImages(
        () => rotation.order('qwen-chat').map(profile => ({ profile, session: browserSession(profile) })),
        () => signIns.health('qwen-chat', accountProfiles()).available,
    ),
    createCloudflareImages(apiKeyProvider('cloudflare')!, () => process.env.CLOUDFLARE_API_KEY || savedApiKey(credentialStore, 'cloudflare')),
    createPollinationsImages(),
];

const DECISION_TIMEOUT_MS = 15_000;
const DECISION_CANDIDATES = 3;
const QUICK_DECISION_MS = 8_000;
const STRONG_DECIDER = /gpt-oss[-:]?120b|nemotron-3-(?:super|ultra)|gemma-?4|llama-3\.3-70b|qwen3|deepseek|glm|kimi/i;
const WEAK_DECIDER = /nano|mini|small|lite|tiny|vision|calibration|guard|safety|\b(?:[1-9]|1[0-4])b\b|-(?:[1-9]|1[0-4])b\b/i;
const deciderRank = (model: string) => WEAK_DECIDER.test(model) ? 2 : STRONG_DECIDER.test(model) ? 0 : 1;
const CHOOSE_OPTIONS = 16;

function decisionModels(requested?: string) {
    if (requested && requested !== AUTO_MODEL && registry.resolve(requested)) return [requested];
    const api = visibleModels().map(entry => entry.id).filter(id => {
        const provider = registry.resolve(id);
        return Boolean(provider?.fallback && provider.health().available);
    });
    const quick = api
        .map(model => ({ model, latency: registry.stats.get(model)?.lastOutcome === 'success' ? registry.stats.get(model)?.latencyMs : undefined }))
        .filter((entry): entry is { model: string; latency: number } => entry.latency !== undefined && entry.latency <= QUICK_DECISION_MS)
        .sort((a, b) => deciderRank(a.model) - deciderRank(b.model) || a.latency - b.latency)
        .map(entry => entry.model);
    return (quick.length ? quick : rankModels(api, registry.stats)).slice(0, DECISION_CANDIDATES);
}

async function completeDecision(messages: ChatMessage[], read: (text: string) => Record<string, DecisionAnswer>, requested?: string) {
    const failures: string[] = [];
    for (const model of decisionModels(requested)) {
        try {
            const opened = await router.open(model, route => ({ model: route.model, messages }));
            const signal = AbortSignal.timeout(DECISION_TIMEOUT_MS);
            const result = await Promise.race([
                collectChunks(opened.chunks),
                new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error(`no answer within ${DECISION_TIMEOUT_MS / 1000}s`)), { once: true })),
            ]);
            return { answers: read(result.content), model: opened.route.model };
        } catch (error) {
            failures.push(`${model}: ${errorText(error)}`);
        }
    }
    throw new ProviderError(failures.length ? `No decision model answered: ${failures.join('; ')}` : 'No API model is available for decisions', 'unavailable', 503);
}

function describeRoute(route: Route) {
    const stat = registry.stats.get(route.model);
    const traits = (['coding', 'reasoning', 'fast'] as const).filter(focus => focusPreference(focus)(route.model) > 0);
    const size = /(\d+(?:\.\d+)?)b\b/i.exec(route.model.replace(/-a\d+(?:\.\d+)?b\b/i, ''))?.[1];
    return [
        route.provider.fallback ? `${route.model} through the ${route.provider.id} API` : `${route.model}: a flagship model in the ${route.provider.id} web chat, strong but slower`,
        size ? `about ${size}B parameters` : undefined,
        traits.length ? `good for ${traits.join(', ')}` : undefined,
        stat?.latencyMs !== undefined ? `first answer in about ${(stat.latencyMs / 1000).toFixed(1)}s` : undefined,
    ].filter(Boolean).join('; ');
}

async function chooseRoute(prompt: string, routes: Route[]) {
    const options = routes.slice(0, CHOOSE_OPTIONS);
    const request: DecisionRequest = {
        state: { request: prompt.slice(0, 4_000) },
        questions: {
            which: {
                type: 'choice',
                instructions: 'Which model should answer this request? For coding, reasoning, analysis or long writing pick a large, strong model (a flagship web chat or an API model well above 30B parameters). Pick a small fast model only for a greeting or a trivial one-line answer.',
                criteria: Object.fromEntries(options.map(route => [route.model, describeRoute(route)])),
            },
        },
    };
    const { answers } = await decide(request, (messages, read) => completeDecision(messages, read));
    const answer = answers.which;
    return answer && 'choice' in answer ? answer.choice : undefined;
}

async function handleDecision(c: Context) {
    let request: DecisionRequest;
    try {
        request = readDecisionRequest(await c.req.json());
    } catch (error) {
        const { status, type, message } = toHttpError(error instanceof SyntaxError ? new ProviderError('Invalid JSON body', 'invalid_request', 400) : error);
        return c.json({ error: { message, type } }, status as ContentfulStatusCode);
    }
    try {
        const { model, answers } = await decide(request, (messages, read) => completeDecision(messages, read, request.model));
        return c.json({ id: `decision-${crypto.randomUUID()}`, object: 'decision', model, answers });
    } catch (error) {
        const { status, type, message } = toHttpError(error);
        return c.json({ error: { message, type } }, status as ContentfulStatusCode);
    }
}

app.post('/v1/decisions', handleDecision);
app.post('/v1/systemone', handleDecision);

app.get('/v1/gateway/decisions', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    return c.json({ object: 'list', data: decisions.list(limit, c.req.query('model') || undefined) });
});

app.get('/v1/images/models', async (c) => {
    const models = await listImageModels(imageProviders);
    return c.json({ object: 'list', data: models.map(({ id, ownedBy }) => ({ id, object: 'model', created: 0, owned_by: ownedBy })) });
});

app.post('/v1/images/generations', async (c) => {
    let body: Record<string, unknown>;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
    }
    try {
        return c.json(await generateImages(imageProviders, body, attempt => logRequest({
            provider: attempt.provider,
            model: attempt.model,
            status: attempt.ok ? 'success' : 'error',
            latencyMs: attempt.latencyMs,
            ...(attempt.error ? { error: attempt.error.slice(0, 500) } : {}),
        })));
    } catch (error) {
        const { status, type, message } = toHttpError(error);
        return c.json({ error: { message, type } }, status as ContentfulStatusCode);
    }
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

app.post('/v1/responses', handleResponses);
app.post('/api/v1/responses', handleResponses);

async function shutdown() {
    await Promise.all([...browserSessions.values()].map(session => session.close()));
    process.exit(0);
}

export async function startUnifiedServer() {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await loadAccountsSecret();
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

  Providers: deepseek ${WEB_CHAT_SITES.map(site => site.id).join(' ')} (browser); ${API_KEY_PROVIDERS.map(provider => provider.id).join(' ')} (API keys, fallback)
  API providers need a key in .env or: bun run account add <provider> --api-key

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
