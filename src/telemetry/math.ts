import type { CleanFrame } from "./types";

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function movingAverage(values: number[], window: number): number[] {
  const radius = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j];
        count++;
      }
    }
    return count === 0 ? 0 : sum / count;
  });
}

export function timeWeightedAverage<T extends { ts: number }>(
  frames: T[],
  value: (frame: T) => number,
): number {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return value(sorted[0]);

  let weighted = 0;
  let duration = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const dt = sorted[i + 1].ts - sorted[i].ts;
    if (dt > 0 && dt < 1000) {
      weighted += value(sorted[i]) * dt;
      duration += dt;
    }
  }

  if (duration === 0) {
    return sorted.reduce((sum, frame) => sum + value(frame), 0) / sorted.length;
  }

  return weighted / duration;
}

export function timePercent<T extends { ts: number }>(
  frames: T[],
  predicate: (frame: T) => boolean,
): number {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  let total = 0;
  let hit = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const dt = sorted[i + 1].ts - sorted[i].ts;
    if (dt > 0 && dt < 1000) {
      total += dt;
      if (predicate(sorted[i])) hit += dt;
    }
  }

  return total === 0 ? 0 : (hit / total) * 100;
}

export function interpolateField(
  frames: CleanFrame[],
  field: keyof Pick<CleanFrame, "spd" | "thr" | "brk" | "str" | "rpm">,
  pos: number,
): number {
  const points = [...frames]
    .map((frame) => [frame.pos, Number(frame[field])] as const)
    .sort((a, b) => a[0] - b[0]);

  const xs: number[] = [];
  const ys: number[] = [];

  for (const [x, y] of points) {
    if (xs.length > 0 && Math.abs(x - xs[xs.length - 1]) < 1e-9) {
      ys[ys.length - 1] = y;
    } else {
      xs.push(x);
      ys.push(y);
    }
  }

  if (pos <= xs[0]) return ys[0];
  if (pos >= xs[xs.length - 1]) return ys[ys.length - 1];

  let lo = 0;
  let hi = xs.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] < pos) lo = mid + 1;
    else hi = mid - 1;
  }

  const j = lo;
  const x0 = xs[j - 1];
  const x1 = xs[j];
  const y0 = ys[j - 1];
  const y1 = ys[j];
  const t = (pos - x0) / (x1 - x0);
  return y0 + (y1 - y0) * t;
}

export function interpolateSeries(
  frames: CleanFrame[],
  field: keyof Pick<CleanFrame, "spd" | "thr" | "brk" | "str" | "rpm">,
  grid: number[],
): number[] {
  return grid.map((pos) => interpolateField(frames, field, pos));
}

export function elapsedTimeAtPositions(
  frames: CleanFrame[],
  lapTimeMs: number,
  grid: number[],
): number[] {
  const startTs = Math.min(...frames.map((frame) => frame.ts));
  const points = [
    [0, 0],
    ...frames.map((frame) => [frame.pos, frame.ts - startTs]),
    [1, lapTimeMs],
  ].sort((a, b) => a[0] - b[0]);

  const xs: number[] = [];
  const ys: number[] = [];

  for (const [x, y] of points) {
    if (xs.length > 0 && Math.abs(x - xs[xs.length - 1]) < 1e-9) {
      ys[ys.length - 1] = y;
    } else {
      xs.push(x);
      ys.push(y);
    }
  }

  return grid.map((pos) => {
    if (pos <= xs[0]) return ys[0];
    if (pos >= xs[xs.length - 1]) return ys[ys.length - 1];

    let lo = 0;
    let hi = xs.length - 1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (xs[mid] < pos) lo = mid + 1;
      else hi = mid - 1;
    }

    const j = lo;
    const x0 = xs[j - 1];
    const x1 = xs[j];
    const y0 = ys[j - 1];
    const y1 = ys[j];
    const t = (pos - x0) / (x1 - x0);
    return y0 + (y1 - y0) * t;
  });
}

export function formatLapTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}
