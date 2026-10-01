import type { ChatSite, WebChatModel } from '../../browser/browser-chat.ts';
import { ProviderError } from '../../core/providers/errors.ts';
import type { ChatChunk } from '../../core/providers/provider.ts';
import { bytesToLines } from '../browser-chat-provider.ts';

export const ARENA_CHAT_URL = 'https://arena.ai/text/direct';

export const ARENA_CHAT_SITE: ChatSite = {
  id: 'arena-chat',
  url: ARENA_CHAT_URL,
  inputSelector: 'textarea[name="message"]',
  responseUrl: /\/nextjs-api\/stream\/(?:create|post-to)-evaluation/,
  verificationText: /verify you are human|security verification/i,
  modelFields: model => ({ modelAId: model }),
  images: true,
  attachImages: async (page, files) => {
    const uploaded = page.waitForResponse(response => /messages-prod|r2\.cloudflare/.test(response.url()) && response.ok(), { timeout: 60_000 }).catch(() => undefined);
    await page.locator('input[type=file]').last().setInputFiles(files);
    if (!(await uploaded)) await Bun.sleep(5_000);
  },
  captcha: { checkbox: true },
  pageModels: page => page.evaluate(() => {
    const flight = [...document.querySelectorAll('script')].map(script => {
      const literal = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/.exec(script.textContent ?? '')?.[1];
      try {
        return literal ? String(JSON.parse(literal)) : '';
      } catch {
        return '';
      }
    }).join('');
    const start = flight.indexOf('"initialModels":[');
    if (start < 0) return '';
    let depth = 0;
    const from = flight.indexOf('[', start);
    for (let index = from; index < flight.length; index++) {
      if (flight[index] === '[') depth++;
      else if (flight[index] === ']' && --depth === 0) return flight.slice(from, index + 1);
    }
    return '';
  }).then(parseArenaModels),
  defaultModels: [{ id: '019b24bb-5caf-71c3-b854-37d0c7086f21', name: 'Max' }],
};

export function parseArenaModels(json: string): WebChatModel[] {
  let models: Array<{ id?: unknown; publicName?: unknown; displayName?: unknown; userSelectable?: unknown; capabilities?: { inputCapabilities?: { text?: unknown }; outputCapabilities?: { text?: unknown } } }>;
  try {
    models = JSON.parse(json);
  } catch {
    return [];
  }
  return models
    .filter(model => typeof model.id === 'string' && typeof model.publicName === 'string' && model.userSelectable !== false
      && model.capabilities?.inputCapabilities?.text === true && model.capabilities?.outputCapabilities?.text === true)
    .map(model => ({ id: model.id as string, name: model.publicName as string }))
    .filter((model, index, all) => all.findIndex(other => other.name === model.name) === index);
}

function decode(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function failure(value: unknown) {
  const message = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message)
    : JSON.stringify(value);
  const text = String(message).slice(0, 300);
  if (/recaptcha|captcha|verif/i.test(text)) {
    return new ProviderError(`Arena asks for a verification; complete it in the browser window or run: bun run account open ${ARENA_CHAT_URL}`, 'unavailable');
  }
  if (/rate|limit|too many/i.test(text)) return new ProviderError(`Arena rate limit: ${text}`, 'rate_limit', 429);
  return new ProviderError(`Arena chat failed: ${text}`, 'upstream');
}

export function parseArenaEvent(line: string): ChatChunk | 'done' | null {
  const match = /^a([0-9a-z]):(.*)$/.exec(line.trim());
  if (!match) {
    const body = line.trim().startsWith('{') ? decode(line.trim()) : undefined;
    if (body?.error) throw failure(body.error);
    return null;
  }
  const [, kind, payload] = match;
  const value = decode(payload!);
  if (kind === '3') throw failure(value ?? payload);
  if (kind === 'd') return 'done';
  if (typeof value !== 'string' || !value) return null;
  if (kind === '0') return { type: 'content', text: value };
  if (kind === 'g') return { type: 'reasoning', text: value };
  return null;
}

export async function* parseArenaStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<ChatChunk> {
  for await (const line of bytesToLines(bytes)) {
    const parsed = parseArenaEvent(line);
    if (parsed === 'done') return;
    if (parsed) yield parsed;
  }
}
