import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { sendMessage, getAllModels, createChatV2, pollQwenTaskStatus, extractMediaUrl, pagePool, extractAuthToken } from './chat.ts';
import { getAuthenticationStatus, getBrowserContext } from '../browser/browser.ts';
import { checkAuthentication } from '../browser/auth.ts';
import { logInfo, logError, logDebug } from '../logger/index.ts';
import { getMappedModel } from './modelMapping.ts';
import { getStsToken, uploadFileToQwen } from './fileUpload.ts';
import { loadHistory, saveHistory } from './chatHistory.ts';
import { generateImage, getAvailableImageModels, checkImageApiAvailability } from './imageGeneration.ts';
import { MAX_FILE_SIZE, UPLOADS_DIR, DEFAULT_MODEL, STREAMING_CHUNK_DELAY, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from '../config.ts';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { listTokens, markInvalid, markRateLimited, markValid } from './tokenManager.ts';
import { FORGETMEAI_WATERMARK } from '../utils/branding.ts';
import { normalizeToolDefinitions, parseToolCallJson, toolsToPrompt } from '../core/tools/tool-calls.ts';

function generateChatIdFromHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    const realMessages = messages.filter(m => {
        if (m.role !== 'user') return true;
        const content = typeof m.content === 'string' ? m.content : '';
        return !content.startsWith('### Task:') && !content.startsWith('History:');
    });

    const messagesToUse = realMessages.length > 0 ? realMessages : messages;

    const userMessages = messagesToUse
        .filter(m => m.role === 'user')
        .slice(0, 1)
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('||');

    if (!userMessages) return null;

    const hash = crypto
        .createHash('sha256')
        .update(userMessages)
        .digest('hex')
        .substring(0, 16);

    return `chat_${hash}`;
}

export function buildConversationScopeFromHistory(messages) {
    const chatId = generateChatIdFromHistory(messages);
    return chatId ? `history:${chatId}` : null;
}

function normalizeIdValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;

    return trimmed;
}

function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdValue(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function buildInternalChatIdFromHint(hint) {
    const normalizedHint = normalizeIdValue(hint);
    if (!normalizedHint) return null;

    const hash = crypto
        .createHash('sha256')
        .update(`client-conversation:${normalizedHint}`)
        .digest('hex')
        .substring(0, 16);

    return `chat_${hash}`;
}

function extractConversationHint(c) {
    const body = c._body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        c.req.header('x-conversation-id'),
        c.req.header('x-openwebui-conversation-id'),
        c.req.header('x-chat-id'),
        c.req.header('x-openwebui-chat-id')
    ]);
}

function extractParentHint(c) {
    const body = c._body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        c.req.header('x-parent-id'),
        c.req.header('x-openwebui-parent-id')
    ]);
}

function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldForceNewChat(c) {
    const body = c._body || {};

    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        c.req.header('x-new-chat'),
        c.req.header('x-reset-chat')
    ].some(isTruthyFlag);
}

function shouldPersistSessionContext(scope = null) {
    const normalizedScope = normalizeIdValue(scope);
    return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

const chatIdMap = new Map();

function mapChatId(generatedId, qwenChatId) {
    if (generatedId) {
        chatIdMap.set(generatedId, qwenChatId);
        logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
    }
}

function getChatIdFromMap(generatedId) {
    return generatedId ? chatIdMap.get(generatedId) : null;
}

async function resolveQwenChatId(effectiveChatId, mappedModel) {
    let qwenChatId = effectiveChatId;
    const mapped = getChatIdFromMap(effectiveChatId);

    if (mapped) {
        qwenChatId = mapped;
        logInfo(`🔁 Используется сопоставленный Qwen chatId: ${qwenChatId} (from ${effectiveChatId})`);
        return qwenChatId;
    }

    if (effectiveChatId && effectiveChatId.startsWith('chat_')) {
        try {
            const created = await createChatV2(mappedModel, 'Сессия OpenWebUI');
            if (created && created.chatId) {
                mapChatId(effectiveChatId, created.chatId);
                qwenChatId = created.chatId;
                logInfo(`🔨 Создан Qwen chat ${qwenChatId} и привязан к ${effectiveChatId}`);
            }
        } catch (error) {
            logDebug(`Не удалось создать Qwen chat для ${effectiveChatId}: ${error.message}`);
        }
    }

    return qwenChatId;
}
import { testToken } from './chat.ts';

function isOpenWebUiMetaRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const lastUserMessage = messages.filter(m => m && m.role === 'user').pop();
    if (!lastUserMessage) return false;

    const content = lastUserMessage.content;
    if (Array.isArray(content)) return false;
    if (typeof content !== 'string') return false;

    const text = content.trimStart();

    if (text.startsWith('### Task:')) return true;
    if (text.startsWith('History:')) return true;

    if (text.includes('<chat_history>') && text.includes('### Task:')) return true;

    return false;
}

