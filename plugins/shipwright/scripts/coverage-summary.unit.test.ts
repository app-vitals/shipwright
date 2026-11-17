import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type Artifact,
  type CommandResult,
  type CommitResult,
  type HttpRequest,
  type HttpResponse,
  type NotReporting,
  parseArgs,
  type ReaderDeps,
  readCoverageSummary,
} from "./coverage-summary.ts";

const LCOV = (hit: number) => `SF:a\nLF:10\nLH:${hit}\nend_of_record\n`;
const REPO = "owner/repo";

function art(
  id: number,
  sha: string,
  created: string,
  over: Partial<Artifact> & { branch?: string } = {},
): Artifact {
  const { branch = "main", ...rest } = over;
  return {
    id,
    name: "shipwright-coverage",
    expired: false,
    created_at: created,
    workflow_run: { id: 1000 + id, head_branch: branch, head_sha: sha },
    ...rest,
  };
}

interface Setup {
  artifacts: Artifact[];
  snapshot?: unknown;
  snapshotStatus?: number;
  reports?: (runId: number) => { name: string; content: string }[];
  downloadFails?: Set<number>;
  env?: Record<string, string>;
  postStatus?: (sha: string) => number;
}

const ENV = {
  SHIPWRIGHT_TASK_STORE_URL: "https://store.example/",
  SHIPWRIGHT_TASK_STORE_TOKEN: "tok",
};

