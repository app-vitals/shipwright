// Unit tests for compute-pr-risk-signals.ts — pure scoring logic plus the
// git-history collector driven by an injected runner (no real git, no I/O).

import { describe, expect, it } from "bun:test";
import {
  collectFileHistory,
  computeRiskSignals,
  type FileChange,
  type FileHistory,
} from "./compute-pr-risk-signals";

const f = (path: string, additions = 10, deletions = 0): FileChange => ({
  path,
  additions,
  deletions,
});

const find = (r: ReturnType<typeof computeRiskSignals>, factor: string) => {
  const hit = r.factors.find((x) => x.factor === factor);
  if (!hit) throw new Error(`missing factor ${factor}`);
  return hit;
};

describe("output shape", () => {
  it("emits every factor category with level, points and evidence", () => {
    const r = computeRiskSignals({ files: [f("src/a.ts")] });
    const names = r.factors.map((x) => x.factor);
    for (const n of [
      "size",
      "diffusion",
      "sensitive-paths",
      "file-history",
      "evidence-tests",
      "evidence-ci",
      "evidence-codeowners",
    ]) {
      expect(names).toContain(n);
    }
    for (const x of r.factors) {
      expect(["low", "medium", "high"]).toContain(x.level);
      expect(typeof x.points).toBe("number");
      expect(x.evidence.length).toBeGreaterThan(0);
    }
    expect(r.totalPoints).toBe(r.factors.reduce((s, x) => s + x.points, 0));
  });

  it("never reads author identity (extra author fields do not change output)", () => {
    const base = { files: [f("src/a.ts")] };
    const withAuthor = {
      ...base,
      author: "alice",
      authorExperience: 99,
      reviewerLoad: 7,
      incidentRate: 0.4,
    } as Parameters<typeof computeRiskSignals>[0];
    expect(computeRiskSignals(withAuthor)).toEqual(computeRiskSignals(base));
  });
});

describe("size", () => {
  it("small change is low / 0 points", () => {
    const x = find(computeRiskSignals({ files: [f("a.ts", 5, 5)] }), "size");
    expect(x.level).toBe("low");
    expect(x.points).toBe(0);
    expect(x.evidence).toContain("10 lines");
  });
  it("medium and large changes score progressively higher", () => {
    const med = find(
      computeRiskSignals({ files: [f("a.ts", 200, 50)] }),
      "size",
    );
    const big = find(
      computeRiskSignals({ files: [f("a.ts", 900, 300)] }),
      "size",
    );
    expect(med.level).toBe("medium");
    expect(big.level).toBe("high");
    expect(big.points).toBeGreaterThan(med.points);
  });
  it("many files raise size even with few lines", () => {
    const files = Array.from({ length: 30 }, (_, i) => f(`a/f${i}.ts`, 1, 0));
    expect(find(computeRiskSignals({ files }), "size").level).not.toBe("low");
  });
});

describe("diffusion", () => {
  it("single directory is low", () => {
    const r = computeRiskSignals({ files: [f("src/a.ts"), f("src/b.ts")] });
    expect(find(r, "diffusion").level).toBe("low");
  });
  it("many top-level subsystems is high", () => {
    const files = [
      "api/a.ts",
      "web/b.ts",
      "db/c.ts",
      "worker/d.ts",
      "infra/e.ts",
      "docs/f.md",
    ].map((p) => f(p));
    const x = find(computeRiskSignals({ files }), "diffusion");
    expect(x.level).toBe("high");
    expect(x.evidence).toContain("6 top-level");
  });
  it("shared-library paths add points", () => {
    const plain = find(
      computeRiskSignals({ files: [f("src/a.ts")] }),
      "diffusion",
    );
    const shared = find(
      computeRiskSignals({ files: [f("packages/shared/a.ts")] }),
      "diffusion",
    );
    expect(shared.points).toBeGreaterThan(plain.points);
    expect(shared.evidence).toContain("shared");
  });
  it("even spread across files has higher entropy than one dominant file", () => {
    const even = computeRiskSignals({
      files: [
        f("a/x.ts", 50),
        f("b/y.ts", 50),
        f("c/z.ts", 50),
        f("d/w.ts", 50),
      ],
    });
    const skew = computeRiskSignals({
      files: [f("a/x.ts", 197), f("b/y.ts", 1), f("c/z.ts", 1), f("d/w.ts", 1)],
    });
    expect(find(even, "diffusion").points).toBeGreaterThanOrEqual(
      find(skew, "diffusion").points,
    );
  });
});

describe("sensitive-paths", () => {
  it("none is low / 0", () => {
    const x = find(
      computeRiskSignals({ files: [f("src/ui/button.ts")] }),
      "sensitive-paths",
    );
    expect(x).toMatchObject({ level: "low", points: 0 });
  });
  it.each([
    ["src/auth/login.ts", "auth"],
    ["db/migrations/001_init.sql", "migration"],
    ["prisma/schema.prisma", "migration"],
    [".github/workflows/ci.yml", "infra"],
    ["Dockerfile", "infra"],
    ["terraform/main.tf", "infra"],
    ["package.json", "dependency"],
    ["bun.lock", "dependency"],
  ])("flags %s as %s", (path, kw) => {
    const x = find(computeRiskSignals({ files: [f(path)] }), "sensitive-paths");
    expect(x.points).toBeGreaterThan(0);
    expect(x.evidence).toContain(path);
    expect(x.evidence.toLowerCase()).toContain(kw);
  });
  it("multiple categories escalate to high", () => {
    const x = find(
      computeRiskSignals({
        files: [
          f("src/auth/a.ts"),
          f("db/migrations/1.sql"),
          f("package.json"),
        ],
      }),
      "sensitive-paths",
    );
    expect(x.level).toBe("high");
  });
});