const sessionToChatMap = new Map();

function getSessionKey(c) {
    const ip = c.req.header('x-forwarded-for') || 'unknown';
    const userAgent = c.req.header('user-agent') || 'unknown';
    return crypto.createHash('sha256').update(`${ip}||${userAgent}`).digest('hex');
}

function getScopedSessionKey(c, scope = null) {
    const baseKey = getSessionKey(c);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

function getSavedChatId(c, scope = null) {
    const keysToTry = [getScopedSessionKey(c, scope)];

    for (const sessionKey of keysToTry) {
        const sessionData = sessionToChatMap.get(sessionKey);
        if (sessionData && (Date.now() - sessionData.timestamp) < 3600000) {
            return sessionData;
        }
    }

    return null;
}
function saveChatIdForSession(c, chatId, parentId, scope = null) {
    const sessionKey = getScopedSessionKey(c, scope);
    const normalizedScope = normalizeIdValue(scope);

    sessionToChatMap.set(sessionKey, {
        chatId,
        parentId,
        scope: normalizedScope,
        timestamp: Date.now()
    });

    const scopeSuffix = normalizedScope ? ` (scope=${normalizedScope})` : "";
    logDebug(`Saved chatId ${chatId} for session ${sessionKey.substring(0, 8)}${scopeSuffix}`);
}
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    let cleaned = 0;
    for (const [key, value] of sessionToChatMap.entries()) {
        if (value.timestamp < oneHourAgo) {
            sessionToChatMap.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        logDebug(`Очищено ${cleaned} старых сессий`);
    }
}, 600000);

const app = new Hono();


async function removeUploadedFile(filePath) {
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        logDebug(`Не удалось удалить временный файл: ${error.message}`);
    }
}

async function saveUploadedFile(file: File): Promise<string> {
    const uploadDir = path.join(process.cwd(), UPLOADS_DIR);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const originalName = path.basename(file.name || 'upload')
        .normalize('NFKC')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(-120);
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${originalName || 'upload'}`;
    const filePath = path.join(uploadDir, filename);
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    return filePath;
}

function parseOpenAIMessages(messages) {
    const systemMsg = messages.find(msg => msg.role === 'system');
    const systemMessage = systemMsg ? systemMsg.content : null;
    const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();

    if (!lastUserMessage) {
        return { messageContent: null, systemMessage };
    }

    let messageContent = lastUserMessage.content;

    if (Array.isArray(messageContent)) {
        messageContent = messageContent.map(item => {
            if (item.type === 'text') {
                return { type: 'text', text: item.text };
            } else if (item.type === 'image_url' && item.image_url) {
                return { type: 'image', image: item.image_url.url };
            } else if (item.type === 'image') {
                return { type: 'image', image: item.image };
            }
            return item;
        });
    }

    return { messageContent, systemMessage };
}

function buildCombinedTools(tools, functions, toolChoice) {
    const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
    return { combinedTools: normalizeToolDefinitions(combinedTools), toolChoice };
}

function stringifyOpenAIContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return `[image: ${item.image_url?.url || ''}]`;
            if (item.type === 'image') return `[image: ${item.image || ''}]`;
            if (item.type === 'file') return `[file: ${item.file || item.name || ''}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join('\n');
    }
    return JSON.stringify(content);
}

