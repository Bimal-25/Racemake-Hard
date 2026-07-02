import { Hono } from "hono";
import type { StintTelemetry } from "./telemetry/types";
import { analyzeTelemetry } from "./telemetry/analysis";

async function loadTelemetry(): Promise<StintTelemetry> {
  return await Bun.file("data/stint.telemetry.json").json();
}

const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "racemake-hard-solution",
    endpoints: ["/analysis"],
  }),
);

app.get("/analysis", async (c) => {
  const telemetry = await loadTelemetry();
  const analysis = analyzeTelemetry(telemetry);
  return c.json(analysis);
});

const port = Number(process.env.PORT ?? 3000);

console.log(`RACEMAKE hard analysis service running on http://localhost:${port}`);
console.log(`Open http://localhost:${port}/analysis`);

export default {
  port,
  fetch: app.fetch,
};
