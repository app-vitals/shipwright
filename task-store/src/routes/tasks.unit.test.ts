/**
 * task-store/src/routes/tasks.unit.test.ts
 *
 * Unit tests for the tasks routes factory.
 * Verifies that createTasksRoutes() returns an OpenAPIHono instance
 * (not a plain Hono instance) so the routes expose OpenAPI metadata.
 *
 * These tests are purely structural — they do not make HTTP requests.
 * Behavioral smoke tests live in api.smoke.test.ts.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "bun:test";
import type { TaskServiceLike } from "../task-service.ts";
import { createTasksRoutes } from "./tasks.ts";

// ─── Minimal fake task service ────────────────────────────────────────────────

function fakeTaskService(): TaskServiceLike {
  return {
    async list() {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async get() {
      return null;
    },
    async create(data) {
      return data as never;
    },
    async update(_id, data) {
      return data as never;
    },
    async remove() {
      return;
    },
    async claim(_id, claimedBy) {
      return { id: _id, claimedBy } as never;
    },
    async heartbeat(_id) {
      return { id: _id } as never;
    },
    async complete(_id) {
      return { id: _id } as never;
    },
    async fail(_id) {
      return { id: _id } as never;
    },
    async release(_id) {
      return { id: _id } as never;
    },
    async bulk() {
      return { inserted: 0, updated: 0 };
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createTasksRoutes()", () => {
  it("returns an OpenAPIHono instance (not a plain Hono)", () => {
    const app = createTasksRoutes(fakeTaskService());
    expect(app).toBeInstanceOf(OpenAPIHono);
  });

  it("the returned app has openapi() method (OpenAPIHono API)", () => {
    const app = createTasksRoutes(fakeTaskService());
    expect(typeof app.openapi).toBe("function");
  });

  it("the returned app has getOpenAPI31Document() method", () => {
    const app = createTasksRoutes(fakeTaskService());
    expect(typeof app.getOpenAPI31Document).toBe("function");
  });

  it("generates an OpenAPI document with all 12 task route paths", () => {
    const app = createTasksRoutes(fakeTaskService());
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "Tasks", version: "1" },
    });

    const paths = Object.keys(doc.paths ?? {});

    // All 12 task endpoints must be present in the OpenAPI document.
    expect(paths).toContain("/");
    expect(paths).toContain("/bulk");
    expect(paths).toContain("/distinct");
    expect(paths).toContain("/{id}");
    expect(paths).toContain("/{id}/claim");
    expect(paths).toContain("/{id}/heartbeat");
    expect(paths).toContain("/{id}/complete");
    expect(paths).toContain("/{id}/fail");
    expect(paths).toContain("/{id}/release");
  });

  it("the list route (GET /) has a 200 response defined", () => {
    const app = createTasksRoutes(fakeTaskService());
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "Tasks", version: "1" },
    });

    const listPath = doc.paths?.["/"] as Record<string, unknown> | undefined;
    const getRoute = listPath?.get as Record<string, unknown> | undefined;
    const responses = getRoute?.responses as Record<string, unknown> | undefined;
    expect(responses?.["200"]).toBeDefined();
  });

  it("the create route (POST /) has a 201 response defined", () => {
    const app = createTasksRoutes(fakeTaskService());
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "Tasks", version: "1" },
    });

    const listPath = doc.paths?.["/"] as Record<string, unknown> | undefined;
    const postRoute = listPath?.post as Record<string, unknown> | undefined;
    const responses = postRoute?.responses as Record<string, unknown> | undefined;
    expect(responses?.["201"]).toBeDefined();
  });

  it("the delete route (DELETE /{id}) has a 204 response defined", () => {
    const app = createTasksRoutes(fakeTaskService());
    const doc = app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "Tasks", version: "1" },
    });

    const idPath = doc.paths?.["/{id}"] as Record<string, unknown> | undefined;
    const deleteRoute = idPath?.delete as Record<string, unknown> | undefined;
    const responses = deleteRoute?.responses as Record<string, unknown> | undefined;
    expect(responses?.["204"]).toBeDefined();
  });
});
