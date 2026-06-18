import crypto from 'crypto';
import path from 'node:path';

import { solveDeepSeekPow } from './pow.ts';
import { getAvailableDeepSeekAccount, markDeepSeekAccountInvalid, type DeepSeekAccount } from './accounts.ts';
import { PersistentStringMap } from '../../utils/persistentMap.ts';

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com';
const SESSION_MAP_FILE = process.env.DEEPSEEK_SESSION_MAP_FILE || path.join(process.cwd(), 'session', 'deepseek', 'chat-sessions.json');

const HARDCODED_DEEPSEEK_MODELS = ['deepseek-default', 'deepseek-reasoner', 'deepseek-expert', 'deepseek-search'];
let cachedDeepSeekModels: string[] | null = null;

export async function fetchDeepSeekModels(): Promise<string[]> {
    if (cachedDeepSeekModels) return cachedDeepSeekModels;
    try {
        const response = await fetch(`${BASE_URL}/api/v0/models`, {
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const data = await response.json() as any;
            const models: string[] = (data?.data || [])
                .map((m: any) => m.id || m.name)
                .filter(Boolean)
                .sort();
            if (models.length > 0) {
                cachedDeepSeekModels = models;
                return models;
            }
        }
    } catch {
        // API unavailable, use fallback
    }
    cachedDeepSeekModels = HARDCODED_DEEPSEEK_MODELS;
    return HARDCODED_DEEPSEEK_MODELS;
}

export function getDeepSeekModels(): string[] {
    return cachedDeepSeekModels || HARDCODED_DEEPSEEK_MODELS;
}

const sessions = new PersistentStringMap(SESSION_MAP_FILE);

function envAccount(): DeepSeekAccount | null {
    const token = process.env.DEEPSEEK_TOKEN;
    return token ? { id: 'env', token, cookies: [] } : null;
}

function getAccount() {
    const account = getAvailableDeepSeekAccount() || envAccount();
    if (!account) throw new Error('Нет активных аккаунтов DeepSeek. Добавьте аккаунт через меню.');
    return account;
}

function cookieHeader(account: DeepSeekAccount) {
    return account.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function headers(account: DeepSeekAccount, extra: Record<string, string> = {}) {
    return {
        authorization: `Bearer ${account.token}`,
        'content-type': 'application/json',
        ...(account.cookies.length ? { cookie: cookieHeader(account) } : {}),
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        ...extra
    };
}

export function conversationKey(messages: Array<Record<string, any>>) {
    const firstUser = messages.find(message => message?.role === 'user');
    if (!firstUser) return crypto.randomUUID();
    const content = typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 24);
}

async function createSession(account: DeepSeekAccount) {
    const response = await fetch(`${BASE_URL}/api/v0/chat_session/create`, {
        method: 'POST',
        headers: headers(account),
        body: '{}'
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw new Error(`DeepSeek session create failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as any;
    const id = body?.data?.biz_data?.chat_session?.id || body?.data?.biz_data?.id;
    if (!id) throw new Error('DeepSeek did not return a chat session id');
    return id as string;
}

async function getSession(account: DeepSeekAccount, key: string) {
    const scopedKey = `${account.id}:${key}`;
    const existing = sessions.get(scopedKey);
    if (existing) return existing;
    const created = await createSession(account);
    sessions.set(scopedKey, created);
    return created;
}

async function getPow(account: DeepSeekAccount, sessionId: string) {
    const response = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
        method: 'POST',
        headers: headers(account, { referer: `${BASE_URL}/a/chat/s/${sessionId}` }),
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw new Error(`DeepSeek PoW challenge failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as any;
    const challenge = body?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('DeepSeek did not return a PoW challenge');
    return solveDeepSeekPow(challenge);
}

export function messagesToPrompt(messages: Array<Record<string, any>>) {
    return messages.map(message => {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        if (message.role === 'tool') return `Tool result (${message.name || message.tool_call_id || 'tool'}): ${content}`;
        if (message.role === 'assistant' && message.tool_calls) {
            return `Assistant tool calls: ${JSON.stringify(message.tool_calls)}\n${content}`;
        }
        return `${message.role || 'user'}: ${content}`;
    }).join('\n\n');
}

export function isEmptyToolCallResponse(content: string) {
    return /^\s*(?:```json\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\]\s*\}(?:\s*```)?\s*$/i.test(content);
}

export async function deepSeekCompletion(options: {
    messages: Array<Record<string, any>>;
    model?: string;
    conversationId?: string;
}) {
    const account = getAccount();
    const key = options.conversationId || conversationKey(options.messages);
    const sessionId = await getSession(account, key);
    const pow = await getPow(account, sessionId);
    const model = options.model || 'deepseek-default';
    const response = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
        method: 'POST',
        headers: headers(account, {
            referer: `${BASE_URL}/a/chat/s/${sessionId}`,
            'x-ds-pow-response': pow,
            ...(model.includes('reasoner') || model.includes('r1') ? { 'x-thinking-enabled': 'true' } : {})
        }),
        body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: null,
            prompt: messagesToPrompt(options.messages),
            ref_file_ids: [],
            thinking_enabled: model.includes('reasoner') || model.includes('r1'),
            search_enabled: model.includes('search'),
            model_type: model.includes('expert') ? 'expert' : 'default'
        })
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw new Error(`DeepSeek completion failed: ${response.status} ${await response.text()}`);
    return { response, sessionId, key, accountId: account.id };
}

export function parseDeepSeekEvent(line: string, state: {
    phase: 'content' | 'thinking';
    fragment?: string;
    contentSnapshot?: string;
    thinkingSnapshot?: string;
}) {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return { done: true };
    const event = JSON.parse(data);
    const path = event.p;
    const value = event.v;
    const snapshot = value?.response;
    if (!path && snapshot && typeof snapshot === 'object') {
        const snapshotContent = typeof snapshot.content === 'string' ? snapshot.content : '';
        const snapshotThinking = typeof snapshot.thinking_content === 'string' ? snapshot.thinking_content : '';
        if (snapshotThinking && snapshotThinking !== state.thinkingSnapshot) {
            const previous = state.thinkingSnapshot || '';
            state.thinkingSnapshot = snapshotThinking;
            return { reasoning: snapshotThinking.startsWith(previous) ? snapshotThinking.slice(previous.length) : snapshotThinking };
        }
        if (snapshotContent && snapshotContent !== state.contentSnapshot) {
            const previous = state.contentSnapshot || '';
            state.contentSnapshot = snapshotContent;
            return { content: snapshotContent.startsWith(previous) ? snapshotContent.slice(previous.length) : snapshotContent };
        }
        return null;
    }
    if (path === 'response/status' || path?.endsWith('/status')) {
        return value === 'FINISHED' ? { done: true } : null;
    }
    if (path === 'response/fragments/-1/type') state.fragment = value;
    if (path === 'response/thinking_content') state.phase = 'thinking';
    if (path === 'response/content') state.phase = 'content';
    if (path === 'response/fragments/-1/content') {
        state.phase = state.fragment === 'THINK' ? 'thinking' : 'content';
    }
    if (typeof value !== 'string' || path === 'response/fragments/-1/type') return null;
    if (state.phase === 'thinking') {
        state.thinkingSnapshot = `${state.thinkingSnapshot || ''}${value}`;
        return { reasoning: value };
    }
    state.contentSnapshot = `${state.contentSnapshot || ''}${value}`;
    return { content: value };
}
