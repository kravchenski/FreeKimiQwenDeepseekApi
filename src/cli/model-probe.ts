import { readLines } from '../core/streaming/sse.ts';
import { parseOpenAIEvent } from '../providers/openai-compatible.ts';

export interface ProbeOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface ProbeResult {
  model: string;
  ownedBy: string;
  ok: boolean;
  firstChunkMs?: number;
  error?: string;
}

export interface ModelInfo {
  id: string;
  ownedBy: string;
}

const PROMPT = 'Reply with one word: pong';

function headers(options: ProbeOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  };
}

export async function listGatewayModels(options: ProbeOptions): Promise<ModelInfo[]> {
  const response = await (options.fetch ?? fetch)(`${options.baseUrl}/models`, { headers: headers(options) });
  if (!response.ok) throw new Error(`GET /models failed: ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  return (body.data ?? []).flatMap(model => typeof model.id === 'string' && model.id !== 'auto'
    ? [{ id: model.id, ownedBy: typeof model.owned_by === 'string' ? model.owned_by : 'unknown' }]
    : []);
}

export function summarizeError(status: number, text: string) {
  let message = text;
  try {
    const parsed = JSON.parse(text)?.error?.message;
    if (typeof parsed === 'string') message = parsed;
  } catch {}
  if (/not found for account|page not found/i.test(message)) return `${status} not available for this key`;
  if (/maximum context length/i.test(message)) return `${status} context too small`;
  return `${status} ${message.replace(/^[\w ]+ failed: /, '').replace(/\s+/g, ' ').trim()}`.slice(0, 120);
}

async function errorText(response: Response) {
  return summarizeError(response.status, await response.text().catch(() => ''));
}

export async function probeModel(model: ModelInfo, options: ProbeOptions): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(options),
      body: JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'user', content: PROMPT }] }),
      signal: controller.signal,
    });
    if (!response.ok) return { model: model.id, ownedBy: model.ownedBy, ok: false, error: await errorText(response) };
    for await (const line of readLines(response.body)) {
      const parsed = parseOpenAIEvent(line);
      if (Array.isArray(parsed) && parsed.length) {
        return { model: model.id, ownedBy: model.ownedBy, ok: true, firstChunkMs: Date.now() - startedAt };
      }
      if (parsed === 'done') break;
    }
    return { model: model.id, ownedBy: model.ownedBy, ok: false, error: 'empty response' };
  } catch (error) {
    const message = controller.signal.aborted ? `no answer within ${options.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { model: model.id, ownedBy: model.ownedBy, ok: false, error: message.slice(0, 160) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function probeModels(
  models: ModelInfo[],
  options: ProbeOptions & { concurrency: number },
  onResult: (result: ProbeResult) => void = () => {},
) {
  const results: ProbeResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < models.length) {
      const result = await probeModel(models[next++]!, options);
      results.push(result);
      onResult(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, models.length)) }, worker));
  return results;
}

export function formatReport(results: ProbeResult[]) {
  const working = results.filter(result => result.ok).sort((a, b) => a.firstChunkMs! - b.firstChunkMs!);
  const failed = results.filter(result => !result.ok).sort((a, b) => a.model.localeCompare(b.model));
  const lines = [`Working models (${working.length}/${results.length}), fastest first:`];
  for (const result of working) lines.push(`  ✓ ${result.model.padEnd(50)} ${(result.firstChunkMs! / 1000).toFixed(1)}s  [${result.ownedBy}]`);
  lines.push('', `Not working (${failed.length}):`);
  for (const result of failed) lines.push(`  ✗ ${result.model.padEnd(50)} ${result.error}`);
  if (working.length) lines.push('', 'Working models, comma-separated (usable as AUTO_MODELS):', working.map(result => result.model).join(','));
  return lines.join('\n');
}
