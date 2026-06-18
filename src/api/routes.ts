import express from 'express';
import { sendMessage, getAllModels, createChatV2, pollQwenTaskStatus, extractMediaUrl, pagePool, extractAuthToken } from './chat.ts';
import { getAuthenticationStatus, getBrowserContext } from '../browser/browser.ts';
import { checkAuthentication } from '../browser/auth.ts';
import { logInfo, logError, logDebug } from '../logger/index.ts';
import { getMappedModel } from './modelMapping.ts';
import { getStsToken, uploadFileToQwen } from './fileUpload.ts';
import { loadHistory, saveHistory } from './chatHistory.ts';
import { generateImage, getAvailableImageModels, checkImageApiAvailability } from './imageGeneration.ts';
import { MAX_FILE_SIZE, UPLOADS_DIR, DEFAULT_MODEL, STREAMING_CHUNK_DELAY, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from '../config.ts';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { listTokens, markInvalid, markRateLimited, markValid } from './tokenManager.ts';
import { FORGETMEAI_WATERMARK } from '../utils/branding.ts';

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

function extractConversationHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        req.get?.('x-conversation-id'),
        req.get?.('x-openwebui-conversation-id'),
        req.get?.('x-chat-id'),
        req.get?.('x-openwebui-chat-id')
    ]);
}

function extractParentHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        req.get?.('x-parent-id'),
        req.get?.('x-openwebui-parent-id')
    ]);
}

function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldForceNewChat(req) {
    const body = req.body || {};

    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        req.get?.('x-new-chat'),
        req.get?.('x-reset-chat')
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

function getSessionKey(req) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return crypto.createHash('sha256').update(`${ip}||${userAgent}`).digest('hex');
}

