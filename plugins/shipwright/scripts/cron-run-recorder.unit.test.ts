import { describe, expect, test } from "bun:test";
import {
  filterLegacy,
  loadPriorState,
  parseLegacyShape,
  type RecorderDeps,
  type RunContext,
  runWithRecorder,
} from "./cron-run-recorder.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function fakeStore(opts: {
  latest?: Record<string, unknown> | null;
  findings?: unknown[];
  failPost?: "batch" | "run";
}) {
  const calls: Call[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    calls.push({ method, path: path + url.search, body });
    const json = (s: number, b: unknown) =>
      new Response(JSON.stringify(b), { status: s });
    if (method === "GET" && path === "/cron-runs/latest") {
      return opts.latest ? json(200, opts.latest) : json(404, { error: "no" });
    }
    if (method === "GET" && path === "/patrol-findings") {
      return json(200, {
        findings: opts.findings ?? [],
        total: 0,
        limit: 50,
        nextCursor: null,
      });
    }
    if (method === "POST" && path === "/patrol-findings/batch") {
      if (opts.failPost === "batch") return json(500, { error: "boom" });
      return json(200, { findings: [] });
    }
    if (method === "POST" && path === "/cron-runs") {
      if (opts.failPost === "run") return json(500, { error: "boom" });
      return json(201, { id: "r1" });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function makeDeps(
  store: ReturnType<typeof fakeStore>,
  files: Record<string, string> = {},
) {
  const reads: string[] = [];
  const deleted: string[] = [];
  const logs: string[] = [];
  let t = Date.parse("2026-11-27T06:00:00.000Z");
  const deps: RecorderDeps = {
    fetchFn: store.fetchFn,
    clock: {
      now: () => {
        const d = new Date(t);
        t += 1000;
        return d;
      },
    },
    baseUrl: "http://store",
    token: "tok",
    readFile: (p) => {
      reads.push(p);
      return p in files ? files[p] : null;
    },
    deleteFile: (p) => {
      deleted.push(p);
      delete files[p];
    },
    log: (m) => logs.push(m),
  };
  return { deps, reads, deleted, logs, files };
}

const REPO = "app-vitals/shipwright";
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  cronId: "consolidation-patrol",
  repo: REPO,
  commitSha: "abc123",
  ...over,
});

const runPosts = (s: ReturnType<typeof fakeStore>) =>
  s.calls.filter((c) => c.method === "POST" && c.path === "/cron-runs");

// ─── Fixtures: multi-repo legacy ledgers ──────────────────────────────────────

const consolidation = {
  lastRun: "2026-11-20T09:00:00.000Z",
  candidates: {
    fpA: {
      repo: REPO,
      description: "retry",
      files: ["a.ts"],
      occurrence_count: 3,
      consecutive_stable_runs: 2,
      status: "ready_to_propose",
      firstSeen: "2026-11-01T09:00:00.000Z",
      lastSeen: "2026-11-20T09:00:00.000Z",
      history: [{ run: "2026-11-01T09:00:00.000Z" }],
    },
    fpB: {
      repo: "app-vitals/other-repo",
      description: "other",
      files: [],
      occurrence_count: 1,
      status: "tracking",
      lastSeen: "2026-11-20T09:00:00.000Z",
    },
  },
};

const security = {
  lastRun: "2026-11-21T00:00:00.000Z",
  findings: {
    "security-secrets-shipwright-2026-W47": {
      rule: "secrets",
      status: "unresolved",
      count: 2,
      lastSeen: "2026-11-21T00:00:00.000Z",
    },
    "security-secrets-other-repo-2026-W47": {
      rule: "secrets",
      status: "unresolved",
      count: 1,
      lastSeen: "2026-11-21T00:00:00.000Z",
    },
  },
};

const errors = {
  lastRun: "2026-11-22T00:00:00.000Z",
  issues: {
    "111": {
      status: "unresolved",
      count: 4,
      lastSeen: "2026-11-22T00:00:00.000Z",
      repo: REPO,
    },
    "222": {
      status: "resolved",
      count: 1,
      lastSeen: "2026-11-22T00:00:00.000Z",
      repo: "app-vitals/other-repo",
    },
  },
  serviceRepoMap: {
    api: { status: "mapped", repo: "shipwright", matchedAt: "x.ts:1" },
    web: { status: "mapped", repo: "other-repo", matchedAt: "y.ts:2" },
  },
};

describe("filterLegacy", () => {
  test("consolidation-ledger keeps only the named repo's candidates", () => {
    const r = filterLegacy("consolidation-ledger", consolidation, REPO);
    expect(r?.findings.map((f) => f.fingerprint)).toEqual(["fpA"]);
    expect(r?.findings[0].status).toBe("ready_to_propose");
    expect(r?.machineState.lastRun).toBe(consolidation.lastRun);
  });

  test("security-patrol-ledger filters on the repo-slug in the key", () => {
    const r = filterLegacy("security-patrol-ledger", security, REPO);
    expect(r?.findings.map((f) => f.fingerprint)).toEqual([
      "security-secrets-shipwright-2026-W47",
    ]);
    expect(r?.findings[0].status).toBe("open");
  });

  test("error-patrol-ledger keeps the repo's issues and serviceRepoMap in machineState", () => {
    const r = filterLegacy("error-patrol-ledger", errors, REPO);
    expect(r?.findings.map((f) => f.fingerprint)).toEqual(["111"]);
    expect(Object.keys(r?.machineState.serviceRepoMap as object)).toEqual([
      "api",
    ]);
  });

  test("entropy-patrol-last-run: per-repo map entry, else global lastRun", () => {
    const perRepo = filterLegacy(
      "entropy-patrol-last-run",
      {
        repos: {
          [REPO]: { lastRun: "2026-11-01T00:00:00Z" },
          "o/x": { lastRun: "z" },
        },
      },
      REPO,
    );
    expect(perRepo?.machineState.lastRun).toBe("2026-11-01T00:00:00Z");
    expect(perRepo?.findings).toEqual([]);
    const global = filterLegacy(
      "entropy-patrol-last-run",
      { lastRun: "2026-11-02T00:00:00Z" },
      REPO,
    );
    expect(global?.machineState.lastRun).toBe("2026-11-02T00:00:00Z");
    expect(
      filterLegacy(
        "entropy-patrol-last-run",
        { repos: { "o/x": { lastRun: "z" } } },
        REPO,
      ),
    ).toBeNull();
  });

  test("docs-last-synced: flat anchor or per-repo map", () => {
    expect(
      filterLegacy("docs-last-synced", { sha: "s1", timestamp: "t1" }, REPO)
        ?.machineState,
    ).toMatchObject({ sha: "s1", timestamp: "t1" });
    expect(
      filterLegacy(
        "docs-last-synced",
        { "o/x": { sha: "no", timestamp: "t" } },
        REPO,
      ),
    ).toBeNull();
  });

  test("returns null when nothing belongs to the repo", () => {
    expect(
      filterLegacy(
        "consolidation-ledger",
        { candidates: { z: { repo: "o/x", status: "tracking" } } },
        REPO,
      ),
    ).toBeNull();
    expect(filterLegacy("consolidation-ledger", "garbage", REPO)).toBeNull();
  });

  test("parseLegacyShape rejects unknown shapes", () => {
    expect(parseLegacyShape("security-patrol-ledger")).toBe(
      "security-patrol-ledger",
    );
    expect(parseLegacyShape("nope")).toBeNull();
  });
});

describe("recorder", () => {
  test("posts exactly one ok run with commit, metrics and times", async () => {
    const store = fakeStore({ latest: { machineState: { k: 1 } } });
    const { deps } = makeDeps(store);
    await runWithRecorder(
      ctx({ taskId: "SC-1" }),
      async (prior) => {
        expect(prior.latest?.machineState).toEqual({ k: 1 });
        return {
          outcome: "ok",
          metrics: { scanned: 3 },
          machineState: { k: 2 },
        };
      },
      deps,
    );
    const posts = runPosts(store);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      cronId: "consolidation-patrol",
      repo: REPO,
      taskId: "SC-1",
      commitSha: "abc123",
      outcome: "ok",
      metrics: { scanned: 3 },
      machineState: { k: 2 },
    });
    expect(posts[0].body?.startedAt).toBe("2026-11-27T06:00:00.000Z");
    expect(
      String(posts[0].body?.finishedAt) > String(posts[0].body?.startedAt),
    ).toBe(true);
  });

  test("records outcome failed (one run) and rethrows when the work throws", async () => {
    const store = fakeStore({ latest: { machineState: {} } });
    const { deps } = makeDeps(store);
    await expect(
      runWithRecorder(
        ctx(),
        async () => {
          throw new Error("scan exploded");
        },
        deps,
      ),
    ).rejects.toThrow("scan exploded");
    const posts = runPosts(store);
    expect(posts).toHaveLength(1);
    expect(posts[0].body?.outcome).toBe("failed");
    expect(posts[0].body?.metrics).toEqual({});
  });

  test("posts the work's findings via /patrol-findings/batch", async () => {
    const store = fakeStore({ latest: { machineState: {} } });
    const { deps } = makeDeps(store);
    await runWithRecorder(
      ctx(),
      async () => ({
        outcome: "ok",
        metrics: {},
        findings: [{ fingerprint: "f1", status: "open" }],
      }),
      deps,
    );
    const batch = store.calls.find((c) => c.path === "/patrol-findings/batch");
    expect(batch?.body).toMatchObject({
      cronId: "consolidation-patrol",
      repo: REPO,
      findings: [{ fingerprint: "f1" }],
    });
  });

  test("loadPriorState reads latest and findings", async () => {
    const store = fakeStore({
      latest: { id: "x", machineState: { a: 1 } },
      findings: [{ fingerprint: "f" }],
    });
    const { deps } = makeDeps(store);
    const prior = await loadPriorState(ctx(), deps);
    expect(prior.latest?.id).toBe("x");
    expect(prior.findings).toHaveLength(1);
    expect(prior.imported).toBeNull();
    expect(store.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("legacy import", () => {
  const LEGACY = "/state/consolidation-ledger.json";
  const lctx = () =>
    ctx({ legacyShape: "consolidation-ledger", legacyPath: LEGACY });

  test("404 + legacy file: imports filtered findings, seeds prior, deletes file after success, logs once", async () => {
    const store = fakeStore({ latest: null });
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(consolidation) });
    let seen: unknown;
    await runWithRecorder(
      lctx(),
      async (prior) => {
        seen = prior.imported;
        return { outcome: "ok", metrics: {}, machineState: { own: true } };
      },
      h.deps,
    );
    expect((seen as { findings: unknown[] }).findings).toHaveLength(1);
    const batch = store.calls.find((c) => c.path === "/patrol-findings/batch");
    expect(
      ((batch?.body?.findings ?? []) as { fingerprint: string }[]).map(
        (f) => f.fingerprint,
      ),
    ).toEqual(["fpA"]);
    const run = runPosts(store)[0].body as {
      machineState: Record<string, unknown>;
    };
    expect(run.machineState.own).toBe(true);
    expect(run.machineState.lastRun).toBe(consolidation.lastRun);
    expect(h.deleted).toEqual([LEGACY]);
    expect(h.logs.filter((l) => l.includes("legacy import"))).toHaveLength(1);
  });

  test("failed findings post leaves the file, records no import", async () => {
    const store = fakeStore({ latest: null, failPost: "batch" });
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(consolidation) });
    await expect(
      runWithRecorder(
        lctx(),
        async () => ({ outcome: "ok", metrics: {} }),
        h.deps,
      ),
    ).rejects.toThrow();
    expect(h.deleted).toEqual([]);
    expect(LEGACY in h.files).toBe(true);
    expect(h.logs.filter((l) => l.includes("legacy import"))).toHaveLength(0);
    const posts = runPosts(store);
    expect(posts.every((p) => p.body?.outcome === "failed")).toBe(true);
    expect(
      posts.every(
        (p) =>
          !(p.body?.machineState as Record<string, unknown> | undefined)
            ?.lastRun,
      ),
    ).toBe(true);
  });

  test("failed run post leaves the file and does not log the import", async () => {
    const store = fakeStore({ latest: null, failPost: "run" });
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(consolidation) });
    await expect(
      runWithRecorder(
        lctx(),
        async () => ({ outcome: "ok", metrics: {} }),
        h.deps,
      ),
    ).rejects.toThrow();
    expect(h.deleted).toEqual([]);
    expect(h.logs.filter((l) => l.includes("legacy import"))).toHaveLength(0);
  });

  test("work throwing keeps the legacy file", async () => {
    const store = fakeStore({ latest: null });
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(consolidation) });
    await expect(
      runWithRecorder(
        lctx(),
        async () => {
          throw new Error("x");
        },
        h.deps,
      ),
    ).rejects.toThrow("x");
    expect(h.deleted).toEqual([]);
  });

  test("repeat run finds /latest and never reads a local file", async () => {
    const store = fakeStore({ latest: { machineState: {} } });
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(consolidation) });
    await runWithRecorder(
      lctx(),
      async () => ({ outcome: "no_op", metrics: {} }),
      h.deps,
    );
    expect(h.reads).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  test("404 and no legacy file: plain first run", async () => {
    const store = fakeStore({ latest: null });
    const h = makeDeps(store);
    await runWithRecorder(
      lctx(),
      async () => ({ outcome: "ok", metrics: {} }),
      h.deps,
    );
    expect(h.deleted).toEqual([]);
    expect(store.calls.some((c) => c.path === "/patrol-findings/batch")).toBe(
      false,
    );
  });

  test("legacy file with only other repos' entries imports nothing and keeps the file", async () => {
    const store = fakeStore({ latest: null });
    const other = {
      lastRun: "x",
      candidates: { z: { repo: "o/x", status: "tracking" } },
    };
    const h = makeDeps(store, { [LEGACY]: JSON.stringify(other) });
    await runWithRecorder(
      lctx(),
      async () => ({ outcome: "ok", metrics: {} }),
      h.deps,
    );
    expect(h.deleted).toEqual([]);
  });
});
