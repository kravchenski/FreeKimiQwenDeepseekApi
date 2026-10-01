import type { Page } from 'playwright-core';

import { isVisible, viewportBox, type ViewportBox } from './dom.ts';
import { findGapX } from './gap.ts';
import { humanDrag } from './mouse.ts';
import { decodePng } from './png.ts';
import type { SliderHints, SolveOutcome } from './types.ts';

interface SliderDom {
  container: string | null;
  handle: string;
  background: string;
  piece: string;
}

const SCREENSHOT_TIMEOUT = 5_000;
const SUCCESS_TIMEOUT = 6_000;
const RESET_GRACE_MS = 1_000;
// Empirical handle->piece mapping of the Aliyun widget: piece offset =
// a*h^2 + b*h + c (fitted independently by two solvers, residual ~0).
const PIECE_CURVE = { a: 0.00355, b: 0.0769, c: -0.004 };

export function invertPieceCurve(target: number): number {
  const { a, b, c } = PIECE_CURVE;
  const disc = b * b - 4 * a * (c - target);
  if (disc < 0) return 0;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

function detectSliderInPage(rootHint: string | null) {
  const toBox = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  const toPath = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 10) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag);
      current = current.parentElement;
    }
    return parts.join('>');
  };

  const hinted = rootHint ? document.querySelector(rootHint) : null;
  if (rootHint && !hinted) return null;
  const containerSelectors = [
    '[data-captcha]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="verify" i]',
    '[id*="verify" i]',
    '[class*="nc-container"]',
    '[class*="yidun"]',
    '[class*="slider" i]',
    '[class*="jigsaw" i]',
    '[class*="puzzle" i]',
    '[class*="challenge" i]',
  ];
  const candidates: Element[] = hinted ? [hinted] : [];
  if (!hinted) {
    for (const selector of containerSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        const box = toBox(element);
        if (visible(element) && box.width >= 140 && box.height >= 60) candidates.push(element);
      }
    }
    candidates.push(document.body);
  }

  const extract = (container: Element) => {
    const root = container;
    const images = [...root.querySelectorAll('img')].filter(element => visible(element) && !element.getAttribute('src')?.startsWith('data:image/gif'));
    const backgrounds = [...root.querySelectorAll('[style*="background" i], [class*="bg" i], [class*="background" i]')].filter(element => {
      if (!visible(element) || element.tagName === 'IMG') return false;
      const image = getComputedStyle(element).backgroundImage;
      return image !== 'none' && image.startsWith('url(');
    });
    const background = [...images, ...backgrounds]
      .filter(element => {
        const box = toBox(element);
        return box.width >= 100 && box.height >= 50 && box.width / box.height >= 1.1;
      })
      .sort((a, b) => toBox(b).width * toBox(b).height - toBox(a).width * toBox(a).height)[0];
    if (!background) return null;
    const backgroundBox = toBox(background);

    const piece = [...images, ...backgrounds].find(element => {
      if (element === background || element.contains(background)) return false;
      const box = toBox(element);
      return box.width >= 12 && box.height >= 12
        && box.width <= backgroundBox.width * 0.85 && box.height <= backgroundBox.height * 1.1
        && box.width * box.height <= backgroundBox.width * backgroundBox.height * 0.6;
    });
    if (!piece) return null;

    const handleSelectors = [
      '[role="slider"]',
      '[class*="btn_slide"]',
      '[class*="slide" i]',
      '[class*="drag" i]',
      '[class*="handle" i]',
      '[class*="knob" i]',
      '[class*="thumb" i]',
      '[class*="btn" i]',
    ];
    let handle: Element | null = null;
    for (const selector of handleSelectors) {
      handle = [...root.querySelectorAll(selector)].find(element => {
        if (element === background || element === piece || element.contains(background)) return false;
        const box = toBox(element);
        return visible(element) && box.width <= 90 && box.height >= 16 && box.height <= 90;
      }) ?? null;
      if (handle) break;
    }
    if (!handle) return null;

    return { container: toPath(container), handle: toPath(handle), background: toPath(background), piece: toPath(piece) };
  };

  const seen = new Set<Element>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const dom = extract(candidate);
    if (dom) return dom;
  }
  return null;
}

