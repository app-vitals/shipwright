import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  adminSessionCookie,
  bearer,
  createTask,
  deleteTask,
  loadTargets,
  parseQueueTasksBlocked,
  poll,
} from "./client.ts";

setDefaultTimeout(45_000);

const t = loadTargets();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await deleteTask(t, id);
});

// PREVIEW_METRICS_URL already carries metrics.provider.basePath (written by
// `task preview:up --env-out` from the preview values profile).
/**
 * The metrics read API accepts an admin bearer key or an admin_session cookie.
 * The preview profile configures no metrics API keys, so the cookie from admin
 * dev-login is the credential; the task-store token is also sent in case a key
 * registry is configured with it.
 */
async function queueMetrics(
  cookie: string,
): Promise<{ status: number; tasksBlocked?: number }> {
  const res = await fetch(`${t.metricsUrl}/metrics/queue?preset=7d`, {
    headers: { ...bearer(t.taskStoreToken), Cookie: cookie },
  });
  if (res.status !== 200) return { status: res.status };
  return {
    status: 200,
    tasksBlocked: parseQueueTasksBlocked(await res.json()),
  };
}

describe("metrics canary", () => {
  it("reflects a task created in the task-store", async () => {
    const cookie = await adminSessionCookie(t.adminUrl);
    const before = await queueMetrics(cookie);
    expect(before.status).toBe(200);
    const baseline = before.tasksBlocked as number;

    const task = await createTask(t, { status: "blocked" });
    created.push(task.id);

    const dump = async (label: string) => {
      const h = bearer(t.taskStoreToken);
      const one = await fetch(`${t.taskStoreUrl}/tasks/${task.id}`, { headers: h });
      const list = await fetch(`${t.taskStoreUrl}/tasks?repo=canary/preview&limit=200&offset=0`, { headers: h });
      const lj = (await list.json()) as { tasks?: Array<{ id: string; status: string; createdAt?: string }>; total?: number };
      const q = await fetch(`${t.metricsUrl}/metrics/queue?preset=7d`, { headers: { ...h, Cookie: cookie } });
      console.log("DIAG", label, JSON.stringify({
        now: new Date().toISOString(),
        taskGet: { status: one.status, body: await one.json() },
        listStatus: list.status, listTotal: lj.total, listCount: lj.tasks?.length,
        listHasTask: lj.tasks?.some((x) => x.id === task.id),
        blockedInList: lj.tasks?.filter((x) => x.status === "blocked").length,
        metricsStatus: q.status, metricsBody: await q.text(),
      }));
    };
    await dump("t0");
    const reflected = await poll(async () => {
      const now = await queueMetrics(cookie);
      await dump("poll");
      return now.tasksBlocked !== undefined && now.tasksBlocked > baseline
        ? now.tasksBlocked
        : undefined;
    }, 30_000);
    expect(reflected).toBeGreaterThan(baseline);

    await deleteTask(t, task.id);
  });

  it("exposes read routes only", async () => {
    const cookie = await adminSessionCookie(t.adminUrl);
    const read = await queueMetrics(cookie);
    expect(read.status).toBe(200);
    const res = await fetch(`${t.metricsUrl}/metrics/queue?preset=7d`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect([404, 405]).toContain(res.status);
  });
});
