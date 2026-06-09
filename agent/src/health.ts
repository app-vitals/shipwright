import type { Server } from "bun";
import { Hono } from "hono";
import { type CronHandlerDeps, ValidationError, handleCronRequest } from "./cron-handler.ts";

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
 * Start a minimal HTTP server for liveness probes and cron dispatch.
 *
 * GET  /health → 200 { ok: true }
 * GET  /cron   → 405 Method Not Allowed
 * POST /cron   → run a cron prompt through Claude and post result to Slack
 *               503 if cronDeps not configured
 *               400 for bad JSON or missing jobId/prompt
 *               422 for ValidationError (e.g. missing delivery target)
 *               500 for runner errors
 *               200 on success
 * Other routes → 404
 */
export function startHealthServer(
  port: number,
  cronDeps?: CronHandlerDeps,
): Server<undefined> {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true });
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
          console.error("[agent:cron] handler error:", err);
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}
