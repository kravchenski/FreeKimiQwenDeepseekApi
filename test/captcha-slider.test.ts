import { describe, expect, test } from 'bun:test';

import { invertPieceCurve } from '../src/browser/captcha/slider.ts';

const PIECE_CURVE = { a: 0.00355, b: 0.0769, c: -0.004 };
const pieceAt = (handle: number) => PIECE_CURVE.a * handle * handle + PIECE_CURVE.b * handle + PIECE_CURVE.c;

describe('invertPieceCurve', () => {
  test('round-trips piece targets through the handle curve', () => {
    for (const handle of [10, 50, 100, 153, 209, 232, 253]) {
      const target = pieceAt(handle);
      expect(Math.abs(invertPieceCurve(target) - handle)).toBeLessThan(0.5);
    }
  });

  test('maps a piece target below the raw handle distance', () => {
    expect(invertPieceCurve(171)).toBeGreaterThan(200);
    expect(invertPieceCurve(171)).toBeLessThan(220);
  });

  test('is monotonic over the reachable range', () => {
    let previous = -1;
    for (let target = 0; target <= 248; target += 4) {
      const handle = invertPieceCurve(target);
      expect(handle).toBeGreaterThan(previous);
      previous = handle;
    }
  });

  test('returns a safe value for out-of-range targets', () => {
    expect(Number.isFinite(invertPieceCurve(0))).toBeTrue();
    expect(invertPieceCurve(0)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(invertPieceCurve(400))).toBeTrue();
  });
});