function setup(s: Setup) {
  const cmds: string[][] = [];
  const reqs: HttpRequest[] = [];
  const ok = (v: unknown): CommandResult => ({
    ok: true,
    stdout: JSON.stringify(v),
    stderr: "",
  });
  const deps: ReaderDeps = {
    run: (cmd) => {
      cmds.push(cmd);
      if (cmd[1] === "api") {
        const path = cmd[2] as string;
        if (path === `repos/${REPO}`) return ok({ default_branch: "main" });
        if (path.startsWith(`repos/${REPO}/actions/artifacts`))
          return ok({
            total_count: s.artifacts.length,
            artifacts: s.artifacts,
          });
        const m = path.match(/actions\/runs\/(\d+)$/);
        if (m)
          return ok({
            id: Number(m[1]),
            html_url: `https://host/${REPO}/actions/runs/${m[1]}`,
          });
      }
      if (cmd[1] === "run" && cmd[2] === "download") {
        return s.downloadFails?.has(Number(cmd[3]))
          ? { ok: false, stdout: "", stderr: "gone" }
          : { ok: true, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    },
    http: async (req): Promise<HttpResponse> => {
      reqs.push(req);
      if (req.method === "GET")
        return {
          status: s.snapshotStatus ?? 200,
          body: s.snapshot ?? { snapshots: [] },
        };
      const sha = JSON.parse(req.body as string).commitSha as string;
      return { status: s.postStatus?.(sha) ?? 201, body: {} };
    },
    env: s.env ?? ENV,
    makeTempDir: () => {
      const n = cmds.filter(
        (c) => c[1] === "api" && /runs\/\d+$/.test(c[2] as string),
      ).length;
      return `/tmp/dl-${n}`;
    },
    removeDir: () => {},
    readReports: (_dir) => {
      const runId = cmds.filter((c) => c[2] === "download").at(-1)?.[3];
      return (
        s.reports?.(Number(runId)) ?? [{ name: "lcov.info", content: LCOV(5) }]
      );
    },
  };
  return { deps, cmds, reqs };
}

const opts = { repo: REPO, record: false, maxBackfill: 50 };
const asResults = (r: CommitResult[] | NotReporting) => {
  if (!Array.isArray(r)) throw new Error(`not results: ${JSON.stringify(r)}`);
  return r;
};

describe("default-branch filtering", () => {
  it("processes only default-branch artifacts", async () => {
    const { deps } = setup({
      artifacts: [
        art(1, "aaa", "2026-01-01T00:00:00Z"),
        art(2, "bbb", "2026-01-02T00:00:00Z", { branch: "feature/x" }),
      ],
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r.map((x) => x.commitSha)).toEqual(["aaa"]);
    expect(r[0]).toMatchObject({
      branch: "main",
      runUrl: `https://host/${REPO}/actions/runs/1001`,
      measuredAt: "2026-01-01T00:00:00Z",
      lines: { covered: 5, total: 10 },
      tool: "lcov",
    });
  });

  it("downloads by run id into a temp dir", async () => {
    const { deps, cmds } = setup({
      artifacts: [art(1, "aaa", "2026-01-01T00:00:00Z")],
    });
    await readCoverageSummary(opts, deps);
    const dl = cmds.find((c) => c[2] === "download") as string[];
    expect(dl).toContain("--name");
    expect(dl[dl.indexOf("--name") + 1]).toBe("shipwright-coverage");
    expect(dl[dl.indexOf("--dir") + 1]).toStartWith("/tmp/dl-");
  });
});

describe("selection", () => {
  const many = [1, 2, 3, 4, 5].map((i) =>
    art(i, `sha${i}`, `2026-01-0${i}T00:00:00Z`),
  );

  it("with a snapshot, processes only newer artifacts oldest first", async () => {
    const { deps } = setup({
      artifacts: [...many].reverse(),
      snapshot: { snapshots: [{ measuredAt: "2026-01-03T00:00:00Z" }] },
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r.map((x) => x.commitSha)).toEqual(["sha4", "sha5"]);
  });

  it("tolerates a bare-array snapshot response", async () => {
    const { deps } = setup({
      artifacts: many,
      snapshot: [{ measuredAt: "2026-01-04T00:00:00Z" }],
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r.map((x) => x.commitSha)).toEqual(["sha5"]);
  });

  it("without a snapshot, takes the newest max-backfill oldest first", async () => {
    const { deps } = setup({ artifacts: many });
    const r = asResults(
      await readCoverageSummary({ ...opts, maxBackfill: 2 }, deps),
    );
    expect(r.map((x) => x.commitSha)).toEqual(["sha4", "sha5"]);
  });

  it("treats a failed snapshot lookup as no snapshot", async () => {
    const { deps } = setup({ artifacts: many, snapshotStatus: 500 });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r).toHaveLength(5);
  });

  it("reports no_new_artifact when nothing is newer than the snapshot", async () => {
    const { deps } = setup({
      artifacts: many,
      snapshot: { snapshots: [{ measuredAt: "2026-02-01T00:00:00Z" }] },
    });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "no_new_artifact",
    });
  });
});

describe("dedupe", () => {
  it("returns one result per SHA, from the newer artifact", async () => {
    const { deps } = setup({
      artifacts: [
        art(1, "same", "2026-01-01T00:00:00Z"),
        art(2, "same", "2026-01-02T00:00:00Z"),
      ],
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r).toHaveLength(1);
    expect(r[0]?.measuredAt).toBe("2026-01-02T00:00:00Z");
    expect(r[0]?.runUrl).toEndWith("/1002");
  });
});

describe("not_reporting", () => {
  it("no artifact", async () => {
    const { deps } = setup({ artifacts: [] });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "no_artifact",
    });
  });

  it("expired only", async () => {
    const { deps } = setup({
      artifacts: [art(1, "a", "2026-01-01T00:00:00Z", { expired: true })],
    });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "all_expired",
    });
  });

  it("unparseable only", async () => {
    const { deps } = setup({
      artifacts: [art(1, "a", "2026-01-01T00:00:00Z")],
      reports: () => [{ name: "notes.txt", content: "garbage" }],
    });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "unparseable",
    });
  });

  it("download failure is distinct from unparseable", async () => {
    const { deps } = setup({
      artifacts: [art(1, "a", "2026-01-01T00:00:00Z")],
      downloadFails: new Set([1001]),
    });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "download_failed",
    });
  });

  it("feature-branch-only artifacts yield their own reason", async () => {
    const { deps } = setup({
      artifacts: [art(1, "a", "2026-01-01T00:00:00Z", { branch: "dev" })],
    });
    expect(await readCoverageSummary(opts, deps)).toEqual({
      status: "not_reporting",
      reason: "no_default_branch_artifact",
    });
  });

  it("skips unparseable commits but keeps parseable ones", async () => {
    const { deps } = setup({
      artifacts: [
        art(1, "a", "2026-01-01T00:00:00Z"),
        art(2, "b", "2026-01-02T00:00:00Z"),
      ],
      reports: (id) =>
        id === 1001
          ? [{ name: "x", content: "junk" }]
          : [{ name: "lcov.info", content: LCOV(7) }],
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r.map((x) => x.commitSha)).toEqual(["b"]);
  });
});

