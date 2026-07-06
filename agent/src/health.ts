import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { Server } from "bun";
import { Hono } from "hono";
import type { AnalyticsSummary } from "./analytics.ts";
import { type Clock, SystemClock } from "./clock.ts";
import {
  type CronHandlerDeps,
  ValidationError,
  handleCronRequest,
} from "./cron-handler.ts";

/**
 * Shared connection state — mutated by index.ts as Slack socket connects/disconnects.
 *
 * `downSince` is the epoch-ms timestamp of the connected→disconnected transition
 * (anchored to the FIRST drop, see markSlackDisconnected), or `null` when the
 * socket is up or has never connected. It is the anchor for the grace-window
 * wedge detection in /health.
 */
export const slackState = {
  connected: false,
  downSince: null as number | null,
};

/**
 * How long the Slack socket may stay down before /health reports unhealthy (500).
 * Sized above the liveness probe blip tolerance so transient reconnects don't
 * trip the probe, while a sustained wedge does. K8s liveness on /health is
 * periodSeconds=30, failureThreshold=3 — ~90s of failures triggers a restart.
 */
export const SLACK_DOWN_GRACE_MS = 90_000;

/** Default port for the dedicated health server (SHIPWRIGHT_HEALTH_PORT). */
export const DEFAULT_HEALTH_PORT = 3459;

/** Mark the Slack socket as connected and clear the down-timer. */
export function markSlackConnected(): void {
  slackState.connected = true;
  slackState.downSince = null;
}

/**
 * Mark the Slack socket as disconnected.
 *
 * Anchors `downSince` to the FIRST drop only — repeated `error`/`disconnecting`
 * events while already down must not keep resetting the timer (that would let a
 * flapping-but-wedged socket extend the grace window indefinitely).
 */
export function markSlackDisconnected(clock: Clock): void {
  slackState.connected = false;
  if (slackState.downSince === null) {
    slackState.downSince = clock.now().getTime();
  }
}

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

/**
 * Start a minimal HTTP health server for K8s liveness probes.
 *
 * GET  /health → 200 { ok: true, slack: "connected" | "disconnected" }
 *              → 500 { ok: false, slack: "disconnected" } when the socket has
 *                been down longer than `graceMs` (sustained wedge)
 * GET  /stats  → 200 { ...AnalyticsSummary } (optional, returns 404 if no summarize fn)
 * GET  /cron   → 405 Method Not Allowed
 * POST /cron   → run a cron prompt through Claude and post result to Slack
 *               503 if cronDeps not configured
 *               400 for bad JSON or missing jobId/prompt
 *               422 for ValidationError (e.g. missing delivery target)
 *               500 for runner errors
 *               200 on success
 * Other routes → 404
 *
 * /health returns 500 ONLY when the Slack socket has been continuously down for
 * longer than `graceMs` — this is the self-heal path: a sustained wedge trips the
 * K8s liveness probe → pod restart → fresh socket. Transient reconnect blips and
 * the not-yet-connected startup window (downSince === null) stay 200 so the pod
 * is not killed during normal reconnects or cold start.
 *
 * `sentryClient` is optional — when absent (Sentry not initialized, i.e.
 * SENTRY_DSN unset), the POST /cron catch block simply skips the capture call
 * and behaves exactly as before. Only unhandled runner/delivery errors are
 * reported; ValidationError (422) is an expected, typed outcome and is not.
 */
export function startHealthServer(
  port: number,
  summarize?: (date?: string) => AnalyticsSummary,
  cronDeps?: CronHandlerDeps,
  clock: Clock = SystemClock(),
  graceMs: number = SLACK_DOWN_GRACE_MS,
  sentryClient?: ErrorCapturingClient,
): Server<undefined> {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        const wedged =
          !slackState.connected &&
          slackState.downSince !== null &&
          clock.now().getTime() - slackState.downSince > graceMs;
        if (wedged) {
          return Response.json(
            { ok: false, slack: "disconnected" },
            { status: 500 },
          );
        }
        return Response.json({
          ok: true,
          slack: slackState.connected ? "connected" : "disconnected",
        });
      }

      if (url.pathname === "/stats" && req.method === "GET" && summarize) {
        const date = url.searchParams.get("date") ?? undefined;
        return Response.json(summarize(date));
      }

      if (url.pathname === "/cron" && req.method === "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (url.pathname === "/cron" && req.method === "POST") {
        if (!cronDeps) {
          return Response.json(
            { error: "cron handler not configured" },
            { status: 503 },
          );
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).jobId !== "string" ||
          typeof (body as Record<string, unknown>).prompt !== "string"
        ) {
          return Response.json(
            { error: "missing required fields: jobId, prompt" },
            { status: 400 },
          );
        }
        const { jobId, prompt, channel, user, silent, preCheck } =
          body as Record<string, unknown>;
        try {
          await handleCronRequest(
            {
              jobId: jobId as string,
              prompt: prompt as string,
              channel: typeof channel === "string" ? channel : undefined,
              user: typeof user === "string" ? user : undefined,
              silent: typeof silent === "boolean" ? silent : undefined,
              preCheck: typeof preCheck === "string" ? preCheck : undefined,
            },
            cronDeps,
          );
          return Response.json({ ok: true });
        } catch (err) {
          if (err instanceof ValidationError) {
            return Response.json({ error: err.message }, { status: 422 });
          }
          sentryClient?.captureException(err);
          console.error("[agent:cron] handler error:", err);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}
