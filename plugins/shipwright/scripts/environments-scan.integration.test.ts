import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ActiveTask,
  dirIO,
  planTasks,
  renderEnvironmentsDoc,
  runEnvironmentsScan,
} from "./environments-scan.ts";

const clock = { now: () => new Date("2026-11-28T03:00:00Z") };
let root: string;

function put(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "env-scan-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bareRepo(): void {
  put("package.json", JSON.stringify({ name: "x", scripts: { test: "t" } }));
  put(
    ".github/workflows/ci.yml",
    "jobs:\n  test:\n    steps:\n      - run: npm test\n",
  );
}

const run = (currentDoc: string | null, active: ActiveTask[] = []) =>
  runEnvironmentsScan({
    repo: "acme/widgets",
    io: dirIO(root),
    clock,
    currentDoc,
    activeTasks: active,
  });

describe("environments-scan on fixture repos", () => {
  it("reports a missing preview environment for plan and error tracking for review", () => {
    bareRepo();
    const r = run(null);
    const preview = r.findings.find((f) => f.id === "preview-environment");
    const errors = r.findings.find((f) => f.id === "error-tracking");
    expect(preview?.route).toBe("plan");
    expect(errors?.route).toBe("review");
    expect(errors?.choices?.length).toBeGreaterThan(1);
    const byId = Object.fromEntries(
      r.tasks.map((t) => [t.id.split("-2026")[0], t]),
    );
    expect(byId["environments-preview-environment-widgets"].kind).toBe("prd");
    expect(byId["environments-preview-environment-widgets"].hitl).toBe(true);
    expect(byId["environments-error-tracking-widgets"].status).toBe("blocked");
    expect(
      byId["environments-error-tracking-widgets"].blockedReason,
    ).toStartWith("needs-review:");
    expect(byId["environments-lockfile-widgets"].status).toBe("pending");
    expect(r.materiallyChanged).toBe(true);
  });

  it("passes a fully equipped repo", () => {
    put(
      "package.json",
      JSON.stringify({
        dependencies: {
          pino: "1",
          "@sentry/node": "1",
          "@opentelemetry/api": "1",
        },
        scripts: { "preview:up": "docker compose up" },
      }),
    );
    put("bun.lock", "");
    put(".tool-versions", "bun 1.3");
    put("compose.yaml", "services: {}");
    put(
      ".github/workflows/ci.yml",
      "jobs:\n  e2e:\n    steps:\n      - run: docker compose up -d\n      - run: bun run e2e\n  deploy:\n    steps:\n      - run: echo canary rollout\n",
    );
    const r = run(renderEnvironmentsDoc([]));
    expect(r.findings).toEqual([]);
    expect(r.metrics.outcome).toBe("no_op");
  });

  it("opens no PR and queues no duplicate tasks on an unchanged repo", () => {
    bareRepo();
    const first = run(null);
    const active: ActiveTask[] = first.tasks.map((t) => ({
      id: t.id,
      status: t.status,
    }));
    const second = run(first.doc, active);
    expect(second.materiallyChanged).toBe(false);
    expect(second.tasks).toEqual([]);
    expect(second.metrics.outcome).toBe("no_op");
    // a later week still dedups against the already-active tasks
    const later = planTasks(second.findings, "acme/widgets", active, {
      now: () => new Date("2026-12-10T00:00:00Z"),
    });
    expect(later).toEqual([]);
  });
});
