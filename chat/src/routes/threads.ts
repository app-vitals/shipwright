/**
 * chat/src/routes/threads.ts
 * Thread routes — stub returning 501 Not Implemented for all routes.
 * Full domain logic comes in CHT-1.2.
 */

import { Hono } from "hono";
import type { ChatAuthEnv } from "../auth.ts";

export function createThreadsRoutes(): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  app.get("/", (c) => c.json({ error: "Not Implemented" }, 501));
  app.post("/", (c) => c.json({ error: "Not Implemented" }, 501));
  app.get("/:id", (c) => c.json({ error: "Not Implemented" }, 501));
  app.patch("/:id", (c) => c.json({ error: "Not Implemented" }, 501));
  app.delete("/:id", (c) => c.json({ error: "Not Implemented" }, 501));

  return app;
}
