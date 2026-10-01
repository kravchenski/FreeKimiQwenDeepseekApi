export interface TrajectoryPoint {
  x: number;
  y: number;
  delayMs: number;
}

export interface TrajectoryOptions {
  steps?: number;
  random?: () => number;
  /** dPiece/dHandle slope of the widget's quadratic map at the target. */
  slope?: number;
}

/**
 * Ballistic overshoot-and-correct profile: fast start / slow approach
 * (1-(1-t)^3), overshoot the target by 6-11px, then correct back in
 * multiple steps and release exactly on the target. Aliyun scores drag
 * kinematics — a monotonic smoothstep lands the piece pixel-correct yet is
 * rejected as a bot, while this profile passes.
 */
export function buildDragTrajectory(distance: number, options: TrajectoryOptions = {}): TrajectoryPoint[] {
  const random = options.random ?? Math.random;
  if (distance === 0) return [{ x: 0, y: 0, delayMs: 1 }];
  const sign = Math.sign(distance);
  const overshoot = sign * (6 + random() * 5);
  const over = distance + overshoot;
  const ballistic = Math.max(20, options.steps ?? 42);
  const points: TrajectoryPoint[] = [];
  for (let index = 1; index <= ballistic; index++) {
    const t = index / ballistic;
    const eased = 1 - (1 - t) ** 3;
    points.push({
      x: over * eased,
      y: Math.sin(t * 5) * 1.2,
      delayMs: 11 + (index % 4) * 4,
    });
  }
  const correction = 10;
  for (let index = 1; index <= correction; index++) {
    const t = index / correction;
    points.push({
      x: over + (distance - over) * t,
      y: (random() - 0.5) * 1.2,
      delayMs: Math.round(20 + random() * 15),
    });
  }
  const last = points[points.length - 1];
  if (last) {
    last.x = distance;
    last.y = 0;
  }
  return points;
}
