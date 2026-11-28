/**
 * task-store/src/tasks.case-insensitive.smoke.test.ts
 *
 * STI-1.3: GET /tasks/:id with a mixed-case id is passed through to the
 * service (which resolves it case-insensitively) and answered with the
 * canonical stored id.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const TOKEN = "valid-token";
const tokenService = {
  async validate(raw: string) {
    return raw === TOKEN ? { id: "tok-1", agentId: null } : null;
  },
} as unknown as TokenServiceLike;

describe("GET /tasks/:id mixed case (smoke)", () => {
  it("resolves a mixed-case id to the canonical stored task", async () => {
    const seen: string[] = [];
    const taskService = {
      async get(id: string) {
        seen.push(id);
        return id.toLowerCase() === "swi-10"
          ? {
              id: "SWI-10",
              assignee: null,
              claimedBy: null,
              repo: null,
              blockedBy: [],
            }
          : null;
      },
    } as unknown as TaskServiceLike;
    const app = createTaskStoreApp({
      taskService,
      tokenService,
      sessionService: {} as SessionServiceLike,
    });
    const res = await app.request("/tasks/sWi-10", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("SWI-10");
    expect(seen).toEqual(["sWi-10"]);
  });
});
