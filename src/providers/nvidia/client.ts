const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

type CompletionOptions = {
  messages: Array<Record<string, any>>;
  model?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  extra_body?: Record<string, any>;
};

export async function nvidiaCompletion(options: CompletionOptions) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY не задан. Получите ключ на https://build.nvidia.com');

  const model = options.model || 'deepseek-ai/deepseek-v4-pro';
  const response = await fetch(`${NVIDIA_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: options.stream ?? true,
      temperature: options.temperature ?? 1,
      top_p: options.top_p ?? 0.95,
      max_tokens: options.max_tokens ?? 8192,
      ...options.extra_body,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NVIDIA completion failed: ${response.status} ${text}`);
  }

  return { response };
}

export function parseNvidiaEvent(raw: string): Record<string, any> | null {
  if (!raw.startsWith('data: ')) return null;
  const json = raw.slice(6).trim();
  if (json === '[DONE]') return { done: true };
  try {
    const event = JSON.parse(json);
    const choice = event?.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta || {};
    const content = delta.content;
    const reasoning = delta.reasoning_content;
    if (choice.finish_reason === 'stop') return { done: true };
    if (typeof reasoning === 'string' && reasoning) return { reasoning };
    if (typeof content === 'string' && content) return { content };
    return null;
  } catch {
    return null;
  }
}
