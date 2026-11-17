import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  adminSessionCookie,
  CANARY_REPO,
  createTask,
  deleteTask,
  uniqueName,
} from "./client.ts";
import type { Targets } from "./targets.ts";

// A real loopback HTTP server on an ephemeral port stands in for the deployed
// services, so client.ts's fetch-based helpers run unmodified.
let server: ReturnType<typeof Bun.serve>;
let base: string;
let lastCreateBody: Record<string, unknown> | undefined;
let lastAuth: string | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      lastAuth = req.headers.get("Authorization");
      if (url.pathname === "/ok/admin/dev-login") {
        return new Response(null, {
          status: 302,
          headers: { "Set-Cookie": "admin_session=abc; HttpOnly" },
        });
      }
      if (url.pathname === "/bad/admin/dev-login") {
        return new Response("nope", { status: 200 });
      }
      if (url.pathname === "/ok/tasks" && req.method === "POST") {
        lastCreateBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: "task-1" }, { status: 201 });
      }
      if (url.pathname === "/bad/tasks" && req.method === "POST") {
        return new Response("boom", { status: 500 });
      }
      if (url.pathname.startsWith("/ok/tasks/") && req.method === "DELETE") {
        return new Response(null, {
          status: url.pathname.endsWith("gone") ? 404 : 204,
        });
      }
      if (url.pathname.startsWith("/bad/tasks/") && req.method === "DELETE") {
        return new Response("denied", { status: 403 });
      }
      return new Response("unexpected", { status: 418 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const targets = (prefix: "ok" | "bad"): Targets => ({
  adminUrl: `${base}/${prefix}`,
  metricsUrl: "",
  taskStoreUrl: `${base}/${prefix}`,
  chatUrl: "",
  mcpUrl: "",
  taskStoreToken: "ts-token",
  mcpToken: "",
});

describe("uniqueName", () => {
  it("appends a random hex suffix", () => {
    const a = uniqueName("canary");
    expect(a).toMatch(/^canary-[0-9a-f]{8}$/);
    expect(uniqueName("canary")).not.toBe(a);
  });
});

describe("adminSessionCookie", () => {
  it("returns the session cookie from a 302 dev-login", async () => {
    expect(await adminSessionCookie(`${base}/ok`)).toBe("admin_session=abc");
  });

  it("throws when dev-login does not issue a session", async () => {
    await expect(adminSessionCookie(`${base}/bad`)).rejects.toThrow(
      "did not issue a session (status 200)",
    );
  });
});

describe("createTask / deleteTask", () => {
  it("creates a canary task with the bearer token and status override", async () => {
    const task = await createTask(targets("ok"), { status: "approved" });
    expect(task.id).toBe("task-1");
    expect(task.title).toMatch(/^canary-task-/);
    expect(lastAuth).toBe("Bearer ts-token");
    expect(lastCreateBody).toMatchObject({
      repo: CANARY_REPO,
      status: "approved",
      session: task.session,
    });
  });

  it("defaults the status to pending", async () => {
    await createTask(targets("ok"));
    expect(lastCreateBody?.status).toBe("pending");
  });

  it("throws when creation does not return 201", async () => {
    await expect(createTask(targets("bad"))).rejects.toThrow(
      "task create failed: 500 boom",
    );
  });

  it("deletes idempotently, tolerating 404", async () => {
    await deleteTask(targets("ok"), "t1");
    await deleteTask(targets("ok"), "gone");
  });

  it("throws on other delete failures", async () => {
    await expect(deleteTask(targets("bad"), "t1")).rejects.toThrow(
      "task delete failed: 403 denied",
    );
  });
});