function getScopedSessionKey(req, scope = null) {
    const baseKey = getSessionKey(req);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

function getSavedChatId(req, scope = null) {
    const keysToTry = [getScopedSessionKey(req, scope)];

    for (const sessionKey of keysToTry) {
        const sessionData = sessionToChatMap.get(sessionKey);
        if (sessionData && (Date.now() - sessionData.timestamp) < 3600000) {
            return sessionData;
        }
    }

    return null;
}
function saveChatIdForSession(req, chatId, parentId, scope = null) {
    const sessionKey = getScopedSessionKey(req, scope);
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

const router = express.Router();


const storage = multer.diskStorage({
    destination(req, file, cb) {
        const uploadDir = path.join(process.cwd(), UPLOADS_DIR);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename(req, file, cb) {
        const originalName = path.basename(file.originalname || 'upload')
            .normalize('NFKC')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .slice(-120);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${originalName || 'upload'}`);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

async function removeUploadedFile(filePath) {
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        logDebug(`Не удалось удалить временный файл: ${error.message}`);
    }
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

function truncateForPrompt(value, maxLen = 240) {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

function compactJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

export function normalizeToolDefinitions(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.flatMap(tool => {
        if (tool?.type !== 'namespace' || !tool?.name || !Array.isArray(tool?.tools)) return [tool];
        return tool.tools
            .map(inner => {
                const fn = inner?.function || inner;
                if (!fn?.name) return null;
                return {
                    type: 'function',
                    function: {
                        name: fn.name,
                        namespace: tool.name,
                        qualified_name: `${tool.name}.${fn.name}`,
                        description: [tool.description, fn.description].filter(Boolean).join('\n\n'),
                        parameters: fn.parameters || { type: 'object', properties: {} }
                    }
                };
            })
            .filter(Boolean);
    });
}

export function toolsToPrompt(tools) {
    tools = normalizeToolDefinitions(tools);
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const schemas = tools.map(tool => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        return {
            name: fn.qualified_name || (fn.namespace ? `${fn.namespace}.${fn.name}` : fn.name),
            description: truncateForPrompt(fn.description || '', priorityNames.has(fn.name) ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority: priorityNames.has(fn.name) ? 0 : 1
        };
    }).filter(Boolean).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- For greetings, thanks, casual conversation, explanations, and questions answer directly. Never call bash/terminal merely to print or echo a reply.
- For codebase tasks such as implement, fix, refactor, review, test, or inspect, you MUST call read/ls/find/grep/bash or another suitable workspace tool before making claims or giving a final answer.
- Never claim that a file exists, was deleted, changed, tested, or listed unless that fact came from a tool result in the current conversation.
- Do not print a shell command as a suggestion when you can call the corresponding tool yourself.
- Never simulate tools with XML, markdown, or prose such as <bash>...</bash>, <read>...</read>, [调用 read] [{"path":"..."}], Tool call: read (path), Tool call: write (path) followed by Content:, or fenced shell blocks. Emit a real JSON tool call instead.
- When the user asks you to implement, fix, or refactor, continue through inspection, edits, and verification. Do not stop to ask which approach they prefer unless required information cannot be discovered.
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not invent or rewrite namespace separators.
- Bare MCP server labels such as mcp__playwright, mcp__context7, mcp__exa, mcp__memory, mcp__fal_ai, and mcp__sequential_thinking are NOT callable tool names.
- For Playwright, call a concrete browser tool from the available tool names list. Never call bare mcp__playwright.
- Never output an empty tool_calls array. If no tool is needed, answer the user normally in plain text.
- For source-code changes, prefer patch/apply_patch. For a complete file replacement, use write/write_file with the final content.
- For small exact replacements, edit is allowed. Keep oldText/newText source syntax valid and preserve all quotes, backticks, asterisks, and escapes.
- Keep every JSON property name and path as one uninterrupted string. Never insert whitespace or line breaks inside names such as "content", "path", or "oldText".
- JSON string values must escape embedded newlines as \n. The outer tool-call JSON itself must remain valid and minified.
- When write content contains JSON or source code with double quotes, escape every inner double quote as \" so the outer tool-call JSON stays valid.
- Preserve source code exactly inside tool arguments. In particular, CSS comments must use /* comment */ with both asterisk characters.
- Preserve JavaScript and TypeScript delimiters exactly. Template literals containing \${...} require surrounding backticks, and selector strings passed to querySelector/querySelectorAll require quotes or backticks.

TOOL CALL OUTPUT FORMAT — ONLY when actually calling one or more tools, respond with minified JSON, no markdown, no prose:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, do not output JSON and answer normally in plain text.`;
}

const TOOL_CALL_JSON_KEYS = [
    'tool_calls', 'function_call', 'tool_call', 'name', 'tool', 'function',
    'arguments', 'args', 'input', 'path', 'content', 'edits', 'oldText', 'newText',
    'command'
];

export function repairToolCallJsonKeys(text) {
    let repaired = text;
    for (const key of TOOL_CALL_JSON_KEYS) {
        const splitKey = key.split('').join('\\s*');
        repaired = repaired.replace(new RegExp(`"${splitKey}"\\s*:`, 'g'), `"${key}":`);
    }
    return repaired;
}

export function extractFirstToolCallObject(text) {
    const start = text.indexOf('{"tool_calls"');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
    }
    return null;
}

export function hasObviouslyBrokenEditArguments(rawArgs) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return true;
    }
    if (!args || !Array.isArray(args.edits)) return false;

    return args.edits.some(edit => {
        const source = edit?.newText;
        if (typeof source !== 'string') return false;
        const hasInterpolationWithoutBackticks = source.includes('${') && !source.includes('`');
        const hasUnquotedSelector = /\bquerySelector(?:All)?\(\s*[.#][^"'`)]/.test(source);
        return hasInterpolationWithoutBackticks || hasUnquotedSelector;
    });
}

export function repairEditArguments(rawArgs) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : structuredClone(rawArgs);
    } catch {
        return rawArgs;
    }
    if (!args || !Array.isArray(args.edits)) return args;

    for (const edit of args.edits) {
        for (const field of ['oldText', 'newText']) {
            if (typeof edit?.[field] !== 'string') continue;
            let source = edit[field];
            source = source.replace(
                /\bquerySelector(All)?\(\s*([.#][^)\n]*\$\{[^)\n]*\}[^)\n]*)\)/g,
                (_match, all = '', selector) => `querySelector${all}(\`${selector}\`)`
            );
            source = source.replace(
                /^(\s*[\w.[\]]+\.textContent\s*=\s*)([^;\n]*\$\{[^;\n]*\}[^;\n]*);/gm,
                (_match, prefix, value) => `${prefix}\`${value.trim()}\`;`
            );
            edit[field] = source;
        }
    }
    return args;
}

export function recoverSimpleToolCalls(text) {
    const normalized = repairToolCallJsonKeys(text);
    const starts = [...normalized.matchAll(/\{\s*"name"\s*:\s*"(write|read)"\s*,\s*"arguments"\s*:\s*\{/g)];
    if (starts.length === 0) return null;

    const calls = [];
    for (let index = 0; index < starts.length; index++) {
        const name = starts[index][1];
        const start = starts[index].index;
        const end = index + 1 < starts.length ? starts[index + 1].index : normalized.length;
        const chunk = normalized.slice(start, end);
        const pathMatch = chunk.match(/"path"\s*:\s*"([^"]+)"/);
        if (!pathMatch) return null;
        const path = pathMatch[1].replace(/\s+/g, match => /[\r\n]/.test(match) ? '' : match);

        if (name === 'read') {
            calls.push({ name, arguments: { path } });
            continue;
        }

        const contentStart = chunk.search(/"content"\s*:\s*"/);
        if (contentStart < 0) return null;
        const afterOpeningQuote = chunk.indexOf('"', contentStart + chunk.slice(contentStart).indexOf(':') + 1) + 1;
        const contentEnd = chunk.lastIndexOf('"}');
        if (afterOpeningQuote <= 0 || contentEnd < afterOpeningQuote) return null;
        calls.push({
            name,
            arguments: {
                path,
                content: chunk.slice(afterOpeningQuote, contentEnd).replace(/\\n/g, '\n')
            }
        });
    }
    return calls;
}

export function recoverBrokenBashToolCall(text) {
    const normalized = repairToolCallJsonKeys(text);
    const match = normalized.match(/"name"\s*:\s*"(bash|terminal)"[\s\S]*?"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*\]\s*\}?$/);
    if (!match) return null;
    const command = match[2].replace(/"\s*"\s*$/, '"');
    return { name: match[1], arguments: { command } };
}

export function recoverXmlStyleToolCall(text) {
    const outer = text.match(/<function=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (outer) {
        const name = outer[1].toLowerCase();
        const args = {};
        const paramRe = /<parameter=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRe.exec(outer[2])) !== null) {
            const value = paramMatch[2].trim().replace(/<\/[A-Za-z0-9_-]+>/g, '').trim();
            args[paramMatch[1].toLowerCase()] = value;
        }
        if (Object.keys(args).length > 0) {
            const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
            const commandTools = new Set(['bash', 'terminal']);
            if (commandTools.has(name)) return { name: 'bash', arguments: { command: args.command || Object.values(args)[0] } };
            if (pathTools.has(name) && args.path) return { name, arguments: { path: args.path } };
            return { name, arguments: args };
        }
    }

    const block = text.match(/<(bash|terminal|read|ls|find|grep)>\s*([\s\S]*?)\s*<\/\1>/i);
    if (!block) return null;
    const name = block[1].toLowerCase();
    const body = block[2].trim();
    if (name === 'bash' || name === 'terminal') {
        const read = body.match(/^read\s+(.+?)(?:\s+--limit\s+\d+)?$/);
        if (read) return { name: 'read', arguments: { path: read[1].trim() } };
        return { name: 'bash', arguments: { command: body } };
    }
    return { name, arguments: { path: body } };
}

export function recoverChineseStyleToolCall(text) {
    const marker = text.match(/\[调用\s+([A-Za-z0-9_-]+)\]\s*/);
    if (!marker || marker.index === undefined) return null;
    const jsonStart = marker.index + marker[0].length;
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode(text.slice(jsonStart));
    for (let end = 1; end <= bytes.length; end++) {
        try {
            const parsed = JSON.parse(decoder.decode(bytes.slice(0, end)));
            const args = Array.isArray(parsed) ? parsed[0] : parsed;
            if (!args || typeof args !== 'object') return null;
            return { name: marker[1], arguments: args };
        } catch {
        }
    }
    return null;
}

export function recoverProseStyleToolCalls(text) {
    const matches = [...text.matchAll(/^[ \t]*Tool call:\s*([A-Za-z0-9_-]+)\s*\((.*)\)[ \t]*$/gim)];
    if (matches.length === 0) return null;

    const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
    const commandTools = new Set(['bash', 'terminal']);
    const writeTools = new Set(['write', 'write_file']);
    const calls = matches.map((match, index) => {
        const name = match[1];
        const value = match[2].trim();
        if (!value) return null;

        if (value.startsWith('{') || value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value);
                const argumentsValue = Array.isArray(parsed) ? parsed[0] : parsed;
                if (argumentsValue && typeof argumentsValue === 'object') {
                    return { name, arguments: argumentsValue };
                }
            } catch {
                return null;
            }
        }

        if (writeTools.has(name)) {
            const segmentStart = (match.index || 0) + match[0].length;
            const segmentEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
            const segment = text.slice(segmentStart, segmentEnd);
            const contentMarker = segment.match(/^[ \t]*(?:Content|Содержимое):[ \t]*/im);
            if (!contentMarker || contentMarker.index === undefined) return null;
            let content = segment.slice(contentMarker.index + contentMarker[0].length).replace(/^\r?\n/, '').trimEnd();
            const wholeFence = content.match(/^```(?:html|css|javascript|js|typescript|ts|json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
            if (wholeFence) content = wholeFence[1];
            return content ? { name, arguments: { path: value, content } } : null;
        }
        if (commandTools.has(name)) {
            return { name, arguments: { command: value } };
        }
        if (pathTools.has(name)) {
            return { name, arguments: { path: value } };
        }
        return null;
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

export function recoverFencedShellToolCalls(text) {
    const fencePattern = /```(?:bash|sh|shell|zsh)[ \t]*\r?\n([\s\S]*?)```/gi;
    const matches = [...text.matchAll(fencePattern)];
    if (matches.length === 0) return null;

    const prose = text.replace(fencePattern, ' ').replace(/\s+/g, ' ').trim();
    const hasExecutionIntent = /(?:давайте|провер(?:им|ю)|посмотр(?:им|ю)|изучу|запущу|выполню|let'?s|i(?:'ll| will) (?:run|check|inspect))/i.test(prose);
    const looksLikeInstructions = /(?:например|пример|запустите|используйте|выполните|for example|run this|use this|command:|(?:run|execute|use) (?:the |this )?command)/i.test(prose);
    if (!hasExecutionIntent || looksLikeInstructions) return null;

    const calls = matches.map(match => {
        const command = match[1].trim();
        if (!command || conversationalShellText('bash', { command })) return null;
        return { name: 'bash', arguments: { command } };
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

export function conversationalShellText(name, rawArgs) {
    if (name !== 'bash' && name !== 'terminal') return false;
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return null;
    }
    if (typeof args?.command !== 'string') return null;
    const match = args.command.match(/^\s*(?:echo|printf(?:\s+%s)?)\s+["']?([\s\S]*?)["']?\s*$/);
    return match ? match[1] : null;
}

function recoveredToolCalls(calls, allowedNames) {
    if (!calls || calls.some(call => allowedNames && !allowedNames.has(call.name))) return null;
    return calls.map((call, index) => ({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        index
    }));
}

export function parseToolCallJson(content, tools = null) {
    if (typeof content !== 'string') return null;
    tools = normalizeToolDefinitions(tools);
    const allowedTools = Array.isArray(tools)
        ? new Map(tools.map(tool => {
            const fn = tool?.function || tool;
            const qualifiedName = fn?.qualified_name || (fn?.namespace ? `${fn.namespace}.${fn.name}` : fn?.name);
            return [qualifiedName, fn];
        }).filter(([name]) => Boolean(name)))
        : null;
    const allowedNames = allowedTools ? new Set(allowedTools.keys()) : null;
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 || last !== text.length - 1) {
        if (first >= 0 && last > first) text = text.slice(first, last + 1);
    }
    const firstToolCall = extractFirstToolCallObject(content);
    const parseAttempts = [
        text,
        repairToolCallJsonKeys(text),
        firstToolCall,
        firstToolCall ? repairToolCallJsonKeys(firstToolCall) : null
    ].filter(Boolean);
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }
    const objTc = text.match(/^\s*\{\s*"tool_calls"\s*:\s*\{/);
    if (objTc) {
        const fixed = text.replace(/^\s*\{\s*"tool_calls"\s*:\s*\{/, '{"tool_calls":[{') + ']}';
        parseAttempts.push(fixed);
        parseAttempts.push(repairToolCallJsonKeys(fixed));
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls = null;
            if (Array.isArray(parsed.tool_calls)) {
                calls = parsed.tool_calls;
            } else if (parsed.function_call || parsed.tool_call) {
                calls = [parsed.function_call || parsed.tool_call];
            } else if (parsed.name || parsed.tool) {
                calls = [parsed];
            }
            if (!calls || calls.length === 0) continue;
            const mappedCalls = calls.map((call, index) => {
                const name = call.name || call.tool || call.function?.name;
                const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments ?? {};
                const normalizedArgs = name === 'edit' ? repairEditArguments(rawArgs) : rawArgs;
                const args = typeof normalizedArgs === 'string' ? normalizedArgs : JSON.stringify(normalizedArgs || {});
                if (!name || (allowedNames && !allowedNames.has(name))) return null;
                if (conversationalShellText(name, args)) return null;
                const definition = allowedTools?.get(name);
                return {
                    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: {
                        name: definition?.name || name,
                        ...(definition?.namespace ? { namespace: definition.namespace } : {}),
                        arguments: args
                    },
                    index
                };
            }).filter(Boolean);
            if (mappedCalls.length !== calls.length) continue;
            return mappedCalls;
        } catch {
        }
    }
    const recovered = recoverSimpleToolCalls(text);
    if (recovered) return recoveredToolCalls(recovered, allowedNames);
    const recoveredBash = recoverBrokenBashToolCall(text);
    if (recoveredBash && !conversationalShellText(recoveredBash.name, recoveredBash.arguments)) {
        return recoveredToolCalls([recoveredBash], allowedNames);
    }
    const recoveredXml = recoverXmlStyleToolCall(content);
    if (recoveredXml) return recoveredToolCalls([recoveredXml], allowedNames);
    const recoveredChinese = recoverChineseStyleToolCall(content);
    if (recoveredChinese) return recoveredToolCalls([recoveredChinese], allowedNames);
    const recoveredProse = recoverProseStyleToolCalls(content);
    if (recoveredProse) return recoveredToolCalls(recoveredProse, allowedNames);
    const recoveredFencedShell = recoverFencedShellToolCalls(content);
    if (recoveredFencedShell) return recoveredToolCalls(recoveredFencedShell, allowedNames);
    return null;
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
    res.write('data: [DONE]\n\n');
    res.end();
}

router.post('/chat', async (req, res) => {
    try {
        const { message, messages, model, chatId, parentId, stream, chatType, size, waitForCompletion } = req.body;

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
            return res.status(400).json({ error: 'Сообщение не указано' });
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
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
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
                res.write('data: [DONE]\n\n');
                res.end();
                return;
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
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
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

        res.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/health', async (req, res) => {
    try {
        const modelData = getAllModels();
        const tokens = listTokens();
        const now = Date.now();
        const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;

        res.json({
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
        res.status(500).json({ ok: false, error: 'Health-проверка не удалась' });
    }
});

router.get('/models', async (req, res) => {
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
        res.json(openAiModels);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/status', async (req, res) => {
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
            return res.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        if (getAuthenticationStatus()) return res.json({ accounts });

        await checkAuthentication(browserContext);
        const isAuthenticated = getAuthenticationStatus();
        logInfo(`Статус авторизации: ${isAuthenticated ? 'активна' : 'требуется авторизация'}`);
        res.json({ authenticated: isAuthenticated, message: isAuthenticated ? 'Авторизация активна' : 'Требуется авторизация', accounts });
    } catch (error) {
        logError('Ошибка при проверке статуса авторизации', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chats', async (req, res) => {
    try {
        const { name, model } = req.body;
        const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        const result = await createChatV2(chatModel, name || 'Новый чат');
        if (result.error) { logError(`Ошибка создания чата: ${result.error}`); return res.status(500).json({ error: result.error }); }
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

router.post('/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
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
            return res.status(400).json({ error: 'Сообщения не указаны' });
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
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
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
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
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
                res.write('data: [DONE]\n\n');
                res.end();

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
                res.write('data: [DONE]\n\n');
                res.end();
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
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
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

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

router.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
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
            return res.status(400).json({ error: 'Сообщения не указаны' });
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
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
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
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
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
                res.write('data: [DONE]\n\n');
                res.end();

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
                res.write('data: [DONE]\n\n');
                res.end();
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
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
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

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке v1 запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

router.post('/files/getstsToken', async (req, res) => {
    try {
        const fileInfo = req.body;
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            logError('Некорректные данные о файле');
            return res.status(400).json({ error: 'Некорректные данные о файле' });
        }
        logInfo(`Запрос на получение STS токена для файла: ${fileInfo.filename}`);
        res.json(await getStsToken(fileInfo));
    } catch (error) {
        logError('Ошибка при получении STS токена', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) { logError('Файл не был загружен'); return res.status(400).json({ error: 'Файл не был загружен' }); }
        logInfo(`Файл загружен на сервер: ${req.file.originalname} (${req.file.size} байт)`);

        const result = await uploadFileToQwen(req.file.path);

        await removeUploadedFile(req.file.path);

        if (result.success) {
            logInfo(`Файл успешно загружен в OSS: ${result.fileName}`);
            res.json({ success: true, file: { name: result.fileName, url: result.url, size: req.file.size, type: req.file.mimetype } });
        } else {
            logError(`Ошибка при загрузке файла в OSS: ${result.error}`);
            res.status(500).json({ error: 'Ошибка при загрузке файла' });
        }
    } catch (error) {
        logError('Ошибка при загрузке файла', error);
        await removeUploadedFile(req.file?.path);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { messages } = req.body;

        logInfo(`Запрос сохранения истории для чата: ${chatId}`);

        if (!messages || !Array.isArray(messages)) {
            logError('История сообщений не указана или некорректна');
            return res.status(400).json({ error: 'История сообщений должна быть массивом' });
        }

        res.json({
            success: true,
            chatId: chatId,
            messagesCount: messages.length
        });
    } catch (error) {
        logError('Ошибка при сохранении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chats/:chatId/history', async (req, res) => {
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
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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

router.post('/images/generations', async (req, res) => {
    try {
        const { prompt, model, n, size, response_format, provider } = req.body;

        logInfo('Получен запрос на генерацию изображения');
        logDebug(`Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
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
                return res.status(500).json({ error: 'Ошибка генерации изображения', message: result.error });
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
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
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
            return res.status(500).json({ error: 'Ошибка генерации изображения через Qwen Chat', message: result.error, details: result.details });
        }

        const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
        if (!imageUrl) {
            return res.status(502).json({
                error: 'Qwen Chat не вернул URL изображения',
                raw: result
            });
        }

        logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
        return res.json(buildOpenAiImageResponse({ imageUrl, prompt, model: chatModel, raw: result }));
    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

router.post('/videos/generations', async (req, res) => {
    try {
        const { prompt, model, size, wait, waitForCompletion } = req.body;
        const shouldWait = waitForCompletion ?? wait ?? true;

        logInfo('Получен запрос на генерацию видео через Qwen Chat');
        logDebug(`Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
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
            return res.status(500).json({ error: 'Ошибка генерации видео через Qwen Chat', message: result.error, details: result.details, task_id: result.task_id });
        }

        const response = buildVideoResponse({ result, prompt, model: chatModel, waitForCompletion: shouldWait });
        logInfo(response.video_url ? `Видео Qwen Chat сгенерировано: ${response.video_url}` : `Видео-задача создана: ${response.task_id}`);
        return res.json(response);
    } catch (error) {
        logError('Ошибка при генерации видео', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

router.get('/tasks/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        if (!taskId) return res.status(400).json({ error: 'taskId обязателен' });

        const result = await pollQwenTaskStatus(taskId, wait);
        if (result.error && !result.data) {
            return res.status(500).json(result);
        }
        return res.json({ watermark: FORGETMEAI_WATERMARK, ...result });
    } catch (error) {
        logError('Ошибка при проверке статуса задачи', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

router.get('/images/models', async (req, res) => {
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
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/videos/models', async (req, res) => {
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

router.get('/images/status', async (req, res) => {
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
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/videos/status', async (req, res) => {
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

export default router;
