/**
 * task-store/src/main.ts
 *
 * HTTP entry point for the Shipwright task-store service.
 * Service logic is not yet implemented — this placeholder starts cleanly,
 * exposes a /healthz endpoint, and logs startup so the Dockerfile ENTRYPOINT
 * and dev-tmux.ts pane work without errors.
 */

const PORT = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ status: "ok", service: "task-store" }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response("task-store service not yet implemented", {
      status: 501,
    });
  },
});

console.log(`task-store listening on http://localhost:${server.port}`);
