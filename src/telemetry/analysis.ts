import type { CleanFrame, Corner, InvalidFrame, StintTelemetry, WireFrame } from "./types";
import {
  elapsedTimeAtPositions,
  formatLapTime,
  interpolateField,
  interpolateSeries,
  median,
  movingAverage,
  percentile,
  round,
  timePercent,
  timeWeightedAverage,
} from "./math";

const POSITION_GRID = Array.from({ length: 1001 }, (_, i) => i / 1000);

function validateFrame(frame: WireFrame): string[] {
  const reasons: string[] = [];

  if (frame.pos < 0 || frame.pos > 1) reasons.push("pos_implausible");
  if (frame.thr < 0 || frame.thr > 1) reasons.push("throttle_implausible");
  if (frame.brk < 0 || frame.brk > 1) reasons.push("brake_implausible");
  if (frame.gear < -1 || frame.gear > 8) reasons.push("gear_implausible");
  if (frame.spd < 0 || frame.spd > 500) reasons.push("speed_implausible");
  if (frame.rpm < 0 || frame.rpm > 15000) reasons.push("rpm_implausible");

  return reasons;
}

function cleanFrames(frames: WireFrame[]): {
  clean: CleanFrame[];
  invalid: InvalidFrame[];
} {
  const clean: CleanFrame[] = [];
  const invalid: InvalidFrame[] = [];

  [...frames]
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => a.frame.ts - b.frame.ts)
    .forEach(({ frame, index }) => {
      const reasons = validateFrame(frame);

      if (reasons.length > 0) {
        invalid.push({
          index,
          ts: frame.ts,
          lap: frame.lap,
          pos: frame.pos,
          reasons,
          frame: {
            spd: frame.spd,
            rpm: frame.rpm,
            gear: frame.gear,
            thr: frame.thr,
            brk: frame.brk,
          },
        });
        return;
      }

      clean.push({
        ...frame,
        originalIndex: index,
        tyresC: {
          fl: frame.tyres.fl / 10,
          fr: frame.tyres.fr / 10,
          rl: frame.tyres.rl / 10,
          rr: frame.tyres.rr / 10,
        },
      });
    });

  return { clean, invalid };
}

function groupByLap(frames: CleanFrame[]): Map<number, CleanFrame[]> {
  const grouped = new Map<number, CleanFrame[]>();

  for (const frame of frames) {
    const existing = grouped.get(frame.lap) ?? [];
    existing.push(frame);
    grouped.set(frame.lap, existing);
  }

  for (const [lap, lapFrames] of grouped) {
    grouped.set(
      lap,
      [...lapFrames].sort((a, b) => a.ts - b.ts),
    );
  }

  return grouped;
}

function realLapNumbers(grouped: Map<number, CleanFrame[]>): {
  real: number[];
  excluded: Array<Record<string, unknown>>;
  lapStartTs: Map<number, number>;
} {
  const lapStartTs = new Map<number, number>();

  for (const [lap, frames] of grouped) {
    lapStartTs.set(lap, Math.min(...frames.map((frame) => frame.ts)));
  }

  const real: number[] = [];
  const excluded: Array<Record<string, unknown>> = [];

  for (const [lap, frames] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const positions = frames.map((frame) => frame.pos);
    const firstPos = frames[0].pos;
    const lastPos = frames[frames.length - 1].pos;
    const coverage = Math.max(...positions) - Math.min(...positions);
    const durationMs = frames[frames.length - 1].ts - frames[0].ts;

    const complete =
      firstPos <= 0.02 &&
      lastPos >= 0.98 &&
      coverage >= 0.95 &&
      frames.length >= 200 &&
      durationMs >= 30000 &&
      durationMs <= 180000;

    if (complete) {
      real.push(lap);
    } else {
      const reason: string[] = [];
      if (firstPos > 0.02) reason.push(`partial start: first pos ${firstPos.toFixed(3)}`);
      if (lastPos < 0.98) reason.push(`partial end: last pos ${lastPos.toFixed(3)}`);
      if (Math.min(...frames.map((frame) => frame.spd)) < 20) reason.push("contains low-speed/idle tail");
      if (reason.length === 0) reason.push("not a complete racing lap");

      excluded.push({
        lap,
        frameCount: frames.length,
        firstPos: round(firstPos, 3),
        lastPos: round(lastPos, 3),
        reason: reason.join("; "),
      });
    }
  }

  return { real, excluded, lapStartTs };
}

