/**
 * task-store/src/validation.smoke.test.ts
 *
 * Request-validation smoke tests (ZOD-1.1). Pins the @hono/zod-openapi 1.x
 * behaviour: a JSON-body route rejects a non-JSON Content-Type with 415 and an
 * invalid body with 400. Validation fails before any handler runs, so the
 * service doubles are intentionally empty.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const ADMIN_TOKEN = "admin-token";

function makeApp() {
  return createTaskStoreApp({
    taskService: {} as TaskServiceLike,
    tokenService: {
      async validate(raw: string) {
        return raw === ADMIN_TOKEN ? { id: "tok-admin", agentId: null } : null;
      },
    } as unknown as TokenServiceLike,
    sessionService: {} as SessionServiceLike,
  });
}

describe("POST /tasks request validation", () => {
  it("returns 415 for a non-JSON Content-Type", async () => {
    const res = await makeApp().request("/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(415);
  });

  it("returns 400 for a body that fails schema validation", async () => {
    const res = await makeApp().request("/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: 123 }),
    });
    expect(res.status).toBe(400);
  });
});
