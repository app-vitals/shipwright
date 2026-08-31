/**
 * scripts/demo-serve.ts
 * Static file server for demo/ — serves the sizzle slide templates at
 * http://localhost:4321/slides/*.html so demo/scenes.yaml's browser scenes
 * can screenshot them.
 *
 * Usage:
 *   bun scripts/demo-serve.ts
 */

const PORT = 4321;
const ROOT = new URL("../demo/", import.meta.url).pathname;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const path =
      new URL(req.url).pathname === "/"
        ? "/index.html"
        : new URL(req.url).pathname;
    const file = Bun.file(`${ROOT}${path}`);
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[demo:serve] serving ${ROOT} at http://localhost:${PORT}`);