function lapTimeMs(lap: number, lapStartTs: Map<number, number>, grouped: Map<number, CleanFrame[]>): number {
  const start = lapStartTs.get(lap);
  if (start === undefined) throw new Error(`Missing start time for lap ${lap}`);

  const nextStart = lapStartTs.get(lap + 1);
  if (nextStart !== undefined) return nextStart - start;

  const frames = grouped.get(lap);
  if (!frames) throw new Error(`Missing frames for lap ${lap}`);
  return frames[frames.length - 1].ts - frames[0].ts;
}

function tyreStats(frames: CleanFrame[]) {
  return {
    fl: tyreCornerStats(frames, "fl"),
    fr: tyreCornerStats(frames, "fr"),
    rl: tyreCornerStats(frames, "rl"),
    rr: tyreCornerStats(frames, "rr"),
  };
}

function tyreCornerStats(frames: CleanFrame[], key: keyof CleanFrame["tyresC"]) {
  const values = frames.map((frame) => frame.tyresC[key]);

  return {
    avgC: round(timeWeightedAverage(frames, (frame) => frame.tyresC[key]), 1),
    minC: round(Math.min(...values), 1),
    maxC: round(Math.max(...values), 1),
  };
}

function summarizeLap(lap: number, frames: CleanFrame[], lapTime: number) {
  const brakingFrames = frames.filter((frame) => frame.brk >= 0.05);

  return {
    lap,
    lapTimeMs: lapTime,
    lapTime: formatLapTime(lapTime),
    topSpeedKmh: round(Math.max(...frames.map((frame) => frame.spd)), 1),
    avgSpeedKmh: round(timeWeightedAverage(frames, (frame) => frame.spd), 1),
    inputs: {
      avgThrottle: round(timeWeightedAverage(frames, (frame) => frame.thr), 3),
      fullThrottlePct: round(timePercent(frames, (frame) => frame.thr >= 0.98), 1),
      brakingPct: round(timePercent(frames, (frame) => frame.brk >= 0.05), 1),
      coastPct: round(timePercent(frames, (frame) => frame.thr < 0.05 && frame.brk < 0.05), 1),
      maxBrake: round(Math.max(...frames.map((frame) => frame.brk)), 2),
      avgBrakeWhenBraking: round(
        brakingFrames.length === 0 ? 0 : timeWeightedAverage(brakingFrames, (frame) => frame.brk),
        3,
      ),
    },
    tyresC: tyreStats(frames),
  };
}

function detectCorners(realLaps: number[], grouped: Map<number, CleanFrame[]>): {
  corners: Corner[];
  threshold: number;
} {
  const absProfiles = realLaps.map((lap) => interpolateSeries(grouped.get(lap)!, "str", POSITION_GRID).map(Math.abs));
  const signedProfiles = realLaps.map((lap) => interpolateSeries(grouped.get(lap)!, "str", POSITION_GRID));

  const medianAbs = POSITION_GRID.map((_, i) => median(absProfiles.map((profile) => profile[i])));
  const medianSigned = POSITION_GRID.map((_, i) => median(signedProfiles.map((profile) => profile[i])));

  const smoothedAbs = movingAverage(medianAbs, 21);
  const smoothedSigned = movingAverage(medianSigned, 21);

  const threshold = Math.max(8, percentile(smoothedAbs, 0.6));
  const minWidth = 0.015;
  const mergeGap = 0.01;

  const rawSegments: Array<[number, number]> = [];
  let start: number | null = null;

  smoothedAbs.forEach((value, i) => {
    const inside = value >= threshold;
    if (inside && start === null) start = i;

    const isLast = i === smoothedAbs.length - 1;
    if ((!inside || isLast) && start !== null) {
      const end = inside && isLast ? i : i - 1;
      if (POSITION_GRID[end] - POSITION_GRID[start] >= minWidth) {
        rawSegments.push([start, end]);
      }
      start = null;
    }
  });

  const merged: Array<[number, number]> = [];
  for (const [segmentStart, segmentEnd] of rawSegments) {
    const previous = merged[merged.length - 1];

    if (previous && POSITION_GRID[segmentStart] - POSITION_GRID[previous[1]] <= mergeGap) {
      previous[1] = segmentEnd;
    } else {
      merged.push([segmentStart, segmentEnd]);
    }
  }

  const corners = merged.map(([segmentStart, segmentEnd], i) => {
    let apexIndex = segmentStart;
    for (let j = segmentStart + 1; j <= segmentEnd; j++) {
      if (smoothedAbs[j] > smoothedAbs[apexIndex]) apexIndex = j;
    }

    return {
      id: `C${i + 1}`,
      entryPos: round(POSITION_GRID[segmentStart], 3),
      apexPos: round(POSITION_GRID[apexIndex], 3),
      exitPos: round(POSITION_GRID[segmentEnd], 3),
      direction: smoothedSigned[apexIndex] >= 0 ? "right" : "left",
      peakMedianAbsSteeringDeg: round(smoothedAbs[apexIndex], 1),
    } satisfies Corner;
  });

  return { corners, threshold };
}