describe("file-history", () => {
  const hist = (o: Partial<FileHistory> = {}): FileHistory => ({
    commits90d: 0,
    bugfixCommits: 0,
    revertCommits: 0,
    contributors: 1,
    ageDays: 400,
    ...o,
  });
  it("is unknown / 0 points when history is absent", () => {
    const x = find(computeRiskSignals({ files: [f("a.ts")] }), "file-history");
    expect(x).toMatchObject({ level: "low", points: 0 });
    expect(x.evidence).toContain("unknown");
  });
  it("is unknown when every file history is null (git failure)", () => {
    const x = find(
      computeRiskSignals({ files: [f("a.ts")], history: { "a.ts": null } }),
      "file-history",
    );
    expect(x.points).toBe(0);
    expect(x.evidence).toContain("unknown");
  });
  it("quiet old file is low", () => {
    const x = find(
      computeRiskSignals({ files: [f("a.ts")], history: { "a.ts": hist() } }),
      "file-history",
    );
    expect(x.level).toBe("low");
  });
  it("churn, bug-fixes, reverts, contributors and young age add points", () => {
    const x = find(
      computeRiskSignals({
        files: [f("a.ts")],
        history: {
          "a.ts": hist({
            commits90d: 30,
            bugfixCommits: 5,
            revertCommits: 2,
            contributors: 8,
            ageDays: 5,
          }),
        },
      }),
      "file-history",
    );
    expect(x.level).toBe("high");
    for (const w of ["churn", "bug-fix", "revert", "contributors", "age"]) {
      expect(x.evidence.toLowerCase()).toContain(w);
    }
  });
});

describe("evidence", () => {
  it("code changed without tests is flagged; with tests is clean", () => {
    const without = find(
      computeRiskSignals({ files: [f("src/a.ts")] }),
      "evidence-tests",
    );
    const withT = find(
      computeRiskSignals({ files: [f("src/a.ts"), f("src/a.unit.test.ts")] }),
      "evidence-tests",
    );
    expect(without.points).toBeGreaterThan(0);
    expect(withT.points).toBe(0);
  });
  it("docs-only change needs no tests", () => {
    expect(
      find(computeRiskSignals({ files: [f("README.md")] }), "evidence-tests")
        .points,
    ).toBe(0);
  });
  it("CI status maps to points", () => {
    const pts = (status: "passing" | "failing" | "pending" | "unknown") =>
      find(
        computeRiskSignals({ files: [f("a.ts")], ci: { status } }),
        "evidence-ci",
      );
    expect(pts("passing").points).toBe(0);
    expect(pts("failing").level).toBe("high");
    expect(pts("pending").points).toBeGreaterThan(0);
    expect(pts("unknown").points).toBe(0);
  });
  it("CODEOWNERS: uncovered files score, covered do not, absent is unknown", () => {
    const owners = "* @org/everyone\n/docs/ @org/docs\n";
    const covered = find(
      computeRiskSignals({ files: [f("src/a.ts")], codeowners: owners }),
      "evidence-codeowners",
    );
    expect(covered.points).toBe(0);
    const uncovered = find(
      computeRiskSignals({
        files: [f("src/a.ts")],
        codeowners: "/docs/ @org/docs\n",
      }),
      "evidence-codeowners",
    );
    expect(uncovered.points).toBeGreaterThan(0);
    expect(uncovered.evidence).toContain("src/a.ts");
    const absent = find(
      computeRiskSignals({ files: [f("src/a.ts")] }),
      "evidence-codeowners",
    );
    expect(absent.points).toBe(0);
    expect(absent.evidence).toContain("unknown");
  });
});

describe("collectFileHistory (injected runner)", () => {
  const now = 1_700_000_000;
  const out = [
    ["h1", "a@x", String(now - 86400), "fix: crash"],
    ["h2", "b@x", String(now - 86400 * 10), 'Revert "feat: thing"'],
    ["h3", "a@x", String(now - 86400 * 200), "feat: init"],
  ]
    .map((r) => r.join("\x1f"))
    .join("\n");

  it("parses git log output into a FileHistory", async () => {
    const h = await collectFileHistory(["a.ts"], async () => out, now);
    expect(h["a.ts"]).toEqual({
      commits90d: 2,
      bugfixCommits: 1,
      revertCommits: 1,
      contributors: 2,
      ageDays: 200,
    });
  });
  it("degrades to null instead of throwing when the runner fails", async () => {
    const h = await collectFileHistory(
      ["a.ts"],
      async () => {
        throw new Error("not a git repo");
      },
      now,
    );
    expect(h["a.ts"]).toBeNull();
  });
  it("empty log (untracked/new file) degrades to null", async () => {
    const h = await collectFileHistory(["a.ts"], async () => "", now);
    expect(h["a.ts"]).toBeNull();
  });
});
