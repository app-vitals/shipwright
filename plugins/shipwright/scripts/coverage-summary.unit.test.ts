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
  /** Exclusion file content per commit SHA; absent SHA means 404. */
  exclusionFiles?: Record<string, string>;
  /** Fail the contents lookup with this stderr instead of 404. */
  contentsError?: string;
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
        if (path.startsWith(`repos/${REPO}/contents/.shipwright/coverage.json`)) {
          const sha = path.split("?ref=")[1] as string;
          if (s.contentsError)
            return { ok: false, stdout: "", stderr: s.contentsError };
          const file = s.exclusionFiles?.[sha];
          return file === undefined
            ? { ok: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
            : ok({
                encoding: "base64",
                content: Buffer.from(file).toString("base64"),
              });
        }
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

const MULTI_LCOV = [
  "SF:src/a.ts\nLF:10\nLH:9\nend_of_record",
  "SF:src/gen/b.ts\nLF:10\nLH:0\nend_of_record",
  "SF:vendor/c.ts\nLF:20\nLH:0\nend_of_record",
  "",
].join("\n");
const multi = { reports: () => [{ name: "lcov.info", content: MULTI_LCOV }] };
const cfg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    maxExcludedPct: 90,
    excludePrefixes: [{ path: "vendor/", reason: "third party" }],
    excludeSubstrings: [{ path: "/gen/", reason: "generated" }],
    ...over,
  });
const one = [art(1, "aaa", "2026-01-01T00:00:00Z")];

describe("coverage exclusions", () => {
  it("absent file (404): raw totals and zero excluded", async () => {
    const { deps } = setup({ artifacts: one, ...multi });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r[0]?.lines).toEqual({ covered: 9, total: 40 });
    expect(r[0]?.excluded).toEqual({ lines: 0, pct: 0 });
    expect(r[0]?.deadEntries).toBeUndefined();
  });

  it("applies prefix and substring exclusions", async () => {
    const { deps } = setup({
      artifacts: one,
      ...multi,
      exclusionFiles: { aaa: cfg() },
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r[0]?.lines).toEqual({ covered: 9, total: 10 });
    expect(r[0]?.excluded).toEqual({ lines: 30, pct: 75 });
    expect(r[0]?.deadEntries).toBeUndefined();
  });

  it("prefix entries use startsWith, not includes", async () => {
    const { deps } = setup({
      artifacts: one,
      ...multi,
      exclusionFiles: {
        aaa: cfg({
          excludePrefixes: [{ path: "gen/", reason: "r" }],
          excludeSubstrings: [],
        }),
      },
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r[0]?.excluded.lines).toBe(0);
    expect(r[0]?.deadEntries).toEqual(["excludePrefixes: gen/"]);
  });

  it("looks the file up at each artifact's commit SHA", async () => {
    const { deps, cmds } = setup({
      artifacts: [
        art(1, "aaa", "2026-01-01T00:00:00Z"),
        art(2, "bbb", "2026-01-02T00:00:00Z"),
      ],
      ...multi,
      exclusionFiles: { bbb: cfg() },
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r[0]?.excluded.lines).toBe(0);
    expect(r[1]?.excluded.lines).toBe(30);
    const paths = cmds.map((c) => c[2]).filter((p) => p?.includes("contents/"));
    expect(paths).toEqual([
      `repos/${REPO}/contents/.shipwright/coverage.json?ref=aaa`,
      `repos/${REPO}/contents/.shipwright/coverage.json?ref=bbb`,
    ]);
  });

  it("reports entries that match no file as dead", async () => {
    const { deps } = setup({
      artifacts: one,
      ...multi,
      exclusionFiles: {
        aaa: cfg({
          excludeSubstrings: [{ path: "/gone/", reason: "was generated" }],
        }),
      },
    });
    const r = asResults(await readCoverageSummary(opts, deps));
    expect(r[0]?.deadEntries).toEqual(["excludeSubstrings: /gone/"]);
  });

  it("does not put excluded info in the recorded POST body", async () => {
    const { deps, reqs } = setup({
      artifacts: one,
      ...multi,
      exclusionFiles: { aaa: cfg() },
    });
    await readCoverageSummary({ ...opts, record: true }, deps);
    const body = JSON.parse(
      reqs.find((q) => q.method === "POST")?.body as string,
    );
    expect(body.excluded).toBeUndefined();
    expect(body.linesTotal).toBe(10);
  });

  const rejects = async (s: Partial<Setup>, msg: RegExp) => {
    const { deps } = setup({ artifacts: one, ...multi, ...s });
    await expect(readCoverageSummary(opts, deps)).rejects.toThrow(msg);
  };

  it("fails loudly on invalid JSON", () =>
    rejects({ exclusionFiles: { aaa: "{nope" } }, /coverage\.json.*invalid JSON/));

  it("fails loudly on wrong types", () =>
    rejects(
      { exclusionFiles: { aaa: cfg({ excludePrefixes: "vendor/" }) } },
      /"excludePrefixes" must be an array/,
    ));

  it("fails on a non-numeric maxExcludedPct", () =>
    rejects(
      { exclusionFiles: { aaa: cfg({ maxExcludedPct: "10" }) } },
      /maxExcludedPct/,
    ));

  it("names the entry that is missing a reason", () =>
    rejects(
      {
        exclusionFiles: {
          aaa: cfg({ excludeSubstrings: [{ path: "/gen/" }] }),
        },
      },
      /excludeSubstrings\[0\] \(path "\/gen\/"\) is missing a non-empty "reason"/,
    ));

  it("rejects a whitespace-only reason", () =>
    rejects(
      {
        exclusionFiles: {
          aaa: cfg({ excludePrefixes: [{ path: "vendor/", reason: "  " }] }),
        },
      },
      /excludePrefixes\[0\]/,
    ));

  it("fails when excluded pct exceeds maxExcludedPct", () =>
    rejects(
      { exclusionFiles: { aaa: cfg({ maxExcludedPct: 50 }) } },
      /75\.00% .* above maxExcludedPct 50/,
    ));

  it("fails loudly on a non-404 fetch error", () =>
    rejects({ contentsError: "HTTP 500 server error" }, /could not fetch/));
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