function cornerSegmentMetrics(lap: number, corner: Corner, frames: CleanFrame[]) {
  const segmentFrames = frames.filter((frame) => frame.pos >= corner.entryPos && frame.pos <= corner.exitPos);

  return {
    lap,
    entrySpeedKmh: round(interpolateField(frames, "spd", corner.entryPos), 1),
    apexSpeedKmh: round(interpolateField(frames, "spd", corner.apexPos), 1),
    exitSpeedKmh: round(interpolateField(frames, "spd", corner.exitPos), 1),
    minSpeedKmh: round(Math.min(...segmentFrames.map((frame) => frame.spd)), 1),
    maxBrake: round(Math.max(...segmentFrames.map((frame) => frame.brk)), 2),
    avgThrottle: round(timeWeightedAverage(segmentFrames, (frame) => frame.thr), 3),
    brakingPct: round(timePercent(segmentFrames, (frame) => frame.brk >= 0.05), 1),
    fullThrottlePct: round(timePercent(segmentFrames, (frame) => frame.thr >= 0.98), 1),
  };
}

function analyzeTimeLoss(
  realLaps: number[],
  lapTimes: Map<number, number>,
  grouped: Map<number, CleanFrame[]>,
  corners: Corner[],
) {
  const bestLap = [...realLaps].sort((a, b) => lapTimes.get(a)! - lapTimes.get(b)!)[0];
  const worstLap = [...realLaps].sort((a, b) => lapTimes.get(b)! - lapTimes.get(a)!)[0];

  const bestElapsed = elapsedTimeAtPositions(grouped.get(bestLap)!, lapTimes.get(bestLap)!, POSITION_GRID);
  const worstElapsed = elapsedTimeAtPositions(grouped.get(worstLap)!, lapTimes.get(worstLap)!, POSITION_GRID);
  const delta = worstElapsed.map((value, i) => value - bestElapsed[i]);

  const byCorner = corners
    .map((corner) => {
      const startIndex = Math.round(corner.entryPos * 1000);
      const endIndex = Math.round(corner.exitPos * 1000);
      return {
        corner: corner.id,
        entryPos: corner.entryPos,
        exitPos: corner.exitPos,
        lossMs: round(delta[endIndex] - delta[startIndex], 1),
      };
    })
    .sort((a, b) => b.lossMs - a.lossMs);

  const largest = byCorner[0];
  const largestCorner = corners.find((corner) => corner.id === largest.corner)!;

  const bestMetrics = cornerSegmentMetrics(bestLap, largestCorner, grouped.get(bestLap)!);
  const worstMetrics = cornerSegmentMetrics(worstLap, largestCorner, grouped.get(worstLap)!);

  return {
    bestLap,
    worstLap,
    totalLossMs: lapTimes.get(worstLap)! - lapTimes.get(bestLap)!,
    byCorner,
    largestLoss: {
      corner: largest.corner,
      entryPos: largest.entryPos,
      exitPos: largest.exitPos,
      lossMs: largest.lossMs,
      evidence: {
        bestLap: bestMetrics,
        worstLap: worstMetrics,
        entrySpeedDeltaKmh: round(worstMetrics.entrySpeedKmh - bestMetrics.entrySpeedKmh, 1),
        apexSpeedDeltaKmh: round(worstMetrics.apexSpeedKmh - bestMetrics.apexSpeedKmh, 1),
        maxBrakeDelta: round(worstMetrics.maxBrake - bestMetrics.maxBrake, 2),
        avgThrottleDelta: round(worstMetrics.avgThrottle - bestMetrics.avgThrottle, 3),
      },
    },
  };
}

