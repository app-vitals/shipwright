/**
 * task-store/src/list-cursor-guard.unit.test.ts
 *
 * Guard (TPG-1.2): every GET route that takes a `limit` query param must also
 * declare `cursor` and carry `nextCursor` in its 200 response schema, so a new
 * limit/offset-only list endpoint can't ship. Walks the generated OpenAPI spec.
 */

import { describe, expect, it } from "bun:test";
import { buildTaskStoreSpec } from "./generate-spec.ts";

/** Resolve a `$ref` like `#/components/schemas/Foo` against the spec. */
// biome-ignore lint/suspicious/noExplicitAny: walking an untyped spec document
function resolve(spec: any, node: any): any {
  let cur = node;
  for (let i = 0; i < 10 && cur?.$ref; i++) {
    cur = (cur.$ref as string)
      .replace(/^#\//, "")
      .split("/")
      .reduce((acc, k) => acc?.[k], spec);
  }
  return cur;
}

/** Explicit, justified exemptions — `"GET /path"` -> reason. Keep empty if possible. */
const EXEMPT: Record<string, string> = {};

// biome-ignore lint/suspicious/noExplicitAny: walking an untyped spec document
function listRoutesWithLimit(spec: any) {
  // biome-ignore lint/suspicious/noExplicitAny: spec walking
  const out: Array<{ key: string; op: any }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: spec walking
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    const op = item?.get;
    if (!op) continue;
    // biome-ignore lint/suspicious/noExplicitAny: spec walking
    const params: any[] = [
      ...(item.parameters ?? []),
      ...(op.parameters ?? []),
    ].map((p) => resolve(spec, p));
    if (params.some((p) => p?.in === "query" && p.name === "limit")) {
      out.push({ key: `GET ${path}`, op: { ...op, parameters: params } });
    }
  }
  return out;
}

describe("list routes taking ?limit also support cursor/nextCursor", () => {
  const spec = buildTaskStoreSpec();
  const routes = listRoutesWithLimit(spec);

  it("finds the known set of limit-taking list routes", () => {
    const keys = routes.map((r) => r.key);
    for (const expected of [
      "GET /tasks",
      "GET /tasks/{id}/events",
      "GET /prs",
      "GET /prs/{id}/events",
      "GET /sessions",
      "GET /verification-checks",
      "GET /coverage-snapshots",
      "GET /cron-runs",
      "GET /system-crons/{id}/triggers",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  for (const { key, op } of routes) {
    if (EXEMPT[key]) continue;

    it(`${key} declares ?cursor`, () => {
      expect(
        // biome-ignore lint/suspicious/noExplicitAny: spec walking
        op.parameters.some((p: any) => p.in === "query" && p.name === "cursor"),
      ).toBe(true);
    });

    it(`${key} returns nextCursor in its 200 response`, () => {
      const schema = resolve(
        spec,
        op.responses?.["200"]?.content?.["application/json"]?.schema,
      );
      expect(schema?.properties?.nextCursor).toBeDefined();
    });
  }

  it("keeps the exemption list honest (every entry names a real route and a reason)", () => {
    const keys = routes.map((r) => r.key);
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(keys).toContain(key);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
