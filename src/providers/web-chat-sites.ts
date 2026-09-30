import type { ChatSite } from '../browser/browser-chat.ts';
import { ARENA_CHAT_SITE } from './arena/web.ts';
import { ZAI_CHAT_SITE } from './glm/web.ts';
import { KIMI_CHAT_SITE } from './kimi/web.ts';
import { QWEN_CHAT_SITE } from './qwen/web.ts';

export const WEB_CHAT_SITES: ChatSite[] = [QWEN_CHAT_SITE, ZAI_CHAT_SITE, KIMI_CHAT_SITE, ARENA_CHAT_SITE];

export function siteForUrl(url: string, sites: ChatSite[] = WEB_CHAT_SITES) {
  const host = new URL(url).hostname;
  return sites.find(site => new URL(site.url).hostname === host);
}
