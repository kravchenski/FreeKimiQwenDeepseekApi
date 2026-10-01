import type { Page } from 'playwright-core';

import { type ViewportBox } from './dom.ts';
import { humanClick } from './mouse.ts';
import type { CheckboxHints, SolveOutcome } from './types.ts';

const CHECKBOX_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha.com/checkbox"]',
].join(', ');

const RESPONSE_SELECTORS = [
  'input[name="cf-turnstile-response"]',
  'textarea[name="cf-turnstile-response"]',
  '.h-captcha-response',
  'textarea[name="h-captcha-response"]',
  'input[name="h-captcha-response"]',
].join(', ');

const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_CLICK_AFTER_MS = 6_000;

async function checkboxBox(page: Page, selector: string): Promise<ViewportBox | null> {
  return page
    .evaluate(sel => {
      const frame = [...document.querySelectorAll('iframe')].find(element => {
        if (!element.matches(sel)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      });
      if (!frame) return null;
      frame.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = frame.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector)
    .catch(() => null);
}

async function hasResponse(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate(sel => [...document.querySelectorAll(sel)].some(element => {
      const value = (element as HTMLInputElement | HTMLTextAreaElement).value;
      return typeof value === 'string' && value.length > 20;
    }), selector)
    .catch(() => false);
}

export async function solveCheckbox(page: Page, hints: CheckboxHints = {}): Promise<SolveOutcome> {
  const iframe = hints.iframe ?? CHECKBOX_SELECTORS;
  const response = hints.response ?? RESPONSE_SELECTORS;
  const timeoutMs = hints.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const box = await checkboxBox(page, iframe);
  if (!box) return 'absent';

  const click = (target: ViewportBox) => humanClick(page, target.x + Math.min(34, Math.max(16, target.width * 0.14)), target.y + target.height / 2);
  await click(box);

  const started = Date.now();
  let retried = false;
  while (Date.now() - started < timeoutMs) {
    await Bun.sleep(400);
    if (await hasResponse(page, response)) return 'solved';
    const current = await checkboxBox(page, iframe);
    if (!current) return 'solved';
    if (!retried && Date.now() - started >= SECOND_CLICK_AFTER_MS) {
      retried = true;
      await click(current);
    }
  }
  return (await hasResponse(page, response)) || !(await checkboxBox(page, iframe)) ? 'solved' : 'failed';
}