async function waitForSliderSuccess(page: Page, dom: SliderDom, hints: SliderHints, timeoutMs = SUCCESS_TIMEOUT): Promise<boolean> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (hints.success && (await isVisible(page, hints.success))) return true;
    if (dom.container && !(await isVisible(page, dom.container))) return true;
    const handle: ViewportBox | null = await viewportBox(page, dom.handle);
    const background: ViewportBox | null = await viewportBox(page, dom.background);
    if (handle && background && handle.width <= background.width * 0.3
      && handle.x >= background.x + background.width - handle.width - 6) return true;
    // Failed verify snaps the handle back to the start and reloads the
    // challenge: stop waiting so the next attempt re-detects promptly.
    if (Date.now() - started > RESET_GRACE_MS && (!handle || !background || handle.x <= background.x + 8)) return false;
    await Bun.sleep(250);
  }
  return false;
}

export async function solveSlider(page: Page, hints: SliderHints = {}): Promise<SolveOutcome> {
  let dom: SliderDom | null = await page.evaluate(detectSliderInPage, hints.container ?? null).catch(() => null);
  if (dom) {
    if (hints.container) dom.container = hints.container;
    if (hints.handle) dom.handle = hints.handle;
    if (hints.background) dom.background = hints.background;
    if (hints.piece) dom.piece = hints.piece;
  } else if (hints.handle && hints.background && hints.piece) {
    dom = { container: hints.container ?? null, handle: hints.handle, background: hints.background, piece: hints.piece };
  }
  if (!dom) return 'absent';

  const attempts = hints.attempts ?? 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Every failed verify hands the widget a brand-new challenge, so the gap
    // must be re-detected from fresh screenshots on every attempt.
    let gap;
    try {
      const piecePng = await page.locator(dom.piece).screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT });
      const previousVisibility = await page.evaluate(selector => {
        const element = document.querySelector(selector) as HTMLElement | null;
        return element?.style.visibility ?? null;
      }, dom.piece).catch(() => null);
      await page.evaluate(selector => {
        const element = document.querySelector(selector) as HTMLElement | null;
        element?.style.setProperty('visibility', 'hidden', 'important');
      }, dom.piece).catch(() => {});
      let backgroundPng: Uint8Array;
      try {
        backgroundPng = await page.locator(dom.background).screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT });
      } finally {
        await page.evaluate(([selector, previous]) => {
          const element = document.querySelector(selector) as HTMLElement | null;
          if (!element) return;
          if (previous) element.style.setProperty('visibility', previous);
          else element.style.removeProperty('visibility');
        }, [dom.piece, previousVisibility] as const).catch(() => {});
      }
      gap = findGapX(decodePng(backgroundPng), decodePng(piecePng));
    } catch {
      hints.onAttempt?.({ attempt, solved: false });
      continue;
    }
    if (!gap) {
      hints.onAttempt?.({ attempt, solved: false });
      continue;
    }
    const handle = await viewportBox(page, dom.handle);
    const background = await viewportBox(page, dom.background);
    const piece = await viewportBox(page, dom.piece);
    if (!handle || !background || !piece) return 'failed';
    // The widget maps handle offset -> piece offset with a quadratic, not
    // linearly (piece = A*h^2 + B*h + C); drag the handle to the inverted
    // value so the piece lands on the detected gap.
    const pieceTarget = gap.x - (piece.x - background.x);
    const distance = invertPieceCurve(pieceTarget);
    if (distance < 2 || distance > background.width) {
      hints.onAttempt?.({ attempt, stage: gap.stage, x: gap.x, solved: false });
      continue;
    }
    const correct = async (offset: number): Promise<number | null> => {
      const pieceOffset = await page.evaluate(([pieceSelector, backgroundSelector]) => {
        const pieceElement = document.querySelector(pieceSelector);
        const backgroundElement = document.querySelector(backgroundSelector);
        if (!pieceElement || !backgroundElement) return null;
        return pieceElement.getBoundingClientRect().x - backgroundElement.getBoundingClientRect().x;
      }, [dom.piece, dom.background] as const).catch(() => null);
      if (pieceOffset === null) return null;
      const error = pieceTarget - pieceOffset;
      if (Math.abs(error) <= 1.5) return null;
      const slope = Math.max(0.3, 2 * PIECE_CURVE.a * offset + PIECE_CURVE.b);
      const next = offset + error / slope;
      return Math.max(0, Math.min(background.width, next));
    };
    await humanDrag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, distance, { correct });
    const solved = await waitForSliderSuccess(page, dom, hints);
    hints.onAttempt?.({ attempt, stage: gap.stage, x: gap.x, solved });
    if (solved) return 'solved';
  }
  return 'failed';
}
