/**
 * Integration tests for agent-readiness-scorer.ts — a fixture repo on disk,
 * recorded GitHub and task-store responses served through injected doubles,
 * and an injected Clock. The scorer must post one ReadinessSnapshot and one
 * RepoCronRun, queue no tasks and modify no repo file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dirReader,
  runScorer,
  scoreRepo,
  taskStoreClients,
} from "./agent-readiness-scorer.ts";
import type { RecorderDeps } from "./cron-run-recorder.ts";
import type {
  BranchProtection,
  BranchRule,
  CronRun,
  DetectorDeps,
  PatrolFinding,
  SystemCron,
} from "./readiness-api-detectors.ts";
import {
  computeLevel,
  READINESS_CATALOGUE,
  READINESS_CATALOGUE_VERSION,
} from "./readiness-catalogue.ts";

const REPO = "acme/widgets";
const SHA = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const NOW = "2026-11-28T00:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const fixtures = join(import.meta.dir, "test-helpers/fixtures/readiness");
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;

let root: string;
const put = (rel: string, content: string) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

/** A small Node repo that clears Level 1 but not Level 2. */
function fixtureRepo(): void {
  put("README.md", "# widgets\n");
  put(
    "package.json",
    JSON.stringify({
      name: "widgets",
      scripts: { lint: "biome lint .", test: "bun test" },
      devDependencies: { "@biomejs/biome": "1", typescript: "5" },
    }),
  );
  put("biome.json", "{}");
  put("tsconfig.json", "{}");
  put("src/index.ts", "export const a = 1;\n");
  put("src/index.test.ts", "import {} from 'bun:test';\n");
}

function snapshotFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function recorded() {
  const calls: Call[] = [];
  const runs = load<CronRun[]>("cron-runs.json");
  const findings = load<PatrolFinding[]>("patrol-findings.json");
  const crons = load<SystemCron[]>("system-crons.json");
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    const cronId = u.searchParams.get("cronId");
    const repo = u.searchParams.get("repo");
    if (method === "POST") return json({ id: "x" }, 201);
    if (u.pathname === "/cron-runs/latest") {
      const hit = runs
        .filter((r) => r.cronId === cronId && r.repo === repo)
        .filter((r) => r.outcome !== "failed")
        .at(-1);
      return hit ? json(hit) : json({ error: "none" }, 404);
    }
    if (u.pathname === "/cron-runs") {
      const hits = runs.filter((r) => r.cronId === cronId && r.repo === repo);
      return json({ runs: hits.reverse(), nextCursor: null });
    }
    if (u.pathname === "/patrol-findings") {
      const status = u.searchParams.get("status");
      return json({
        findings: findings.filter(
          (f) =>
            f.cronId === cronId &&
            f.repo === repo &&
            (!status || f.status === status),
        ),
        nextCursor: null,
      });
    }
    if (u.pathname === "/system-crons") return json({ systemCrons: crons });
    return json({ error: "unexpected" }, 500);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function detectorDeps(fetchFn: typeof fetch): DetectorDeps {
  const protection: BranchProtection = load(
    "github-protection-required-ci.json",
  );
  const rules: BranchRule[] = [];
  const { taskStore, systemCrons } = taskStoreClients({
    fetchFn,
    baseUrl: "http://store",
    token: "t",
  });
  return {
    clock,
    taskStore,
    systemCrons,
    github: {
      getDefaultBranch: async () => "main",
      getBranchProtection: async () => protection,
      getBranchRules: async () => rules,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "readiness-scorer-"));
  fixtureRepo();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scoreRepo", () => {
  test("produces the expected level and per-check results", async () => {
    const { fetchFn } = recorded();
    const score = await scoreRepo(REPO, dirReader(root), detectorDeps(fetchFn));
    expect(score.checks).toHaveLength(READINESS_CATALOGUE.length);
    const byId = Object.fromEntries(score.checks.map((c) => [c.id, c]));
    expect(byId["readme-present"]).toEqual({
      id: "readme-present",
      level: 1,
      result: "pass",
      owner: "docs-freshness",
    });
    expect(byId["linter-configured"].result).toBe("pass");
    expect(byId["unit-tests-exist"].result).toBe("pass");
    expect(byId["default-branch-protected"].result).toBe("pass");
    expect(byId["docs-fresh"].result).toBe("pass");
    expect(byId["codeowners-present"].result).toBe("fail");
    expect(byId["agent-instructions-present"].result).toBe("fail");
    // Level 1 passes, Level 2 does not.
    expect(score.level).toBe(1);
    expect(score.passing + score.failing).toBeLessThanOrEqual(
      score.checks.length,
    );
    expect(score.failing).toBe(
      score.checks.filter((c) => c.result === "fail").length,
    );
    expect(score.level).toBe(
      computeLevel(
        Object.fromEntries(score.checks.map((c) => [c.id, c.result])),
      ),
    );
  });

  test("a failing source fails its checks instead of throwing", async () => {
    const { fetchFn } = recorded();
    const deps = detectorDeps(fetchFn);
    deps.github.getDefaultBranch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const score = await scoreRepo(REPO, dirReader(root), deps);
    expect(
      score.checks.find((c) => c.id === "default-branch-protected")?.result,
    ).toBe("fail");
  });
});

