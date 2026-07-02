import type { StintTelemetry } from "./telemetry/types";
import { analyzeTelemetry } from "./telemetry/analysis";

const telemetry = (await Bun.file("data/stint.telemetry.json").json()) as StintTelemetry;
const analysis = analyzeTelemetry(telemetry);

await Bun.write("output.json", `${JSON.stringify(analysis, null, 2)}\n`);

console.log("Wrote output.json");
