/**
 * plugins/shipwright/scripts/prompt-audit/cli.unit.test.ts
 *
 * scan/blast with in-memory fs, clock and exec; measure against a real
 * temporary git repository.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CliDeps, nodeCliDeps, parseArgs, runCli } from "./cli.ts";
import { countTokens } from "./token-count.ts";

const NOW = new Date("2026-10-08T00:00:00Z");

const BIG_CLAUDE = `${Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n")}\n`;

const REPO: Record<string, string> = {
  "CLAUDE.md": BIG_CLAUDE,
  "plugins/p/commands/dev-task.md": "---\ndescription: dev\n---\nBuild it.\n",
  "plugins/p/commands/dev-task.content.test.ts":
    'expect(c).toContain("Build it");\n',
  "plugins/p/skills/helper/SKILL.md":
    "---\nname: helper\n---\nSee plugins/p/commands/dev-task.md.\n",
  "agent-types/coding/manifest.yaml": [
    "crons:",
    "  - name: shipwright-dev-task",
    "    prompt: /shipwright:dev-task",
    "    parentCron: shipwright-loop",
    "",
  ].join("\n"),
  "site/docs-source-map.json": JSON.stringify({
    "dev.mdx": ["plugins/p/commands/dev-task.md"],
  }),
};

function memDeps(): CliDeps & {
  files: Record<string, string>;
  writes: string[];
} {
  const files = { ...REPO };
  const writes: string[] = [];
  return {
    files,
    writes,
    fs: {
      listFiles: () => Object.keys(files),
      readFile: (_r, p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      exists: (_r, p) => p in files,
      writeFile: (_r, p, c) => {
        files[p] = c;
        writes.push(p);
      },
    },
    exec: (_cwd, cmd) => {
      if (cmd[1] === "rev-parse") return "deadbeef\n";
      throw new Error("no git");
    },
    now: () => NOW,
    countTokens: async (texts, models) =>
      Object.fromEntries(
        models.map((m) => [
          m,
          texts.map((t) => ({
            tokens: Math.ceil(t.length / 4),
            estimated: true,
          })),
        ]),
      ),
    loadUsage: async () => null,
    env: {},
  };
}

const parse = (s: string) => JSON.parse(s);

describe("parseArgs", () => {
  test("collects repeatable --model and boolean flags", () => {
    const a = parseArgs([
      "scan",
      "--model",
      "a",
      "--model",
      "b",
      "--json",
      "--dry-run",
      "--since-days",
      "7",
    ]);
    expect(a.command).toBe("scan");
    expect(a.multi.model).toEqual(["a", "b"]);
    expect(a.flags.has("json")).toBe(true);
    expect(a.flags.has("dry-run")).toBe(true);
    expect(a.values["since-days"]).toBe("7");
  });
});

describe("scan", () => {
  test("--json emits findings that each carry blastRadius and scannedAt", async () => {
    const deps = memDeps();
    const res = await runCli(
      ["scan", "--repo", "/r", "--model", "claude-sonnet-5-5", "--json"],
      deps,
    );
    expect(res.exit).toBe(0);
    const out = parse(res.stdout);
    const over = out.findings.find(
      (f: { rule: string }) => f.rule === "claude-md-over-200-lines",
    );
    expect(over).toBeDefined();
    for (const f of out.findings) {
      expect(f.scannedAt).toBe("deadbeef");
      expect(f.blastRadius.lowerBound).toBe(true);
      expect(Array.isArray(f.blastRadius.referrers)).toBe(true);
    }
    expect(out.models).toEqual(["claude-sonnet-5-5"]);
  });

  test("writes ledger and report; ledger entries carry blastRadius", async () => {
    const deps = memDeps();
    await runCli(
      ["scan", "--repo", "/r", "--model", "claude-sonnet-5-5"],
      deps,
    );
    expect(deps.writes).toContain("state/prompt-audit-ledger.json");
    expect(deps.writes).toContain("prompt-audit-report.md");
    const ledger = parse(deps.files["state/prompt-audit-ledger.json"]);
    const entries = Object.values(ledger.findings) as Array<{
      blastRadius: unknown;
      scannedAt: string;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.blastRadius).toBeDefined();
      expect(e.scannedAt).toBe("deadbeef");
    }
    expect(deps.files["prompt-audit-report.md"]).toContain(
      "# Prompt Audit Report",
    );
  });

  test("--dry-run writes nothing to state/ or the report", async () => {
    const deps = memDeps();
    const res = await runCli(
      [
        "scan",
        "--repo",
        "/r",
        "--model",
        "claude-sonnet-5-5",
        "--dry-run",
        "--json",
      ],
      deps,
    );
    expect(res.exit).toBe(0);
    expect(deps.writes).toEqual([]);
    expect(parse(res.stdout).findings.length).toBeGreaterThan(0);
  });

  test("a second scan keeps fingerprints and bumps runsSeen", async () => {
    const deps = memDeps();
    await runCli(
      ["scan", "--repo", "/r", "--model", "claude-sonnet-5-5"],
      deps,
    );
    await runCli(
      ["scan", "--repo", "/r", "--model", "claude-sonnet-5-5"],
      deps,
    );
    const ledger = parse(deps.files["state/prompt-audit-ledger.json"]);
    expect(
      Object.values(ledger.findings).every(
        (e) => (e as { runsSeen: number }).runsSeen === 2,
      ),
    ).toBe(true);
  });

  test("--scope limits findings to a path prefix", async () => {
    const deps = memDeps();
    const res = await runCli(
      [
        "scan",
        "--repo",
        "/r",
        "--model",
        "claude-sonnet-5-5",
        "--scope",
        "plugins/",
        "--json",
        "--dry-run",
      ],
      deps,
    );
    for (const f of parse(res.stdout).findings)
      expect(f.file.startsWith("plugins/")).toBe(true);
  });

  test("--scope does not resolve or drop out-of-scope tracked findings", async () => {
    const deps = memDeps();
    const scan = (...extra: string[]) =>
      runCli(
        ["scan", "--repo", "/r", "--model", "claude-sonnet-5-5", ...extra],
        deps,
      );
    await scan();
    const path = "state/prompt-audit-ledger.json";
    const seeded = parse(deps.files[path]);
    const [fp, entry] = Object.entries(seeded.findings).find(
      ([, e]) => (e as { file: string }).file === "CLAUDE.md",
    ) as [string, { status: string; rule: string }];
    entry.status = "queued";
    deps.files[path] = JSON.stringify(seeded);

    const res = await scan("--scope", "plugins/", "--json");
    expect(res.exit).toBe(0);
    for (const f of parse(res.stdout).findings)
      expect(f.file.startsWith("plugins/")).toBe(true);

    const ledger = parse(deps.files[path]);
    expect(ledger.findings[fp].status).toBe("queued");
    expect(ledger.findings[fp].lastSeen).toBe(ledger.lastRun);
    expect(deps.files["prompt-audit-report.md"]).toContain(entry.rule);
  });
});

describe("blast", () => {
  test("--json emits referrers, crons, pinning tests, source-map pages and load class", async () => {
    const res = await runCli(
      [
        "blast",
        "--repo",
        "/r",
        "--file",
        "plugins/p/commands/dev-task.md",
        "--json",
      ],
      memDeps(),
    );
    expect(res.exit).toBe(0);
    const out = parse(res.stdout);
    expect(out.referrers.map((r: { path: string }) => r.path)).toEqual([
      "plugins/p/skills/helper/SKILL.md",
    ]);
    expect(out.crons).toEqual([
      { name: "shipwright-dev-task", loopPhase: "dev-task" },
    ]);
    expect(out.pinningTests[0].file).toBe(
      "plugins/p/commands/dev-task.content.test.ts",
    );
    expect(out.sourceMapPages).toEqual(["dev.mdx"]);
    expect(out.loadClass["local-dev"]).toBe("on-invoke");
  });

  test("text output names each section and the lower-bound note", async () => {
    const res = await runCli(
      ["blast", "--repo", "/r", "--file", "plugins/p/commands/dev-task.md"],
      memDeps(),
    );
    for (const s of [
      "Referrers",
      "Cron prompts",
      "Pinning tests",
      "Source-map pages",
      "Load class",
    ]) {
      expect(res.stdout).toContain(s);
    }
    expect(res.stdout).toMatch(/lower bound/i);
  });

  test("requires --file", async () => {
    const res = await runCli(["blast", "--repo", "/r"], memDeps());
    expect(res.exit).toBe(2);
  });
});

describe("measure (temp git repo)", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "pa-measure-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    };
    put("docs/a.md", "x".repeat(4000));
    put(
      "state/prompt-audit-ledger.json",
      JSON.stringify({
        lastRun: null,
        models: [],
        baselines: {},
        findings: {
          abc123def456: {
            fingerprint: "abc123def456",
            file: "docs/a.md",
            status: "queued",
            history: [],
          },
        },
      }),
    );
    git("add", ".");
    git("commit", "-q", "-m", "before");
    git("tag", "before");
    put("docs/a.md", "x".repeat(1000));
    git("commit", "-q", "-am", "after");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const deps = (): CliDeps => ({
    ...nodeCliDeps(),
    now: () => NOW,
    countTokens: (texts, models, o) =>
      countTokens(texts, models, { ...o, apiKey: "" }),
  });

  test("reports a same-model token delta between two refs", async () => {
    const res = await runCli(
      [
        "measure",
        "--repo",
        repo,
        "--finding",
        "abc123def456",
        "--before",
        "before",
        "--after",
        "HEAD",
        "--model",
        "claude-sonnet-5-5",
        "--json",
      ],
      deps(),
    );
    expect(res.exit).toBe(0);
    const out = parse(res.stdout);
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.before.tokens).toBe(1000);
    expect(out.after.tokens).toBe(250);
    expect(out.tokenDelta).toBe(-750);
    expect(out.estimated).toBe(true);
  });

  test("--record writes measured into the ledger", async () => {
    const res = await runCli(
      [
        "measure",
        "--repo",
        repo,
        "--finding",
        "abc123def456",
        "--before",
        "before",
        "--after",
        "HEAD",
        "--model",
        "claude-sonnet-5-5",
        "--json",
        "--record",
      ],
      deps(),
    );
    expect(res.exit).toBe(0);
    const ledger = JSON.parse(
      execFileSync("cat", [join(repo, "state/prompt-audit-ledger.json")], {
        encoding: "utf8",
      }),
    );
    expect(ledger.findings.abc123def456.measured.delta).toBe(-750);
    expect(ledger.findings.abc123def456.status).toBe("measured");
  });

  test("an invalid ref fails with exit 1 and --record writes nothing", async () => {
    const ledgerPath = join(repo, "state/prompt-audit-ledger.json");
    const before = readFileSync(ledgerPath, "utf8");
    const res = await runCli(
      [
        "measure",
        "--repo",
        repo,
        "--finding",
        "abc123def456",
        "--before",
        "no-such-ref",
        "--after",
        "HEAD",
        "--model",
        "claude-sonnet-5-5",
        "--record",
      ],
      deps(),
    );
    expect(res.exit).toBe(1);
    expect(res.stdout).toContain("invalid git ref: no-such-ref");
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  });

  test("a valid ref where the file is absent counts as zero tokens", async () => {
    git("rm", "-q", "docs/a.md");
    git("commit", "-q", "-m", "remove");
    try {
      const res = await runCli(
        [
          "measure",
          "--repo",
          repo,
          "--finding",
          "abc123def456",
          "--before",
          "before",
          "--after",
          "HEAD",
          "--model",
          "claude-sonnet-5-5",
          "--json",
        ],
        deps(),
      );
      expect(res.exit).toBe(0);
      const out = parse(res.stdout);
      expect(out.after.tokens).toBe(0);
      expect(out.tokenDelta).toBe(-1000);
    } finally {
      git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  test("unknown finding fails with exit 1", async () => {
    const res = await runCli(
      [
        "measure",
        "--repo",
        repo,
        "--finding",
        "nope",
        "--before",
        "before",
        "--after",
        "HEAD",
        "--model",
        "claude-sonnet-5-5",
      ],
      deps(),
    );
    expect(res.exit).toBe(1);
  });

  test("missing required flags exit 2", async () => {
    const res = await runCli(
      ["measure", "--repo", repo, "--finding", "abc123def456"],
      deps(),
    );
    expect(res.exit).toBe(2);
  });
});

describe("scan adherence", () => {
  test("report shows adherence when loadAdherence returns data, and says so when it does not", async () => {
    for (const [data, expected] of [
      [[{ command: "dev-task", runs: 5, adherentRuns: 1, rate: 0.2 }], "20.0%"],
      [null, "Adherence data unavailable"],
    ] as const) {
      const deps = memDeps();
      deps.loadAdherence = async () => data as never;
      const res = await runCli(["scan", "--repo", "/r"], deps);
      expect(res.exit).toBe(0);
      expect(deps.files["prompt-audit-report.md"]).toContain(expected);
    }
  });
});
