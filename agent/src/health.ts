import { Hono } from "hono";

/**
 * Create a minimal Hono health app for container liveness probes.
 *
 * GET /health → 200 { status: "ok" }
 *
 * No Slack state — the Shipwright reference agent is a CLI runner, not a
 * long-lived Slack socket process.
 */
export function createHealthApp(): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}
