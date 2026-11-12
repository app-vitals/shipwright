/**
 * task-store/src/generate-spec.unit.test.ts
 * Verify the task-store OpenAPI spec generator produces a valid
 * OpenAPI 3.1 document that covers all three route groups.
 *
 * Uses buildTaskStoreSpec() in memory — no filesystem I/O.
 */

import { describe, expect, it } from "bun:test";
import { buildTaskStoreSpec } from "./generate-spec.ts";

describe("buildTaskStoreSpec", () => {
  it("returns a valid OpenAPI 3.1 document", () => {
    const spec = buildTaskStoreSpec() as Record<string, unknown>;
    expect(spec.openapi).toBe("3.1.0");
  });

  it("includes /tasks paths", () => {
    const spec = buildTaskStoreSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const taskPaths = paths.filter((p) => p.startsWith("/tasks"));
    expect(taskPaths.length).toBeGreaterThan(0);
  });

  it("includes /tokens paths", () => {
    const spec = buildTaskStoreSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const tokenPaths = paths.filter((p) => p.startsWith("/tokens"));
    expect(tokenPaths.length).toBeGreaterThan(0);
  });

  it("documents the optional {to} body and 400 response on POST /tasks/{id}/unblock (UBL-1.1)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: walking an untyped spec document
    const spec = buildTaskStoreSpec() as any;
    const op = spec.paths["/tasks/{id}/unblock"].post;
    expect(op.requestBody.required).toBeFalsy();
    const schema = op.requestBody.content["application/json"].schema;
    const resolved = schema.$ref
      ? spec.components.schemas[schema.$ref.split("/").pop()]
      : schema;
    expect(resolved.properties.to.enum).toEqual([
      "pending",
      "pr_open",
      "merged",
      "deployed",
      "released",
    ]);
    expect(op.responses["400"]).toBeDefined();
    expect(op.responses["409"]).toBeDefined();
  });

  it("includes /prs paths", () => {
    const spec = buildTaskStoreSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const prPaths = paths.filter((p) => p.startsWith("/prs"));
    expect(prPaths.length).toBeGreaterThan(0);
  });

  it("includes /sessions paths, covering the admin-only PATCH", () => {
    const spec = buildTaskStoreSpec() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const paths = Object.keys(spec.paths ?? {});

    const sessionPaths = paths.filter((p) => p.startsWith("/sessions"));
    expect(sessionPaths).toContain("/sessions");
    expect(sessionPaths).toContain("/sessions/{slug}");
    expect(Object.keys(spec.paths["/sessions/{slug}"] ?? {}).sort()).toEqual([
      "get",
      "patch",
    ]);
  });
});
