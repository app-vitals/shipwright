/**
 * agent/src/coding/check-production-deps.unit.test.ts
 *
 * buildProductionDeps() for check-plan and check-dev-task, exercised against
 * a loopback Bun.serve task-store double (no DB, no global patching).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { buildProductionDeps as buildDevTaskDeps } from "./check-dev-task.ts";
import { buildProductionDeps as buildPlanDeps } from "./check-plan.ts";

const ENV_KEYS = [
  "SHIPWRIGHT_TASK_STORE_URL",
  "SHIPWRIGHT_TASK_STORE_TOKEN",
  "SHIPWRIGHT_AGENT_ID",
] as const;

let server: ReturnType<typeof Bun.serve>;
const seen: { url: string; auth: string | null }[] = [];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ url: req.url, auth: req.headers.get("authorization") });
      return Response.json({ tasks: [{ id: "T-1", status: "pending" }] });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  seen.length = 0;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SHIPWRIGHT_TASK_STORE_URL = `http://127.0.0.1:${server.port}/`;
  process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "tok";
  process.env.SHIPWRIGHT_AGENT_ID = " agent-7 ";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("check-plan buildProductionDeps", () => {
  test("queries pending PRD tasks with the task-store token", async () => {
    const deps = buildPlanDeps();
    expect(deps.agentId).toBe("agent-7");
    expect(deps.clock.now()).toBeInstanceOf(Date);
    const tasks = await deps.getPrdTasks();
    expect(tasks.map((t) => t.id)).toEqual(["T-1"]);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("kind")).toBe("prd");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(seen[0].auth).toBe("Bearer tok");
  });
});

describe("check-dev-task buildProductionDeps", () => {
  test("queries ready tasks with the task-store token", async () => {
    const deps = buildDevTaskDeps();
    expect(deps.agentId).toBe("agent-7");
    expect(deps.clock.now()).toBeInstanceOf(Date);
    const tasks = await deps.getReadyTasks();
    expect(tasks.map((t) => t.id)).toEqual(["T-1"]);
    expect(new URL(seen[0].url).searchParams.get("ready")).toBe("true");
    expect(seen[0].auth).toBe("Bearer tok");
  });
});