function buildStatelessTranscript(messages) {
    const parts = [];
    for (const msg of messages || []) {
        if (!msg || msg.role === 'system') continue;
        if (msg.role === 'user') {
            parts.push(`User: ${stringifyOpenAIContent(msg.content)}`);
        } else if (msg.role === 'assistant') {
            const text = stringifyOpenAIContent(msg.content);
            if (text) parts.push(`Assistant: ${text}`);
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                parts.push(`Assistant tool calls: ${JSON.stringify(msg.tool_calls)}`);
            }
        } else if (msg.role === 'tool') {
            const name = msg.name || msg.tool_call_id || 'tool';
            parts.push(`Tool result (${name}): ${stringifyOpenAIContent(msg.content)}`);
        } else {
            parts.push(`${msg.role || 'message'}: ${stringifyOpenAIContent(msg.content)}`);
        }
    }
    return parts.join('\n\n');
}


function hasOpenAIToolState(messages) {
    return (messages || []).some(msg =>
        msg?.role === 'tool' ||
        msg?.role === 'function' ||
        (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
        (msg?.role === 'assistant' && msg.function_call)
    );
}

function shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId) {
    const nonSystemMessages = (messages || []).filter(msg => msg && msg.role !== 'system');
    if (nonSystemMessages.length === 0) return false;

    if (hasOpenAIToolState(messages)) return true;

    if (!effectiveChatId && nonSystemMessages.length > 1) return true;

    if (Array.isArray(combinedTools) && combinedTools.length > 0 && nonSystemMessages.length > 1) return true;

    return false;
}

function prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId) {
    const lastUserMessage = (messages || []).filter(msg => msg && msg.role === 'user').pop();
    if (shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId)) {
        return {
            messageContent: buildStatelessTranscript(messages),
            files: lastUserMessage?.files || [],
            folded: true,
            missingUser: false
        };
    }

    if (!lastUserMessage) {
        return { messageContent: null, files: [], folded: false, missingUser: true };
    }

    return {
        messageContent: lastUserMessage.content,
        files: lastUserMessage.files || [],
        folded: false,
        missingUser: false
    };
}

function applyToolPrompt(systemMessage, tools) {
    const prompt = toolsToPrompt(tools);
    return prompt ? `${systemMessage || ''}${prompt}`.trim() : systemMessage;
}

function buildOpenAIToolResponse(result, mappedModel, toolCalls) {
    return {
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || 'qwen-max-latest',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.map(({ index, ...call }) => call)
            },
            finish_reason: 'tool_calls'
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId || result.response_id,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId || result.response_id
    };
}

function writeToolCallsSse(res, mappedModel, result, toolCalls) {
    const base = {
        id: result.id || 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || 'qwen-max-latest'
    };
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }) + '\n\n');
    for (const call of toolCalls) {
        res.write('data: ' + JSON.stringify({
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: call.index,
                        id: call.id,
                        type: 'function',
                        function: call.function
                    }]
                },
                finish_reason: null
            }]
        }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }) + '\n\n');
    streamWriter.write('data: [DONE]\n\n');
    streamWriter.close();
}

