/**
 * RDY-3.3: environments-fix routing against the real task store. Plans tasks
 * with the scan's planTasks, bulk-creates them, and checks routing + dedup.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dirIO,
  planTasks,
  runEnvironmentsScan,
} from "./environments-scan.ts";
import { FixedClock } from "../../../task-store/src/clock.ts";
import { createPrismaClient, type PrismaClient } from "../../../task-store/src/prisma-client.ts";
import { TaskService } from "../../../task-store/src/task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;
const NOW = new Date("2026-11-28T12:00:00.000Z");
const REPO = "acme/widgets";

describeOrSkip("environments-fix routing (integration, RDY-3.3)", () => {
  let prisma: PrismaClient;
  let service: TaskService;
  let root: string;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    service = new TaskService(prisma, FixedClock(NOW));
    root = mkdtempSync(join(tmpdir(), "env-fix-"));
    const put = (rel: string, c: string) => {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    };
    put("package.json", JSON.stringify({ name: "x", scripts: { test: "t" } }));
    put(
      ".github/workflows/ci.yml",
      "jobs:\n  test:\n    steps:\n      - run: npm test\n",
    );
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  async function queue() {
    const active = (await service.list({ repo: REPO, limit: 1000 })).tasks.map(
      (t) => ({ id: t.id, status: t.status }),
    );
    const { findings } = runEnvironmentsScan({
      repo: REPO,
      io: dirIO(root),
      clock: { now: () => NOW },
      currentDoc: null,
      activeTasks: active,
    });
    const planned = planTasks(findings, REPO, active, { now: () => NOW });
    if (planned.length) await service.bulk(planned);
    return planned;
  }

  it("routes plan / review / auto and does not duplicate on re-run", async () => {
    const first = await queue();
    const stored = (await service.list({ repo: REPO, limit: 1000 })).tasks;
    const get = (check: string) =>
      stored.find((t) => t.id.startsWith(`environments-${check}-widgets-`));

    const preview = get("preview-environment");
    expect(preview?.kind).toBe("prd");
    expect(preview?.hitl).toBe(true);
    expect(preview?.description).toContain("docs/preview-environment.md");

    const errors = get("error-tracking");
    expect(errors?.status).toBe("blocked");
    expect(errors?.blockedReason).toStartWith("needs-review:");

    const lock = get("lockfile");
    expect(lock?.status).toBe("pending");
    expect(lock?.hitl).toBe(false);

    expect(stored.length).toBe(first.length);
    expect(await queue()).toEqual([]);
    expect((await service.list({ repo: REPO, limit: 1000 })).tasks.length).toBe(
      first.length,
    );
  });
});
