const DEEPSEEK_MODEL_PREFIX = 'deepseek-';

export function targetForModel(model: unknown, qwenUrl: string, deepSeekUrl: string) {
    if (typeof model !== 'string') return qwenUrl;
    if (model.startsWith(DEEPSEEK_MODEL_PREFIX)) return deepSeekUrl;
    return qwenUrl;
}

export function extractConversationId(
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown>
) {
    const header = headers['x-conversation-id'] || headers['x-openwebui-conversation-id'];
    const value = header || body.conversation_id || body.chat_id || body.chatId;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function mergeModelLists(payloads: Array<{ data?: unknown }>) {
    const seen = new Set<string>();
    return payloads.flatMap(payload => Array.isArray(payload?.data) ? payload.data : [])
        .filter((model: any) => typeof model?.id === 'string' && !seen.has(model.id) && seen.add(model.id));
}
