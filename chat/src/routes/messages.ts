/**
 * chat/src/routes/messages.ts
 * Message routes — stub returning 501 Not Implemented for all routes.
 * Full domain logic comes in CHT-1.2.
 */

import { Hono } from "hono";
import type { ChatAuthEnv } from "../auth.ts";
import { PayloadTooLargeError } from "../errors.ts";

/** Maximum allowed size for message attachment bytes (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function createMessagesRoutes(): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  app.get("/", (c) => c.json({ error: "Not Implemented" }, 501));

  // POST /messages — attachment size guard enforced before domain logic.
  // attachmentBytes maps to a Postgres bytea column loaded in full on every
  // Message read; cap at MAX_ATTACHMENT_BYTES to prevent WAL bloat.
  app.post("/", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON or empty body — let the domain layer handle validation.
    }

    if (body.attachmentBytes !== undefined) {
      let byteLength = 0;
      if (typeof body.attachmentBytes === "string") {
        // base64-encoded: decoded size ≈ length × 0.75
        byteLength = Math.ceil((body.attachmentBytes.length * 3) / 4);
      } else if (body.attachmentBytes instanceof Uint8Array) {
        byteLength = body.attachmentBytes.byteLength;
      }
      if (byteLength > MAX_ATTACHMENT_BYTES) {
        throw new PayloadTooLargeError(
          `attachmentBytes exceeds the 10 MB limit (received ~${Math.round(byteLength / 1024 / 1024)} MB)`,
        );
      }
    }

    return c.json({ error: "Not Implemented" }, 501);
  });

  app.get("/:id", (c) => c.json({ error: "Not Implemented" }, 501));
  app.patch("/:id", (c) => c.json({ error: "Not Implemented" }, 501));
  app.delete("/:id", (c) => c.json({ error: "Not Implemented" }, 501));

  return app;
}
