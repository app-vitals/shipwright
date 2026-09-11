/**
 * task-store/src/generate-spec.integration.test.ts
 * Freshness guard: the committed task-store/openapi.json must match what
 * buildTaskStoreSpec() produces from the live route definitions.
 *
 * Real filesystem I/O on committed repo content, so this is an integration
 * test (see docs/testing.md) rather than a unit test. It exists because the
 * spec is a generated artifact that is easy to forget to regenerate when a
 * route is added — SESH-3.1 added PATCH /sessions/:slug without rerunning
 * `bun run generate:task-store-spec`, and nothing caught the drift.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTaskStoreSpec } from "./generate-spec.ts";

const SPEC_PATH = resolve(import.meta.dir, "../openapi.json");

describe("committed task-store/openapi.json", () => {
  it("is up to date with the current route definitions", () => {
    const committed = readFileSync(SPEC_PATH, "utf8");
    const expected = `${JSON.stringify(buildTaskStoreSpec(), null, 2)}\n`;

    // Compare parsed documents first for a readable diff on mismatch, then the
    // raw text so formatting drift is caught too.
    expect(JSON.parse(committed)).toEqual(JSON.parse(expected));
    expect(committed).toBe(expected);
  });
});
