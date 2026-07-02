# RACEMAKE Product Engineer Challenge — Hard

This is a small Bun + Hono TypeScript service that reads the raw `stint.telemetry.json` stream and returns a race engineer style stint analysis.

## Run

```bash
bun install
bun run analyze
bun run dev
```

Then open:

```txt
http://localhost:3000/analysis
```

`bun run analyze` writes the same analysis to `output.json`.

## What I found

### Recorder finding

`recorder.rs` encodes tyre temperatures as fixed point values:

```rust
fl: (tyres.fl * scales::TEMPERATURE) as i16
```

where:

```rust
pub const TEMPERATURE: f32 = 10.0;
```

So tyre values in JSON are not plain Celsius. They must be decoded as:

```ts
tyreTempC = raw / 10
```

### Cleaning

I treated the stream as untrusted and rejected frames outside hard limits:

- position: `0..1`
- throttle/brake: `0..1`
- gear: `-1..8`
- speed: `0..500 km/h`
- rpm: `0..15000`

The data contains one impossible frame:

```json
{
  "index": 3523,
  "ts": 199318,
  "lap": 2,
  "pos": 0.9709,
  "spd": 4021.4,
  "rpm": 64510
}
```

That frame is excluded before lap/corner/loss analysis.

### Real laps

The real racing laps are laps `1`, `2`, `3`, and `4`.

Excluded:

- lap `0`: partial start lap, recording starts at normalized position `0.400`
- lap `5`: partial end lap, recording ends around normalized position `0.420` and includes low-speed/idle tail

Lap times:

| Lap | Time |
|---:|---:|
| 1 | 1:13.789 |
| 2 | 1:13.518 |
| 3 | 1:14.069 |
| 4 | 1:13.590 |

Best lap: `2`  
Worst real lap: `3`  
Loss: `+551 ms`

## Corner detection

I intentionally do **not** detect corners from the brake pedal.

A corner is treated as a track property:

1. Resample each real lap over normalized position `0.000..1.000`.
2. Compute median `abs(steering_deg)` at each position across real laps.
3. Smooth the steering profile.
4. Detect sustained steering regions.
5. Apex is the peak of median absolute steering within that region.
6. Direction comes from the sign of median steering at the apex.

This keeps the same corner identity when a lap brakes there and another lap takes it nearly flat.

Detected corners:

| Corner | Entry | Apex | Exit | Direction |
|---|---:|---:|---:|---|
| C1 | 0.044 | 0.075 | 0.106 | right |
| C2 | 0.185 | 0.205 | 0.226 | left |
| C3 | 0.290 | 0.330 | 0.370 | right |
| C4 | 0.434 | 0.460 | 0.486 | left |
| C5 | 0.580 | 0.600 | 0.620 | right |
| C6 | 0.708 | 0.740 | 0.772 | right |
| C7 | 0.847 | 0.875 | 0.902 | left |

## Main loss

Lap `3` loses the most time to the best lap, lap `2`.

Largest localised loss:

```txt
C2, pos 0.185 → 0.226
loss: ~409 ms
```

Evidence:

| Metric | Best lap 2 | Worst lap 3 |
|---|---:|---:|
| Entry speed | 230.9 km/h | 208.6 km/h |
| Apex speed | 216.9 km/h | 182.7 km/h |
| Max brake | 0.01 | 0.45 |
| Avg throttle | 0.875 | 0.179 |

## Radio call

> Four tenths lost at C2, the left-hander from pos 0.185 to 0.226. On the best lap you carried 230.9 km/h in and stayed off the brake; on lap 3 you arrived 22.3 km/h slower, braked to 45%, and apex speed was 34.2 km/h lower. Do not turn it into a braking corner — commit to the entry and keep throttle maintenance through the apex.

Every claim in that line comes from computed numbers in `output.json`.

## Notes

The dataset does not include GPS or track map coordinates. The solution therefore uses steering shape as a curvature proxy. Confidence is medium-high for corner identity and high for the C2 time-loss call because the loss is visible directly in the lap time delta and telemetry inputs.
