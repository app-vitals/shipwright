// Integration tests for register-planning-documents.ts — injected store double
// plus a fixture planning tree on disk.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localContentSource,
  type PlanDocumentRow,
  type PlanningStoreClient,
  registerPlanningSessions,
  type TaskRow,
} from "./register-planning-documents";

const clock = { now: () => new Date("2026-11-17T12:00:00.000Z") };

function fakeStore(tasks: TaskRow[] = []) {
  const docs: PlanDocumentRow[] = [];
  const writes = { register: 0, patchDoc: 0, patchTask: 0 };
  const taskPatches: Array<{ id: string; patch: unknown }> = [];
  const client: PlanningStoreClient = {
    async listDocuments({ session }) {
      return docs.filter((d) => d.session === session);
    },
    async registerDocument(input) {
      writes.register++;
      const i = docs.findIndex(
        (d) => d.session === input.session && d.kind === input.kind && d.number === input.number,
      );
      const row: PlanDocumentRow = {
        id: i >= 0 ? docs[i].id : `doc-${docs.length + 1}`,
        plannedAt: i >= 0 ? docs[i].plannedAt : null,
        ...input,
      };
      if (i >= 0) docs[i] = row;
      else docs.push(row);
      return row;
    },
    async patchDocument(id, patch) {
      writes.patchDoc++;
      const d = docs.find((x) => x.id === id);
      if (d) d.plannedAt = patch.plannedAt;
    },
    async listTasks({ source }) {
      return tasks.filter((t) => t.source === source);
    },
    async patchTask(id, patch) {
      writes.patchTask++;
      taskPatches.push({ id, patch });
      const t = tasks.find((x) => x.id === id);
      if (t) t.planDocumentId = patch.planDocumentId;
    },
  };
  return { client, docs, writes, taskPatches };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plan-reg-"));
  const dir = join(root, "planning", "x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAN.md"), "# The plan\n");
  writeFileSync(join(dir, "PRODUCT-SPEC.md"), "# The spec\n");
  writeFileSync(join(dir, "SPEC-0002.md"), "# Second spec\n");
  writeFileSync(join(dir, "AUDIT.md"), "# audit\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (client: PlanningStoreClient, dryRun = false) =>
  registerPlanningSessions({
    client,
    source: localContentSource(root),
    repo: "org/repo",
    clock,
    dryRun,
  });

describe("registerPlanningSessions", () => {
  it("second run makes zero creates and zero updates", async () => {
    const store = fakeStore();
    const first = await run(store.client);
    expect(first.created).toBe(3);
    expect(first.errors).toEqual([]);
    const second = await run(store.client);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.linked).toBe(0);
  });

  it("marks spec 1 planned when a plan exists", async () => {
    const store = fakeStore();
    await run(store.client);
    const spec1 = store.docs.find((d) => d.kind === "spec" && d.number === 1);
    const spec2 = store.docs.find((d) => d.kind === "spec" && d.number === 2);
    expect(spec1?.plannedAt).toBe("2026-11-17T12:00:00.000Z");
    expect(spec2?.plannedAt).toBeNull();
  });

  it("links a task by source, writing only planDocumentId", async () => {
    const task: TaskRow = { id: "T-1", source: "planning/x/PLAN.md", planDocumentId: null };
    const other: TaskRow = { id: "T-2", source: "planning/y/PLAN.md", planDocumentId: null };
    const store = fakeStore([task, other]);
    const res = await run(store.client);
    expect(res.linked).toBe(1);
    expect(store.taskPatches).toEqual([
      { id: "T-1", patch: { planDocumentId: store.docs.find((d) => d.kind === "plan")?.id } },
    ]);
    expect(other.planDocumentId).toBeNull();
  });

  it("reports non-standard files and creates no row for them", async () => {
    const store = fakeStore();
    const res = await run(store.client);
    expect(res.reported).toEqual([{ path: "planning/x/AUDIT.md", reason: "non-standard file" }]);
    expect(store.docs.some((d) => d.path.endsWith("AUDIT.md"))).toBe(false);
  });

  it("reports a second file claiming spec 1 instead of registering it", async () => {
    writeFileSync(join(root, "planning", "x", "SPEC-0001.md"), "# dup\n");
    const store = fakeStore();
    const res = await run(store.client);
    expect(res.reported.some((r) => r.path.endsWith("SPEC-0001.md") && /duplicate spec 1/.test(r.reason))).toBe(true);
  });

  it("dry-run performs no writes but reports what it would do", async () => {
    const task: TaskRow = { id: "T-1", source: "planning/x/PLAN.md", planDocumentId: null };
    const store = fakeStore([task]);
    const res = await run(store.client, true);
    expect(res.dryRun).toBe(true);
    expect(res.created).toBe(3);
    expect(res.linked).toBe(1);
    expect(store.writes).toEqual({ register: 0, patchDoc: 0, patchTask: 0 });
    expect(store.docs).toHaveLength(0);
  });

  it("returns errors instead of throwing when the store fails", async () => {
    const store = fakeStore();
    store.client.listDocuments = async () => {
      throw new Error("store down");
    };
    const res = await run(store.client);
    expect(res.errors).toEqual(["x: store down"]);
  });

  it("skips documents homed in another repo and still links tasks", async () => {
    const task: TaskRow = { id: "T-1", source: "planning/x/PLAN.md", planDocumentId: null };
    const store = fakeStore([task]);
    await run(store.client); // repo A ("org/repo") registers first
    const rootB = mkdtempSync(join(tmpdir(), "plan-reg-b-"));
    try {
      const dir = join(rootB, "planning", "x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PLAN.md"), "# Other title\n");
      const runB = () =>
        registerPlanningSessions({
          client: store.client,
          source: localContentSource(rootB),
          repo: "org/other",
          clock,
        });
      const before = store.docs.map((d) => ({ ...d }));
      const res = await runB();
      expect(res.created).toBe(0);
      expect(res.updated).toBe(0);
      expect(res.reported).toEqual([
        {
          path: "planning/x/PLAN.md",
          reason: "skipped: document homed in another repo (org/repo)",
        },
      ]);
      expect(store.docs).toEqual(before);
      expect(store.docs.find((d) => d.kind === "plan")?.title).toBe("The plan");
      const again = await runB();
      expect(again.created + again.updated).toBe(0);
      const rerunA = await run(store.client);
      expect(rerunA.created + rerunA.updated).toBe(0);
      // Repo A's run already linked T-1 to the existing document; a task still
      // unlinked is linked from repo B too.
      task.planDocumentId = null;
      const linkRes = await runB();
      expect(linkRes.linked).toBe(1);
      expect<string | null>(task.planDocumentId).toBe(
        store.docs.find((d) => d.kind === "plan")?.id ?? null,
      );
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
