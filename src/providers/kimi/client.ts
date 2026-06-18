const ZENMUX_BASE = 'https://zenmux.ai/api/v1';
const PREFIX = 'moonshotai';

type CompletionOptions = {
  messages: Array<Record<string, any>>;
  model?: string;
  conversationId?: string;
};

export async function kimiCompletion(options: CompletionOptions) {
  const apiKey = process.env.ZENMUX_API_KEY;
  if (!apiKey) throw new Error('ZENMUX_API_KEY не задан. Получите ключ на https://zenmux.ai');

  const model = `${PREFIX}/${options.model || 'kimi-k2.6'}`;
  const response = await fetch(`${ZENMUX_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kimi (ZenMux) completion failed: ${response.status} ${text}`);
  }

  return { response };
}

export function parseKimiEvent(raw: string, state?: Record<string, any>): Record<string, any> | null {
  if (!raw.startsWith('data: ')) return null;
  const json = raw.slice(6).trim();
  if (json === '[DONE]') return { done: true };
  try {
    const event = JSON.parse(json);
    const choice = event?.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta || {};
    const content = delta.content;
    if (choice.finish_reason === 'stop') return { done: true };
    if (typeof content === 'string' && content) return { content };
    return null;
  } catch {
    return null;
  }
}

export function isEmptyToolCallResponse(content: string) {
  return /^\s*(?:```json\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\]\s*\}(?:\s*```)?\s*$/i.test(content);
}