describe("--record", () => {
  const two = [
    art(1, "a", "2026-01-01T00:00:00Z"),
    art(2, "b", "2026-01-02T00:00:00Z"),
  ];

  it("POSTs once per result with bearer auth and the snapshot body", async () => {
    const { deps, reqs } = setup({
      artifacts: two,
      reports: () => [
        {
          name: "lcov.info",
          content: "SF:a\nLF:10\nLH:5\nBRF:4\nBRH:2\nend_of_record\n",
        },
      ],
    });
    const r = asResults(
      await readCoverageSummary({ ...opts, record: true }, deps),
    );
    const posts = reqs.filter((q) => q.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toBe("https://store.example/coverage-snapshots");
    expect(posts[0]?.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(posts[0]?.body as string)).toEqual({
      repo: REPO,
      branch: "main",
      commitSha: "a",
      linesCovered: 5,
      linesTotal: 10,
      branchesCovered: 2,
      branchesTotal: 4,
      tool: "lcov",
      runUrl: `https://host/${REPO}/actions/runs/1001`,
      measuredAt: "2026-01-01T00:00:00Z",
    });
    expect(r.every((x) => x.record?.status === "recorded")).toBe(true);
  });

  it("reports a failed POST per commit without aborting the rest", async () => {
    const { deps, reqs } = setup({
      artifacts: two,
      postStatus: (sha) => (sha === "a" ? 500 : 201),
    });
    const r = asResults(
      await readCoverageSummary({ ...opts, record: true }, deps),
    );
    expect(reqs.filter((q) => q.method === "POST")).toHaveLength(2);
    expect(r[0]?.record).toEqual({
      status: "record_failed",
      error: "HTTP 500",
    });
    expect(r[1]?.record).toEqual({ status: "recorded" });
  });

  it("reports a thrown POST as failed", async () => {
    const { deps } = setup({ artifacts: two });
    const orig = deps.http;
    deps.http = async (q) => {
      if (q.method === "POST") throw new Error("boom");
      return orig(q);
    };
    const r = asResults(
      await readCoverageSummary({ ...opts, record: true }, deps),
    );
    expect(r[0]?.record).toEqual({ status: "record_failed", error: "boom" });
  });

  it("reports record_skipped without env vars and still returns results", async () => {
    const { deps, reqs } = setup({ artifacts: two, env: {} });
    const r = asResults(
      await readCoverageSummary({ ...opts, record: true }, deps),
    );
    expect(reqs).toHaveLength(0);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.record?.status === "record_skipped")).toBe(true);
  });

  it("omits record info without --record", async () => {
    const { deps, reqs } = setup({ artifacts: two });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(reqs.filter((q) => q.method === "POST")).toHaveLength(0);
    expect(r[0]?.record).toBeUndefined();
  });
});

describe("parseArgs", () => {
  it("requires --repo and applies defaults", () => {
    expect(() => parseArgs([])).toThrow();
    expect(parseArgs(["--repo", "o/r"])).toEqual({
      repo: "o/r",
      record: false,
      maxBackfill: 50,
    });
    expect(
      parseArgs(["--repo", "o/r", "--record", "--max-backfill", "3"]),
    ).toEqual({
      repo: "o/r",
      record: true,
      maxBackfill: 3,
    });
  });
  it("rejects a bad max-backfill or unknown flag", () => {
    expect(() => parseArgs(["--repo", "o/r", "--max-backfill", "0"])).toThrow();
    expect(() => parseArgs(["--repo", "o/r", "--nope"])).toThrow();
  });
});

describe("source hygiene", () => {
  it("contains no organisation, repository, workflow, job or step names", () => {
    const src = readFileSync(
      new URL("./coverage-summary.ts", import.meta.url),
      "utf8",
    )
      .replaceAll("shipwright-coverage", "")
      .replaceAll(/SHIPWRIGHT_TASK_STORE_(URL|TOKEN)/g, "");
    // Assembled so this file never contains a banned pattern verbatim.
    const names = [
      "app-" + "vitals",
      "ship" + "wright",
      "squad" + "ron",
      "vitals-" + "os",
    ];
    expect(src).not.toMatch(new RegExp(names.join("|"), "i"));
    expect(src).not.toMatch(
      /\.github\/workflows|workflow_name|job_name|step_name/,
    );
  });
});
