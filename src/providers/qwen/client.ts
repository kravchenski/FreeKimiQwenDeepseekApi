import crypto from 'crypto';
import path from 'node:path';

import { getAvailableQwenAccount, markQwenAccountInvalid, type QwenAccount } from './accounts.ts';
import { PersistentStringMap } from '../../utils/persistentMap.ts';

const BASE_URL = process.env.QWEN_BASE_URL || 'https://chat.qwen.ai';
const SESSION_MAP_FILE = process.env.QWEN_SESSION_MAP_FILE || path.join(process.cwd(), 'session', 'qwen', 'chat-sessions.json');

const HARDCODED_QWEN_MODELS = [
    'qwen-max', 'qwen-max-latest',
    'qwen-plus', 'qwen-plus-latest',
    'qwen-turbo', 'qwen-turbo-latest',
    'qwen3-max', 'qwen3-plus',
    'qwen3-coder-plus', 'qwen3-235b-a22b', 'qwen3-30b-a3b',
    'qwen3-flash', 'qwen3-vl-plus',
    'qwen2.5-vl-32b-instruct', 'qwen2.5-72b-instruct', 'qwen2.5-coder-32b-instruct',
    'qwq-32b', 'qvq-72b-preview-0310',
];
let cachedQwenModels: string[] | null = null;

export async function fetchQwenModels(): Promise<string[]> {
    if (cachedQwenModels) return cachedQwenModels;
    try {
        const response = await fetch(`${BASE_URL}/api/models`, {
            signal: AbortSignal.timeout(5000),
            headers: {
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            }
        });
        if (response.ok) {
            const data = await response.json() as any;
            const models: string[] = (data?.data || data?.models || [])
                .map((m: any) => m.id || m.name || m.model_id)
                .filter(Boolean)
                .sort();
            if (models.length > 0) {
                cachedQwenModels = models;
                return models;
            }
        }
    } catch {
    }
    cachedQwenModels = HARDCODED_QWEN_MODELS;
    return HARDCODED_QWEN_MODELS;
}

export function getQwenModels(): string[] {
    return cachedQwenModels || HARDCODED_QWEN_MODELS;
}

const sessions = new PersistentStringMap(SESSION_MAP_FILE);

function envAccount(): QwenAccount | null {
    const token = process.env.QWEN_TOKEN;
    return token ? { id: 'env', token } : null;
}

function getAccount() {
    const account = getAvailableQwenAccount() || envAccount();
    if (!account) throw new Error('Нет активных аккаунтов Qwen. Добавьте аккаунт через меню.');
    return account;
}

function headers(account: QwenAccount, extra: Record<string, string> = {}) {
    return {
        authorization: `Bearer ${account.token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...extra
    };
}

export function conversationKey(messages: Array<Record<string, any>>) {
    const firstUser = messages.find(m => m?.role === 'user');
    if (!firstUser) return crypto.randomUUID();
    const content = typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 24);
}

export function messagesToPrompt(messages: Array<Record<string, any>>) {
    return messages.map(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        if (m.role === 'tool') return `Tool result (${m.name || m.tool_call_id || 'tool'}): ${content}`;
        if (m.role === 'assistant' && m.tool_calls) {
            return `Assistant tool calls: ${JSON.stringify(m.tool_calls)}\n${content}`;
        }
        return `${m.role || 'user'}: ${content}`;
    }).join('\n\n');
}

export function isEmptyToolCallResponse(content: string) {
    return /^\s*(?:```json\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\]\s*\}(?:\s*```)?\s*$/i.test(content);
}

async function createSession(account: QwenAccount) {
    const response = await fetch(`${BASE_URL}/api/chat/session`, {
        method: 'POST',
        headers: { ...headers(account), accept: 'application/json' },
        body: '{}'
    });
    if (response.status === 401 && account.id !== 'env') markQwenAccountInvalid(account.id);
    if (!response.ok) throw new Error(`Qwen session create failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as any;
    return (body?.data?.id || body?.session_id || body?.id) as string;
}

async function getSession(account: QwenAccount, key: string) {
    const scopedKey = `${account.id}:${key}`;
    const existing = sessions.get(scopedKey);
    if (existing) return existing;
    const created = await createSession(account);
    sessions.set(scopedKey, created);
    return created;
}

export async function qwenCompletion(options: {
    messages: Array<Record<string, any>>;
    model?: string;
    conversationId?: string;
}) {
    const account = getAccount();
    const key = options.conversationId || conversationKey(options.messages);
    const sessionId = await getSession(account, key);
    const model = options.model || 'qwen-plus';

    const response = await fetch(`${BASE_URL}/api/chat/completions`, {
        method: 'POST',
        headers: headers(account),
        body: JSON.stringify({
            session_id: sessionId,
            model,
            messages: options.messages.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                ...(m.name ? { name: m.name } : {}),
            })),
            stream: true,
        })
    });
    if ((response.status === 401 || response.status === 403) && account.id !== 'env') {
        markQwenAccountInvalid(account.id);
    }
    if (!response.ok) throw new Error(`Qwen completion failed: ${response.status} ${await response.text()}`);
    return { response, sessionId, key, accountId: account.id };
}

export function parseQwenEvent(line: string, state: { contentSnapshot: string }) {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return { done: true };
    try {
        const event = JSON.parse(data) as any;
        if (event?.choices?.[0]?.delta?.content) {
            return { content: event.choices[0].delta.content };
        }
        if (event?.choices?.[0]?.delta?.reasoning_content) {
            return { reasoning: event.choices[0].delta.reasoning_content };
        }
        if (event?.choices?.[0]?.finish_reason) {
            return { done: true };
        }
        if (event?.content) {
            const text = event.content;
            if (text !== state.contentSnapshot) {
                const prev = state.contentSnapshot || '';
                state.contentSnapshot = text;
                const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
                return { content: delta };
            }
        }
        return null;
    } catch {
        return null;
    }
}