describe("runScorer", () => {
  function recorderDeps(fetchFn: typeof fetch): RecorderDeps {
    return {
      fetchFn,
      clock,
      baseUrl: "http://store",
      token: "t",
      readFile: () => null,
      deleteFile: () => {},
      log: () => {},
    };
  }

  test("posts one snapshot and one run, queues no tasks, touches no repo file", async () => {
    const { calls, fetchFn } = recorded();
    const before = snapshotFiles(root);
    const score = await runScorer({
      repo: REPO,
      commitSha: SHA,
      reader: dirReader(root),
      detectorDeps: detectorDeps(fetchFn),
      recorderDeps: recorderDeps(fetchFn),
    });
    expect(snapshotFiles(root)).toEqual(before);

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.path.split("?")[0]).sort()).toEqual([
      "/cron-runs",
      "/readiness-snapshots",
    ]);
    expect(posts.some((p) => p.path.startsWith("/tasks"))).toBe(false);

    const snap = posts.find((p) => p.path === "/readiness-snapshots")?.body;
    expect(snap).toMatchObject({
      repo: REPO,
      commitSha: SHA,
      level: score.level,
      passing: score.passing,
      failing: score.failing,
      catalogueVersion: String(READINESS_CATALOGUE_VERSION),
    });
    expect((snap?.checks as unknown[] | undefined)?.length).toBe(
      READINESS_CATALOGUE.length,
    );

    const run = posts.find((p) => p.path === "/cron-runs")?.body;
    expect(run).toMatchObject({
      cronId: "agent-readiness",
      repo: REPO,
      commitSha: SHA,
      outcome: "ok",
      metrics: {},
    });
  });

  test("records a failed run when the snapshot post is rejected", async () => {
    const rec = recorded();
    const failing = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (
        init?.method === "POST" &&
        String(url).endsWith("/readiness-snapshots")
      ) {
        rec.calls.push({ method: "POST", path: "/readiness-snapshots" });
        return new Response("{}", { status: 400 });
      }
      return rec.fetchFn(url, init);
    }) as unknown as typeof fetch;
    await expect(
      runScorer({
        repo: REPO,
        commitSha: SHA,
        reader: dirReader(root),
        detectorDeps: detectorDeps(failing),
        recorderDeps: recorderDeps(failing),
      }),
    ).rejects.toThrow(/readiness-snapshots/);
    const run = rec.calls.find((c) => c.path === "/cron-runs");
    expect(run?.body?.outcome).toBe("failed");
  });
});