app.post('/chat', async (c) => {
    try {
        const body = await c.req.json();
        c._body = body;
        const { message, messages, model, chatId, parentId, stream, chatType, size, waitForCompletion } = body;

        let messageContent = message;
        let systemMessage = null;
        let allMessages = messages;
        const isMeta = isOpenWebUiMetaRequest(messages);

        if (messages && Array.isArray(messages)) {
            const parsed = parseOpenAIMessages(messages);
            systemMessage = parsed.systemMessage;
            if (parsed.messageContent) messageContent = parsed.messageContent;
        }

        if (!messageContent) {
            logError('Запрос без сообщения');
            return c.json({ error: 'Сообщение не указано' }, 400);
        }

        logInfo(`Получен запрос: ${typeof messageContent === 'string' ? messageContent.substring(0, 50) + (messageContent.length > 50 ? '...' : '') : 'Составное сообщение'}`);
        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }
        if (chatId && !isMeta) {
            logInfo(`Используется chatId: ${chatId}, parentId: ${parentId || 'null'}`);
        } else if (isMeta) {
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }
        if (allMessages && allMessages.length > 1) {
            logInfo(`История содержит ${allMessages.length} сообщений`);
        }

        let mappedModel = model || "qwen-max-latest";
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
        }
        logInfo(`Используется модель: ${mappedModel}`);

        if (stream) {
            return stream(c, async (streamWriter) => {
                const writeSse = (payload) => {
                    streamWriter.write('data: ' + JSON.stringify(payload) + '\n\n');
                };

                try {
                    let streamingCallback = null;
                    let hasStreamedChunks = false;
                    if (stream) {
                        streamingCallback = (chunk) => {
                            hasStreamedChunks = true;
                            writeSse({
                                id: 'chatcmpl-' + Date.now(),
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: mappedModel || 'qwen-max-latest',
                                choices: [
                                    { index: 0, delta: { content: chunk }, finish_reason: null }
                                ]
                            });
                        };
                    }

                    const result = await sendMessage(
                        messageContent,
                        mappedModel,
                        isMeta ? null : chatId,
                        isMeta ? null : parentId,
                        null,
                        null,
                        null,
                        systemMessage,
                        't2t',
                        null,
                        true,
                        0,
                        streamingCallback
                    );

                    if (result.error) {
                        writeSse({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                            ]
                        });
                    } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                        const content = result.choices[0].message.content;
                        logDebug(`JSON response content length: ${content.length}`);
                        if (typeof streamingCallback === 'function') {
                            streamingCallback(content);
                        } else {
                            writeSse({
                                id: 'chatcmpl-stream',
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: mappedModel || 'qwen-max-latest',
                                choices: [
                                    { index: 0, delta: { content }, finish_reason: null }
                                ]
                            });
                        }
                    } else {
                        logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                    }

                    writeSse({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: {}, finish_reason: 'stop' }
                        ]
                    });
                    streamWriter.write('data: [DONE]\n\n');
                } catch (error) {
                    logError('Ошибка при обработке потокового запроса', error);
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                        ]
                    });
                    streamWriter.write('data: [DONE]\n\n');
                }
            });
        }

            const result = await sendMessage(messageContent, mappedModel, isMeta ? null : chatId, isMeta ? null : parentId, null, null, null, systemMessage, chatType || 't2t', size || null, waitForCompletion ?? true);

        if (result.choices && result.choices[0] && result.choices[0].message) {
            const responseLength = result.choices[0].message.content ? result.choices[0].message.content.length : 0;
            logInfo(`Ответ успешно сформирован для запроса, длина ответа: ${responseLength}`);

            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const updatedMessages = allMessages || [
                        { role: 'user', content: messageContent },
                        { role: 'assistant', content: result.choices[0].message.content }
                    ];
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }
        } else if (result.error) {
            logInfo(`Получена ошибка в ответе: ${result.error}`);
        }

        return c.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/health', async (c) => {
    try {
        const modelData = getAllModels();
        const tokens = listTokens();
        const now = Date.now();
        const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;

        return c.json({
            ok: availableAccounts > 0,
            service: 'FreeQwenApi',
            watermark: FORGETMEAI_WATERMARK,
            baseUrl: '/api',
            models: modelData.models.length,
            accounts: {
                total: tokens.length,
                available: availableAccounts,
                invalid: tokens.filter(t => t.invalid).length,
                waiting: tokens.filter(t => t.resetAt && new Date(t.resetAt).getTime() > now).length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logError('Ошибка health check', error);
        return c.json({ ok: false, error: 'Health-проверка не удалась' }, 500);
    }
});

app.get('/models', async (c) => {
    try {
        logInfo('Запрос на получение списка моделей');
        const modelsRaw = getAllModels();
        const openAiModels = {
            object: 'list',
            data: modelsRaw.models.map(m => ({
                id: m.id || m.name || m,
                object: 'model',
                created: 0,
                owned_by: 'qwen',
                permission: []
            }))
        };
        logInfo(`Возвращено ${openAiModels.data.length} моделей (OpenAI формат)`);
        return c.json(openAiModels);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/status', async (c) => {
    try {
        logInfo('Запрос статуса авторизации');
        const tokens = listTokens();
        const accounts = await Promise.all(tokens.map(async t => {
            const accInfo = { id: t.id, status: 'UNKNOWN', resetAt: t.resetAt || null };

            if (t.resetAt) {
                const resetTime = new Date(t.resetAt).getTime();
                if (resetTime > Date.now()) { accInfo.status = 'WAIT'; return accInfo; }
            }

            const testResult = await testToken(t.token);
            if (testResult === 'OK') { accInfo.status = 'OK'; if (t.invalid || t.resetAt) markValid(t.id); }
            else if (testResult === 'RATELIMIT') { accInfo.status = 'WAIT'; markRateLimited(t.id, 24); }
            else if (testResult === 'UNAUTHORIZED') { accInfo.status = 'INVALID'; if (!t.invalid) markInvalid(t.id); }
            else { accInfo.status = 'ERROR'; }
            return accInfo;
        }));

        const browserContext = getBrowserContext();
        if (!browserContext) {
            logError('Браузер не инициализирован');
            return c.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        if (getAuthenticationStatus()) return c.json({ accounts });

        await checkAuthentication(browserContext);
        const isAuthenticated = getAuthenticationStatus();
        logInfo(`Статус авторизации: ${isAuthenticated ? 'активна' : 'требуется авторизация'}`);
        return c.json({ authenticated: isAuthenticated, message: isAuthenticated ? 'Авторизация активна' : 'Требуется авторизация', accounts });
    } catch (error) {
        logError('Ошибка при проверке статуса авторизации', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.post('/chats', async (c) => {
    try {
        const { name, model } = await c.req.json();
        const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        const result = await createChatV2(chatModel, name || 'Новый чат');
        if (result.error) { logError(`Ошибка создания чата: ${result.error}`); return c.json({ error: result.error }, 500); }
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        return c.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

app.post('/chat/completions', async (c) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = await c.req.json();
        const snakeCaseChatId = normalizeIdValue(body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint
            ? `conversation:${conversationHint}`
            : buildConversationScopeFromHistory(messages);
        const forceNewChat = shouldForceNewChat(req);
        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return c.json({ error: 'Сообщения не указаны' }, 400);
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        let effectiveChatId = explicitChatId;
        let effectiveParentId = explicitParentId;

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (conversationScope || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                const savedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (savedSession?.chatId) {
                    effectiveChatId = savedSession.chatId;
                    if (!effectiveParentId && savedSession.parentId) {
                        effectiveParentId = savedSession.parentId;
                    }
                        logInfo(`Restored history-scoped chatId from session: ${effectiveChatId}`);
                }

                if (!effectiveChatId) {
                    const generatedId = generateChatIdFromHistory(messages);
                    if (generatedId) {
                        effectiveChatId = generatedId;
                        logInfo(`Created history-scoped chatId for session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return c.json({ error: 'В запросе нет сообщений от пользователя' }, 400);
        }

        let messageContent = preparedInput.messageContent;

        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }

        const files = preparedInput.files || [];
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : "qwen-max-latest";
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);
        if (systemMessage) logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);

        const qwenTools = null;
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);

        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            
            
            
            
            
            
            

            const writeSse = (payload) => {
                streamWriter.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

                let streamingCallback = null;
                let hasStreamedChunks = false;
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files,
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content, combinedTools);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls);
                        return;
                    }
                }

                if (!isMeta && result.chatId) {
                    if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                        mapChatId(effectiveChatId, result.chatId);
                        logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                    }
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: null }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }

                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                streamWriter.write('data: [DONE]\n\n');
                streamWriter.close();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                streamWriter.write('data: [DONE]\n\n');
                streamWriter.close();
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);
            const result = await sendMessage(messageContent, mappedModel, qwenChatId, effectiveParentId, null, qwenTools, tool_choice, toolAwareSystemMessage);

            if (!isMeta && result.chatId) {
                if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                    mapChatId(effectiveChatId, result.chatId);
                    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                }
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            const toolCalls = Array.isArray(combinedTools) && combinedTools.length > 0
                ? parseToolCallJson(result?.choices?.[0]?.message?.content, combinedTools)
                : null;
            if (toolCalls && toolCalls.length > 0) {
                return c.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || "qwen-max-latest",
                choices: result.choices || [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.choices?.[0]?.message?.content || ""
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                chatId: result.chatId,
                parentId: result.parentId
            };

            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: openaiResponse.choices[0].message.content
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            return c.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        return c.json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } }, 500);
    }
});

app.post('/v1/chat/completions', async (c) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = await c.req.json();
        const snakeCaseChatId = normalizeIdValue(body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint
            ? `conversation:${conversationHint}`
            : buildConversationScopeFromHistory(messages);
        const forceNewChat = shouldForceNewChat(req);

        logInfo(`Получен OpenAI v1 запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return c.json({ error: 'Сообщения не указаны' }, 400);
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        let effectiveChatId = explicitChatId;
        let effectiveParentId = explicitParentId;

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (conversationScope || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                const savedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (savedSession?.chatId) {
                    effectiveChatId = savedSession.chatId;
                    if (!effectiveParentId && savedSession.parentId) {
                        effectiveParentId = savedSession.parentId;
                    }
                    logInfo(`Restored history-scoped chatId from session: ${effectiveChatId}`);
                }

                if (!effectiveChatId) {
                    const generatedId = generateChatIdFromHistory(messages);
                    if (generatedId) {
                        effectiveChatId = generatedId;
                        logInfo(`Created history-scoped chatId for session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return c.json({ error: 'В запросе нет сообщений от пользователя' }, 400);
        }

        let messageContent = preparedInput.messageContent;

        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }

        const files = preparedInput.files || [];
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : "qwen-max-latest";
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);

        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }

        const qwenTools = null;
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);
        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            
            
            
            
            
            
            

            const writeSse = (payload) => {
                streamWriter.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

                let streamingCallback = null;
                let hasStreamedChunks = false;
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files,
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content, combinedTools);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls);
                        return;
                    }
                }

                if (!isMeta && result.chatId) {
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }

                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                streamWriter.write('data: [DONE]\n\n');
                streamWriter.close();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                streamWriter.write('data: [DONE]\n\n');
                streamWriter.close();
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

            const result = await sendMessage(messageContent, mappedModel, qwenChatId, effectiveParentId, files, qwenTools, tool_choice, toolAwareSystemMessage);

            if (!isMeta && result.chatId) {
                if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                    mapChatId(effectiveChatId, result.chatId);
                    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                }
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            let messageText = '';
            if (result.choices && result.choices[0] && result.choices[0].message) {
                messageText = result.choices[0].message.content || '';
            } else if (result.response && result.response.text) {
                messageText = result.response.text;
            }

            const toolCalls = Array.isArray(combinedTools) && combinedTools.length > 0
                ? parseToolCallJson(messageText, combinedTools)
                : null;
            if (toolCalls && toolCalls.length > 0) {
                return c.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || "qwen-max-latest",
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: messageText
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                x_qwen_chat_id: result.chatId,
                x_qwen_parent_id: result.parentId || result.response_id
            };

            if (result.chatId) {
                if (!isMeta) {
                    try {
                        if (shouldPersistSessionContext(conversationScope)) {
                            saveChatIdForSession(req, result.chatId, result.parentId || result.response_id, conversationScope);
                        }
                    } catch (e) {
                        logDebug(`Не удалось сохранить chatId в сессии: ${e.message}`);
                    }
                }

                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: messageText
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            return c.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке v1 запроса', error);
        return c.json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } }, 500);
    }
});

app.post('/files/getstsToken', async (c) => {
    try {
        const fileInfo = await c.req.json();
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            logError('Некорректные данные о файле');
            return c.json({ error: 'Некорректные данные о файле' }, 400);
        }
        logInfo(`Запрос на получение STS токена для файла: ${fileInfo.filename}`);
        return c.json(await getStsToken(fileInfo));
    } catch (error) {
        logError('Ошибка при получении STS токена', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.post('/files/upload', async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file'];
        if (!file || !(file instanceof File)) { logError('Файл не был загружен'); return c.json({ error: 'Файл не был загружен' }, 400); }
        logInfo(`Файл загружен на сервер: ${file.name} (${file.size} байт)`);

        const filePath = await saveUploadedFile(file);
        const result = await uploadFileToQwen(filePath);

        await removeUploadedFile(filePath);

        if (result.success) {
            logInfo(`Файл успешно загружен в OSS: ${result.fileName}`);
            return c.json({ success: true, file: { name: result.fileName, url: result.url, size: file.size, type: file.type } });
        } else {
            logError(`Ошибка при загрузке файла в OSS: ${result.error}`);
            return c.json({ error: 'Ошибка при загрузке файла' }, 500);
        }
    } catch (error) {
        logError('Ошибка при загрузке файла', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.post('/chats/:chatId/history', async (c) => {
    try {
        const { chatId } = req.params;
        const { messages } = await c.req.json();

        logInfo(`Запрос сохранения истории для чата: ${chatId}`);

        if (!messages || !Array.isArray(messages)) {
            logError('История сообщений не указана или некорректна');
            return c.json({ error: 'История сообщений должна быть массивом' }, 400);
        }

        res.json({
            success: true,
            chatId: chatId,
            messagesCount: messages.length
        });
    } catch (error) {
        logError('Ошибка при сохранении истории чата', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/chats/:chatId/history', async (c) => {
    try {
        const { chatId } = req.params;

        logInfo(`Запрос истории для чата: ${chatId}`);

        res.json({
            success: true,
            chatId: chatId,
            messages: []
        });
    } catch (error) {
        logError('Ошибка при получении истории чата', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});


const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

function normalizeQwenAspectRatio(size, fallback = '16:9') {
    if (!size) return fallback;
    const value = String(size).trim();
    const ratioMap = {
        '1024x1024': '1:1',
        '512x512': '1:1',
        '768x768': '1:1',
        '960x960': '1:1',
        '1024x1792': '9:16',
        '1792x1024': '16:9',
        '1536x864': '16:9',
        '864x1536': '9:16'
    };
    if (ratioMap[value]) return ratioMap[value];
    if (/^\d+:\d+$/.test(value)) return value;
    return fallback;
}

function normalizeDashScopeSize(size) {
    const sizeMap = {
        '1024x1024': '1024*1024',
        '1024x1792': '1024*1792',
        '1792x1024': '1792*1024',
        '512x512': '512*512',
        '768x768': '768*768',
        '960x960': '960*960'
    };
    return sizeMap[size] || '1024*1024';
}

function buildOpenAiImageResponse({ imageUrl, prompt, model, raw, provider = 'qwen-chat' }) {
    return {
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider,
        model,
        data: [{ url: imageUrl, revised_prompt: prompt }],
        raw
    };
}

function buildVideoResponse({ result, prompt, model, waitForCompletion }) {
    const videoUrl = result.video_url || extractMediaUrl(result, 'video');
    return {
        id: result.id || result.task_id || `video-${Date.now()}`,
        object: videoUrl ? 'video.generation' : 'video.generation.task',
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider: 'qwen-chat',
        model,
        prompt,
        status: videoUrl ? 'completed' : (result.status || 'processing'),
        task_id: result.task_id || result.id || null,
        video_url: videoUrl || null,
        data: videoUrl ? [{ url: videoUrl }] : [],
        waitForCompletion,
        raw: result
    };
}

app.post('/images/generations', async (c) => {
    try {
        const { prompt, model, n, size, response_format, provider } = await c.req.json();

        logInfo('Получен запрос на генерацию изображения');
        logDebug(`Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return c.json({ error: 'Параметр "prompt" обязателен' }, 400);
        }

        if (provider === 'dashscope') {
            const apiKey = process.env.DASHSCOPE_API_KEY;
            if (!apiKey) {
                return res.status(503).json({
                    error: 'DashScope API генерации изображений не настроен',
                    message: 'Установите переменную окружения DASHSCOPE_API_KEY или используйте provider=qwen-chat'
                });
            }

            let imageModel = model || 'qwen-image-plus';
            if (imageModel === 'dall-e-3' || imageModel === 'dall-e-2') imageModel = 'qwen-image-plus';
            const result = await generateImage(prompt, imageModel, {
                n: n || 1,
                size: normalizeDashScopeSize(size),
                promptExtend: true,
                watermark: false
            });

            if (result.error) {
                logError(`Ошибка генерации DashScope: ${result.error}`);
                return c.json({ error: 'Ошибка генерации изображения', message: result.error }, 500);
            }

            return res.json(buildOpenAiImageResponse({
                imageUrl: result.imageUrl,
                prompt,
                model: imageModel,
                raw: result,
                provider: 'dashscope'
            }));
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, await c.req.json().aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2i',
            aspectRatio,
            true
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat image: ${result.error}`);
            return c.json({ error: 'Ошибка генерации изображения через Qwen Chat', message: result.error, details: result.details }, 500);
        }

        const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
        if (!imageUrl) {
            return res.status(502).json({
                error: 'Qwen Chat не вернул URL изображения',
                raw: result
            });
        }

        logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
        return c.json(buildOpenAiImageResponse({ imageUrl, prompt, model: chatModel, raw: result }));
    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        return c.json({ error: 'Внутренняя ошибка сервера', message: error.message }, 500);
    }
});

app.post('/videos/generations', async (c) => {
    try {
        const { prompt, model, size, wait, waitForCompletion } = await c.req.json();
        const shouldWait = waitForCompletion ?? wait ?? true;

        logInfo('Получен запрос на генерацию видео через Qwen Chat');
        logDebug(`Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return c.json({ error: 'Параметр "prompt" обязателен' }, 400);
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, await c.req.json().aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2v',
            aspectRatio,
            shouldWait
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat video: ${result.error}`);
            return c.json({ error: 'Ошибка генерации видео через Qwen Chat', message: result.error, details: result.details, task_id: result.task_id }, 500);
        }

        const response = buildVideoResponse({ result, prompt, model: chatModel, waitForCompletion: shouldWait });
        logInfo(response.video_url ? `Видео Qwen Chat сгенерировано: ${response.video_url}` : `Видео-задача создана: ${response.task_id}`);
        return c.json(response);
    } catch (error) {
        logError('Ошибка при генерации видео', error);
        return c.json({ error: 'Внутренняя ошибка сервера', message: error.message }, 500);
    }
});

app.get('/tasks/status/:taskId', async (c) => {
    try {
        const { taskId } = req.params;
        const wait = ['1', 'true', 'yes'].includes(String(c.req.query("wait") || '').toLowerCase());
        if (!taskId) return c.json({ error: 'taskId обязателен' }, 400);

        const result = await pollQwenTaskStatus(taskId, wait);
        if (result.error && !result.data) {
            return c.json(result, 500);
        }
        return c.json({ watermark: FORGETMEAI_WATERMARK, ...result });
    } catch (error) {
        logError('Ошибка при проверке статуса задачи', error);
        return c.json({ error: 'Внутренняя ошибка сервера', message: error.message }, 500);
    }
});

app.get('/images/models', async (c) => {
    try {
        const dashScopeModels = getAvailableImageModels();
        res.json({
            object: 'list',
            watermark: FORGETMEAI_WATERMARK,
            data: [
                {
                    id: CHAT_MEDIA_MODEL,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen-chat',
                    permission: [],
                    capability: 'qwen_chat_image_generation',
                    provider: 'qwen-chat'
                },
                ...dashScopeModels.map(model => ({
                    id: model,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen',
                    permission: [],
                    capability: 'image_generation',
                    provider: 'dashscope'
                }))
            ]
        });
    } catch (error) {
        logError('Ошибка при получении списка моделей изображений', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/videos/models', async (c) => {
    res.json({
        object: 'list',
        watermark: FORGETMEAI_WATERMARK,
        data: [{
            id: CHAT_MEDIA_MODEL,
            object: 'model',
            created: Date.now(),
            owned_by: 'qwen-chat',
            permission: [],
            capability: 'qwen_chat_video_generation',
            provider: 'qwen-chat'
        }]
    });
});

app.get('/images/status', async (c) => {
    try {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        const dashScopeAvailable = await checkImageApiAvailability();
        const tokens = listTokens();
        const now = Date.now();
        const qwenChatAvailable = tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);

        res.json({
            watermark: FORGETMEAI_WATERMARK,
            qwenChat: {
                available: qwenChatAvailable,
                model: CHAT_MEDIA_MODEL,
                message: qwenChatAvailable ? 'Qwen Chat генерация изображений доступна' : 'Нет активных аккаунтов Qwen Chat'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: !!apiKey,
                message: dashScopeAvailable
                    ? 'DashScope API генерации изображений доступен'
                    : apiKey
                        ? 'DashScope API недоступен или неверные учётные данные'
                        : 'DASHSCOPE_API_KEY не настроен'
            }
        });
    } catch (error) {
        logError('Ошибка при проверке статуса API изображений', error);
        return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
});

app.get('/videos/status', async (c) => {
    const tokens = listTokens();
    const now = Date.now();
    const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;
    res.json({
        watermark: FORGETMEAI_WATERMARK,
        available: availableAccounts > 0,
        model: CHAT_MEDIA_MODEL,
        accounts: { total: tokens.length, available: availableAccounts },
        message: availableAccounts > 0 ? 'Qwen Chat генерация видео доступна' : 'Нет активных аккаунтов Qwen Chat'
    });
});

export default app;
