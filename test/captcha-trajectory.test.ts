import { describe, expect, test } from 'bun:test';

import { buildDragTrajectory } from '../src/browser/captcha/trajectory.ts';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('buildDragTrajectory', () => {
  test('ends exactly on the target distance', () => {
    const points = buildDragTrajectory(150, { random: seededRandom(7) });
    expect(points.length).toBeGreaterThanOrEqual(14);
    const last = points[points.length - 1];
    expect(last.x).toBe(150);
    expect(last.y).toBe(0);
  });

  test('keeps points inside the distance plus overshoot', () => {
    const random = seededRandom(42);
    const distance = 150;
    const points = buildDragTrajectory(distance, { random });
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBeTrue();
      expect(Number.isFinite(point.y)).toBeTrue();
      expect(point.x).toBeGreaterThan(-6);
      expect(point.x).toBeLessThanOrEqual(distance + 12);
      expect(Math.abs(point.y)).toBeLessThan(8);
      expect(point.delayMs).toBeGreaterThan(0);
    }
  });

  test('overshoots the target and corrects back', () => {
    const points = buildDragTrajectory(200, { random: seededRandom(3) });
    let peak = 0;
    for (const point of points) peak = Math.max(peak, point.x);
    expect(peak).toBeGreaterThan(200);
    expect(peak).toBeLessThanOrEqual(212);
    let backtracked = 0;
    let previous = 0;
    for (const point of points) {
      if (point.x + 1 < previous) backtracked++;
      previous = Math.max(previous, point.x);
    }
    expect(backtracked).toBeGreaterThanOrEqual(5);
    expect(backtracked).toBeLessThanOrEqual(12);
    expect(points[points.length - 1].x).toBe(200);
  });

  test('handles zero distance without overshoot', () => {
    const points = buildDragTrajectory(0, { random: seededRandom(11) });
    expect(points[points.length - 1].x).toBe(0);
    for (const point of points) expect(Math.abs(point.x)).toBeLessThanOrEqual(0.001);
  });

  test('supports negative distances', () => {
    const points = buildDragTrajectory(-80, { random: seededRandom(5) });
    const last = points[points.length - 1];
    expect(last.x).toBe(-80);
    for (const point of points) expect(point.x).toBeGreaterThanOrEqual(-92);
  });
});
