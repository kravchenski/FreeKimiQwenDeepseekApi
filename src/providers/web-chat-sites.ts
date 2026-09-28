import type { ChatSite } from '../browser/browser-chat.ts';
import { ZAI_CHAT_SITE } from './glm/web.ts';
import { KIMI_CHAT_SITE } from './kimi/web.ts';

export const WEB_CHAT_SITES: ChatSite[] = [ZAI_CHAT_SITE, KIMI_CHAT_SITE];

export function siteForUrl(url: string, sites: ChatSite[] = WEB_CHAT_SITES) {
  const host = new URL(url).hostname;
  return sites.find(site => new URL(site.url).hostname === host);
}
