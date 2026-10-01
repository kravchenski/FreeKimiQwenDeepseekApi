import type { Page } from 'playwright-core';

export interface ViewportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function viewportBox(page: Page, selector: string): Promise<ViewportBox | null> {
  return page
    .evaluate(sel => {
      const element = document.querySelector(sel);
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector)
    .catch(() => null);
}

export async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate(sel => {
      const element = document.querySelector(sel);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    }, selector)
    .catch(() => false);
}
