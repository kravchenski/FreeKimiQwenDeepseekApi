import type { Page } from 'playwright-core';

import { buildDragTrajectory, type TrajectoryOptions } from './trajectory.ts';

const sleep = (ms: number) => Bun.sleep(ms);

export async function humanClick(page: Page, x: number, y: number, random: () => number = Math.random) {
  const approachX = x - 30 - random() * 70;
  const approachY = y + (random() - 0.5) * 40;
  await page.mouse.move(approachX, approachY, { steps: 6 });
  await page.mouse.move(x, y, { steps: 8 });
  await sleep(40 + random() * 80);
  await page.mouse.down();
  await sleep(50 + random() * 70);
  await page.mouse.up();
  await sleep(60 + random() * 60);
}

export interface DragOptions extends TrajectoryOptions {
  /**
   * Called while the button is held after the trajectory; return the next pointer
   * offset to move to, or null once the dragged element has reached its target.
   */
  correct?: (offset: number) => Promise<number | null>;
  correctTimeoutMs?: number;
}

export async function humanDrag(page: Page, start: { x: number; y: number }, distance: number, options: DragOptions = {}) {
  const random = options.random ?? Math.random;
  await page.mouse.move(start.x, start.y, { steps: 1 });
  await page.mouse.down();
  for (const point of buildDragTrajectory(distance, options)) {
    await page.mouse.move(start.x + point.x, start.y + point.y);
    if (point.delayMs) await sleep(point.delayMs);
  }
  if (options.correct) {
    const deadline = Date.now() + (options.correctTimeoutMs ?? 3_000);
    let offset = distance;
    while (Date.now() < deadline) {
      const next = await options.correct(offset);
      if (next === null) break;
      offset = next;
      await page.mouse.move(start.x + offset, start.y + pointJitter(random));
      await sleep(45 + random() * 35);
    }
  }
  await sleep(160 + random() * 100);
  await page.mouse.up();
  await sleep(60 + random() * 80);
}

function pointJitter(random: () => number) {
  return (random() - 0.5) * 3;
}
