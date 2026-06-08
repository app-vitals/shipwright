/**
 * scripts/dev.unit.test.ts
 * Unit tests for scripts/dev.ts — shutdown/wiring + Taskfile target assertions.
 *
 * No mock.module(), no global.* overrides — all assertions use pure logic or
 * file reads. No process spawning.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildChildren, createShutdownHandler } from "./dev.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

// ─── Taskfile assertions ──────────────────────────────────────────────────────

describe("Taskfile.yml — run-task keys", () => {
  const taskfile = readFileSync(resolve(REPO_ROOT, "Taskfile.yml"), "utf8");

  test("has task 'api'", () => {
    expect(taskfile).toMatch(/^\s*api\s*:/m);
  });

  test("has task 'ui'", () => {
    expect(taskfile).toMatch(/^\s*ui\s*:/m);
  });

  test("has task 'dev'", () => {
    expect(taskfile).toMatch(/^\s*dev\s*:/m);
  });
});

// ─── buildChildren() shape ────────────────────────────────────────────────────

describe("buildChildren()", () => {
  test("returns at least one entry", () => {
    const children = buildChildren();
    expect(children.length).toBeGreaterThan(0);
  });

  test("includes a metrics server entry", () => {
    const children = buildChildren();
    const metrics = children.find((c) => c.label === "metrics");
    expect(metrics).toBeDefined();
  });

  test("metrics entry has METRICS_OFFLINE=true in env", () => {
    const children = buildChildren();
    const metrics = children.find((c) => c.label === "metrics");
    expect(metrics?.env?.METRICS_OFFLINE).toBe("true");
  });

  test("metrics entry includes the server entrypoint in cmd", () => {
    const children = buildChildren();
    const metrics = children.find((c) => c.label === "metrics");
    const cmdStr = Array.isArray(metrics?.cmd)
      ? metrics.cmd.join(" ")
      : metrics?.cmd ?? "";
    expect(cmdStr).toContain("metrics/src/server.ts");
  });
});

// ─── createShutdownHandler() ──────────────────────────────────────────────────

describe("createShutdownHandler()", () => {
  test("calls kill() on all passed process mocks", async () => {
    const killed: string[] = [];
    const procs = [
      {
        label: "metrics",
        kill: () => {
          killed.push("metrics");
        },
      },
      {
        label: "agent",
        kill: () => {
          killed.push("agent");
        },
      },
    ];

    const handler = createShutdownHandler(procs);
    await handler();

    expect(killed).toContain("metrics");
    expect(killed).toContain("agent");
  });

  test("handles an empty process list without throwing", async () => {
    const handler = createShutdownHandler([]);
    await expect(handler()).resolves.toBeUndefined();
  });
});
