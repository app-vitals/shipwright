import { afterAll, describe, expect, it } from "bun:test";
import {
  bearer,
  CANARY_REPO,
  deleteTask,
  loadTargets,
  uniqueName,
} from "./client.ts";

const t = loadTargets();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await deleteTask(t, id);
});

describe("task-store canary", () => {
  it("creates, reads, updates and deletes a task", async () => {
    const title = uniqueName("canary-task");
    const headers = {
      ...bearer(t.taskStoreToken),
      "Content-Type": "application/json",
    };

    const createRes = await fetch(`${t.taskStoreUrl}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, status: "pending", repo: CANARY_REPO }),
    });
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()) as { id: string; title: string };
    created.push(task.id);
    expect(task.title).toBe(title);

    const readRes = await fetch(`${t.taskStoreUrl}/tasks/${task.id}`, {
      headers,
    });
    expect(readRes.status).toBe(200);
    expect(((await readRes.json()) as { title: string }).title).toBe(title);

    const patchRes = await fetch(`${t.taskStoreUrl}/tasks/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { status: string }).status).toBe(
      "in_progress",
    );

    const deleteRes = await fetch(`${t.taskStoreUrl}/tasks/${task.id}`, {
      method: "DELETE",
      headers,
    });
    expect(deleteRes.status).toBe(204);

    const goneRes = await fetch(`${t.taskStoreUrl}/tasks/${task.id}`, {
      headers,
    });
    expect(goneRes.status).toBe(404);
  });

  it("rejects a create without a token with 401", async () => {
    const res = await fetch(`${t.taskStoreUrl}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: uniqueName("canary-unauth"),
        status: "pending",
        repo: CANARY_REPO,
      }),
    });
    expect(res.status).toBe(401);
  });
});
