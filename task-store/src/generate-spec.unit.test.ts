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

  it("includes /prs paths", () => {
    const spec = buildTaskStoreSpec() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const prPaths = paths.filter((p) => p.startsWith("/prs"));
    expect(prPaths.length).toBeGreaterThan(0);
  });
});