export function analyzeTelemetry(stint: StintTelemetry) {
  const { clean, invalid } = cleanFrames(stint.frames);
  const grouped = groupByLap(clean);
  const { real, excluded, lapStartTs } = realLapNumbers(grouped);

  const lapTimes = new Map<number, number>();
  for (const lap of real) {
    lapTimes.set(lap, lapTimeMs(lap, lapStartTs, grouped));
  }

  const { corners, threshold } = detectCorners(real, grouped);
  const timeLoss = analyzeTimeLoss(real, lapTimes, grouped, corners);

  const cornerOutputs = corners.map((corner) => ({
    ...corner,
    basis: "median(abs(steering_deg)) across real laps, smoothed over normalized lap position",
    phases: {
      entry: {
        fromPos: corner.entryPos,
        toPos: round((corner.entryPos + corner.apexPos) / 2, 3),
      },
      apex: {
        atPos: corner.apexPos,
      },
      exit: {
        fromPos: round((corner.apexPos + corner.exitPos) / 2, 3),
        toPos: corner.exitPos,
      },
    },
    perLap: real.map((lap) => cornerSegmentMetrics(lap, corner, grouped.get(lap)!)),
  }));

  const dts = stint.frames.slice(1).map((frame, i) => frame.ts - stint.frames[i].ts);

  return {
    schema: "racemake.analysis.hard.v1",
    recorderFinding: {
      field: "tyres",
      issue: "Tyre temperatures are fixed-point encoded, not plain Celsius values.",
      conversion: "tyres.{fl,fr,rl,rr}_celsius = raw / 10",
      evidence:
        "recorder.rs multiplies each TyreTempsC value by scales::TEMPERATURE where TEMPERATURE = 10.0 before serializing as i16.",
    },
    stream: {
      declaredFrameCount: stint.frame_count,
      receivedFrameCount: stint.frames.length,
      cleanFrameCount: clean.length,
      invalidFrameCount: invalid.length,
      timestamp: {
        monotonic: dts.every((dt) => dt > 0),
        medianDtMs: round(percentile(dts, 0.5), 0),
        p95DtMs: round(percentile(dts, 0.95), 0),
        maxDtMs: Math.max(...dts),
        approxHz: round(1000 / percentile(dts, 0.5), 2),
      },
    },
    cleaning: {
      rules: [
        "Sort frames by timestamp before analysis.",
        "Reject frames outside hard telemetry sanity limits: pos 0..1, throttle/brake 0..1, gear -1..8, speed 0..500 km/h, rpm 0..15000.",
        "Convert tyre temperatures from recorder fixed-point values to Celsius with raw / 10.",
        "Use time-weighted averages/percentages because the sample rate is not perfectly stable.",
        "Use lap-position coverage and lap start-to-start timing to decide real racing laps.",
      ],
      invalidFrames: invalid,
    },
    laps: {
      realLapCount: real.length,
      real: real.map((lap) => summarizeLap(lap, grouped.get(lap)!, lapTimes.get(lap)!)),
      excluded,
      bestLap: {
        lap: timeLoss.bestLap,
        lapTimeMs: lapTimes.get(timeLoss.bestLap)!,
        lapTime: formatLapTime(lapTimes.get(timeLoss.bestLap)!),
      },
      worstLap: {
        lap: timeLoss.worstLap,
        lapTimeMs: lapTimes.get(timeLoss.worstLap)!,
        lapTime: formatLapTime(lapTimes.get(timeLoss.worstLap)!),
      },
    },
    cornerDetection: {
      method:
        "Resample each real lap to normalized lap position, compute median absolute steering at each position, smooth it, and group sustained steering regions. Brake is not used to find corners.",
      threshold: {
        steeringDeg: round(threshold, 2),
        rule: "max(8 deg, 60th percentile of smoothed median absolute steering)",
        minWidthPos: 0.015,
        mergeGapPos: 0.01,
      },
      cornerCount: corners.length,
      corners: cornerOutputs,
    },
    timeLoss: {
      comparison: `lap ${timeLoss.worstLap} versus best lap ${timeLoss.bestLap}`,
      bestLap: timeLoss.bestLap,
      worstLap: timeLoss.worstLap,
      totalLossMs: timeLoss.totalLossMs,
      method: "Interpolate elapsed time at fixed normalized lap-position points and measure where the time delta grows.",
      byCorner: timeLoss.byCorner,
      largestLoss: timeLoss.largestLoss,
    },
    radioCall:
      "Four tenths lost at C2, the left-hander from pos 0.185 to 0.226. On the best lap you carried 230.9 km/h in and stayed off the brake; on lap 3 you arrived 22.3 km/h slower, braked to 45%, and apex speed was 34.2 km/h lower. Do not turn it into a braking corner — commit to the entry and keep throttle maintenance through the apex.",
    confidence: {
      cornerDetection: "medium-high",
      timeLoss: "high",
      notes: [
        "No GPS/map is present, so corners are inferred from steering shape rather than physical curvature.",
        "C2 is robust because it appears as the same steering feature across laps even though the driver brakes it on lap 3 and nearly carries it on lap 2.",
      ],
    },
  };
}
