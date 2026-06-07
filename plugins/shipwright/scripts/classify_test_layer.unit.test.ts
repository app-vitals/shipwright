// Unit tests for classify_test_layer.ts — all logic tested via DI, no real FS access.

import { describe, expect, it } from "bun:test";
import {
  type LayerDef,
  type LoadDefsResult,
  checkConformance,
  classifyPath,
  loadDefs,
  parseDiff,
  parseDiffAdditions,
  parsePlanned,
  run,
} from "./classify_test_layer";

// ─── Default defs fixture ─────────────────────────────────────────────────────

const DEFAULT_DEFS: LayerDef[] = [
  { name: "smoke", patterns: ["**/*.smoke.test.ts", "*.smoke.test.ts"] },
  { name: "e2e", patterns: ["**/*.e2e.test.ts", "*.e2e.test.ts", "e2e/**"] },
  {
    name: "unit",
    patterns: ["**/*.unit.test.ts", "*.unit.test.ts", "scripts/**", "lib/**"],
  },
  {
    name: "integration",
    patterns: [
      "**/*.integration.test.ts",
      "*.integration.test.ts",
      "time/**",
      "accounts/**",
      "billing/**",
      "cal/**",
    ],
  },
];

// ─── classifyPath ─────────────────────────────────────────────────────────────

describe("classifyPath", () => {
  it("classifies time/foo.test.ts as integration (time/ prefix matches integration)", () => {
    const result = classifyPath("time/foo.test.ts", DEFAULT_DEFS);
    expect(result).toBe("integration");
  });

  it("classifies accounts/src/user.ts as integration (accounts/ prefix)", () => {
    const result = classifyPath("accounts/src/user.ts", DEFAULT_DEFS);
    expect(result).toBe("integration");
  });

  it("classifies scripts/check-coverage.ts as unit (scripts/ prefix)", () => {
    const result = classifyPath("scripts/check-coverage.ts", DEFAULT_DEFS);
    expect(result).toBe("unit");
  });

  it("classifies lib/clock.ts as unit (lib/ prefix)", () => {
    const result = classifyPath("lib/clock.ts", DEFAULT_DEFS);
    expect(result).toBe("unit");
  });

  it("returns unknown for a path that matches no layer", () => {
    const result = classifyPath("no-match-path.txt", DEFAULT_DEFS);
    expect(result).toBe("unknown");
  });

  it("returns unknown for an empty defs list", () => {
    const result = classifyPath("time/foo.test.ts", []);
    expect(result).toBe("unknown");
  });

  it("classifies e2e/journeys/foo.spec.ts as e2e", () => {
    const result = classifyPath("e2e/journeys/foo.spec.ts", DEFAULT_DEFS);
    expect(result).toBe("e2e");
  });

  it("classifies foo.smoke.test.ts as smoke", () => {
    const result = classifyPath("foo.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies foo.unit.test.ts as unit via unit glob pattern", () => {
    const result = classifyPath("foo.unit.test.ts", DEFAULT_DEFS);
    expect(result).toBe("unit");
  });

  it("classifies foo.integration.test.ts as integration via integration glob pattern", () => {
    const result = classifyPath("foo.integration.test.ts", DEFAULT_DEFS);
    expect(result).toBe("integration");
  });

  it("classifies lib/api-auth.smoke.test.ts as smoke (not unit via lib/**)", () => {
    // smoke layer must come before unit so the suffix pattern wins over lib/**
    const result = classifyPath("lib/api-auth.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies lib/health.smoke.test.ts as smoke (not unit via lib/**)", () => {
    const result = classifyPath("lib/health.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies api/health.smoke.test.ts as smoke via **/*.smoke.test.ts", () => {
    // bare *.smoke.test.ts would miss nested paths; **/* variant is required
    const result = classifyPath("api/health.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies api/journey.e2e.test.ts as e2e via **/*.e2e.test.ts", () => {
    const result = classifyPath("api/journey.e2e.test.ts", DEFAULT_DEFS);
    expect(result).toBe("e2e");
  });
});

// ─── loadDefs ─────────────────────────────────────────────────────────────────

const TEST_SYSTEM_MD_STUB = `
## Layer definitions

| Layer | Patterns |
|---|---|
| **unit** | *.unit.test.ts, scripts/**, lib/** |
| **integration** | *.integration.test.ts, time/**, accounts/**, billing/**, cal/** |
| **smoke** | *.smoke.test.ts |
| **e2e** | *.e2e.test.ts, e2e/** |
`;

describe("loadDefs — test-system.md present", () => {
  it("reports source as 'test-system.md' when the file exists", async () => {
    const fileReader = async (_path: string) => TEST_SYSTEM_MD_STUB;
    const result = await loadDefs(fileReader);
    expect(result.source).toBe("test-system.md");
  });

  it("returns a non-empty defs array when test-system.md is present", async () => {
    const fileReader = async (_path: string) => TEST_SYSTEM_MD_STUB;
    const result = await loadDefs(fileReader);
    expect(result.defs.length).toBeGreaterThan(0);
  });

  it("includes all four canonical layers when loaded from file", async () => {
    const fileReader = async (_path: string) => TEST_SYSTEM_MD_STUB;
    const result = await loadDefs(fileReader);
    const names = result.defs.map((d) => d.name);
    expect(names).toContain("unit");
    expect(names).toContain("integration");
    expect(names).toContain("smoke");
    expect(names).toContain("e2e");
  });
});

describe("loadDefs — test-system.md absent (fallback to defaults)", () => {
  it("reports source as 'defaults' when the file cannot be read", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    expect(result.source).toBe("defaults");
  });

  it("returns the plan-session Step 2 defaults when file is absent", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    expect(result.defs.length).toBe(4);
    const names = result.defs.map((d) => d.name);
    // smoke and e2e come before unit/integration so suffix patterns take
    // precedence over broad directory globs (e.g. lib/api-auth.smoke.test.ts → smoke)
    expect(names).toEqual(["smoke", "e2e", "unit", "integration"]);
  });

  it("default unit layer contains scripts/** and lib/** patterns", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    const unit = result.defs.find((d) => d.name === "unit");
    expect(unit).toBeDefined();
    expect(unit?.patterns.some((p) => p === "scripts/**")).toBe(true);
    expect(unit?.patterns.some((p) => p === "lib/**")).toBe(true);
  });

  it("default integration layer contains time/** and accounts/** patterns", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    const integration = result.defs.find((d) => d.name === "integration");
    expect(integration).toBeDefined();
    expect(integration?.patterns.some((p) => p === "time/**")).toBe(true);
    expect(integration?.patterns.some((p) => p === "accounts/**")).toBe(true);
  });
});

// ─── parseDiff ────────────────────────────────────────────────────────────────

describe("parseDiff", () => {
  it("returns 0 counts when diff is empty", () => {
    const result = parseDiff("", DEFAULT_DEFS);
    for (const def of DEFAULT_DEFS) {
      expect(result[def.name] ?? 0).toBe(0);
    }
  });

  it("counts an added test file (+++) under the correct layer", () => {
    const diff = `
diff --git a/scripts/foo.unit.test.ts b/scripts/foo.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/scripts/foo.unit.test.ts
@@ -0,0 +1,5 @@
+import { describe, it } from "bun:test";
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(1);
  });

  it("counts a deleted test file (---) as -1 at the correct layer", () => {
    const diff = `
diff --git a/scripts/old.unit.test.ts b/scripts/old.unit.test.ts
deleted file mode 100644
--- a/scripts/old.unit.test.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-import { describe, it } from "bun:test";
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(-1);
  });

  it("counts multiple added and deleted test files correctly", () => {
    const diff = `
diff --git a/time/src/a.integration.test.ts b/time/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/time/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new test
diff --git a/time/src/b.integration.test.ts b/time/src/b.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/time/src/b.integration.test.ts
@@ -0,0 +1,3 @@
+// new test 2
diff --git a/time/src/old.integration.test.ts b/time/src/old.integration.test.ts
deleted file mode 100644
--- a/time/src/old.integration.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// removed test
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    // 2 adds - 1 delete = net 1
    expect(result.integration).toBe(1);
  });

  it("ignores non-test files in diff", () => {
    const diff = `
diff --git a/time/src/service.ts b/time/src/service.ts
--- a/time/src/service.ts
+++ b/time/src/service.ts
@@ -1,3 +1,4 @@
+// some change
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    // No test files changed — all should be 0
    for (const def of DEFAULT_DEFS) {
      expect(result[def.name] ?? 0).toBe(0);
    }
  });

  it("handles deletions only — returns negative count at that layer", () => {
    const diff = `
diff --git a/scripts/removed.unit.test.ts b/scripts/removed.unit.test.ts
deleted file mode 100644
--- a/scripts/removed.unit.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// deleted
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(-1);
  });

  it("does not count a modified test file as an addition", () => {
    // A modification produces --- a/<file> then +++ b/<same-file>.
    // The preceding --- a/ guard should prevent incrementing the add count.
    const diff = `
diff --git a/scripts/existing.unit.test.ts b/scripts/existing.unit.test.ts
--- a/scripts/existing.unit.test.ts
+++ b/scripts/existing.unit.test.ts
@@ -1,3 +1,4 @@
 import { describe, it } from "bun:test";
+// added a comment
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    // Net change = 0: the file was modified, not added or removed
    expect(result.unit ?? 0).toBe(0);
  });

  it("counts a new test file added alongside a modified test file correctly", () => {
    // One modification (net 0) + one genuine addition (net +1) = 1 total
    const diff = `
diff --git a/scripts/existing.unit.test.ts b/scripts/existing.unit.test.ts
--- a/scripts/existing.unit.test.ts
+++ b/scripts/existing.unit.test.ts
@@ -1,3 +1,4 @@
+// modified
diff --git a/scripts/new.unit.test.ts b/scripts/new.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/scripts/new.unit.test.ts
@@ -0,0 +1,3 @@
+// new
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(1);
  });
});

// ─── parsePlanned ─────────────────────────────────────────────────────────────

describe("parsePlanned", () => {
  it("parses a unit layer AC bullet with added file and no retired tests", () => {
    const bullet =
      "Test decision (unit layer): add shipwright/classify_test_layer.test.ts (bun:test); no existing tests retired — net-new module.";
    const result = parsePlanned([bullet]);
    expect(result).toHaveLength(1);
    expect(result[0].layers).toContain("unit");
    expect(result[0].added).toContain("shipwright/classify_test_layer.test.ts");
    expect(result[0].retired).toHaveLength(0);
  });

  it("parses an integration layer AC bullet with retired tests", () => {
    const bullet =
      "Test decision (integration layer): add time/src/timer.integration.test.ts; remove time/src/timer.test.ts";
    const result = parsePlanned([bullet]);
    expect(result).toHaveLength(1);
    expect(result[0].layers).toContain("integration");
    expect(result[0].added).toContain("time/src/timer.integration.test.ts");
    expect(result[0].retired).toContain("time/src/timer.test.ts");
  });

  it("handles multiple bullets and returns one entry per bullet", () => {
    const bullets = [
      "Test decision (unit layer): add lib/clock.unit.test.ts (bun:test); no existing tests retired — net-new module.",
      "Test decision (smoke layer): add api/src/health.smoke.test.ts; no existing tests retired.",
    ];
    const result = parsePlanned(bullets);
    expect(result).toHaveLength(2);
    expect(result[0].layers).toContain("unit");
    expect(result[1].layers).toContain("smoke");
  });

  it("returns empty array for empty input", () => {
    expect(parsePlanned([])).toHaveLength(0);
  });

  it("parses a bullet with 'retire' phrasing instead of 'remove'", () => {
    const bullet =
      "Test decision (unit layer): add lib/foo.unit.test.ts; retire lib/foo.test.ts";
    const result = parsePlanned([bullet]);
    expect(result[0].retired).toContain("lib/foo.test.ts");
  });

  it("pinned AC-format fixture: real plan-session AC bullet parses to expected structure", () => {
    // This is the exact format from the task acceptance criteria (Step 5 AC bullet)
    const bullet =
      "Test decision (unit layer): add shipwright/classify_test_layer.test.ts (bun:test, DI for file reads); no existing tests retired — net-new module.";
    const result = parsePlanned([bullet]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.layers).toEqual(["unit"]);
    expect(entry.added).toEqual(["shipwright/classify_test_layer.test.ts"]);
    expect(entry.retired).toEqual([]);
  });
});

// ─── loadDefs edge case ───────────────────────────────────────────────────────

describe("loadDefs — file present but no parseable layer table", () => {
  it("falls back to defaults when test-system.md has no bold-layer table rows", async () => {
    const fileReader = async (_path: string) => "# No layer table here\n";
    const result = await loadDefs(fileReader);
    expect(result.source).toBe("defaults");
    expect(result.defs.length).toBe(4);
  });
});

// ─── parseDiffAdditions ───────────────────────────────────────────────────────

describe("parseDiffAdditions", () => {
  it("returns per-file additions for a new test file", () => {
    const diff = `
diff --git a/time/src/a.integration.test.ts b/time/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/time/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new test
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("time/src/a.integration.test.ts");
    expect(result[0].layer).toBe("integration");
  });

  it("does not include modified test files (same path on --- and +++)", () => {
    const diff = `
diff --git a/scripts/existing.unit.test.ts b/scripts/existing.unit.test.ts
--- a/scripts/existing.unit.test.ts
+++ b/scripts/existing.unit.test.ts
@@ -1,3 +1,4 @@
+// modified
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("does not include deleted test files", () => {
    const diff = `
diff --git a/scripts/removed.unit.test.ts b/scripts/removed.unit.test.ts
deleted file mode 100644
--- a/scripts/removed.unit.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// deleted
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("does not include non-test files", () => {
    const diff = `
diff --git a/time/src/service.ts b/time/src/service.ts
--- /dev/null
+++ b/time/src/service.ts
@@ -0,0 +1,3 @@
+// new file
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("handles multiple additions and returns all", () => {
    const diff = `
diff --git a/time/src/a.integration.test.ts b/time/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/time/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new
diff --git a/scripts/foo.unit.test.ts b/scripts/foo.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/scripts/foo.unit.test.ts
@@ -0,0 +1,3 @@
+// new
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.path);
    expect(paths).toContain("time/src/a.integration.test.ts");
    expect(paths).toContain("scripts/foo.unit.test.ts");
  });
});

// ─── parseDiff — language-agnostic detection ──────────────────────────────────

describe("parseDiff — language-agnostic test detection", () => {
  const PYTHON_DEFS: LayerDef[] = [
    { name: "unit", patterns: ["**/test_*.py", "tests/unit/**"] },
    { name: "integration", patterns: ["**/test_*.py", "tests/integration/**"] },
    { name: "smoke", patterns: ["**/test_*.py", "tests/smoke/**"] },
    { name: "e2e", patterns: ["**/test_*.py", "tests/e2e/**"] },
  ];

  it("detects a Python test file as a test file when defs include Python patterns", () => {
    const diff = `
diff --git a/tests/unit/test_billing.py b/tests/unit/test_billing.py
new file mode 100644
--- /dev/null
+++ b/tests/unit/test_billing.py
@@ -0,0 +1,5 @@
+def test_invoice():
+    pass
`;
    const result = parseDiff(diff, PYTHON_DEFS);
    expect(result.unit).toBe(1);
  });

  it("ignores a Python source file (no suffix pattern match) in a Python project", () => {
    const diff = `
diff --git a/src/billing.py b/src/billing.py
--- /dev/null
+++ b/src/billing.py
@@ -0,0 +1,3 @@
+def invoice():
+    pass
`;
    const result = parseDiff(diff, PYTHON_DEFS);
    for (const def of PYTHON_DEFS) {
      expect(result[def.name] ?? 0).toBe(0);
    }
  });
});

// ─── checkConformance ─────────────────────────────────────────────────────────

const TEST_SYSTEM_DEFS: LoadDefsResult = {
  source: "test-system.md",
  defs: [
    {
      name: "smoke",
      patterns: ["**/*.smoke.test.ts", "*.smoke.test.ts"],
    },
    {
      name: "e2e",
      patterns: ["**/*.e2e.test.ts", "*.e2e.test.ts", "e2e/**"],
    },
    {
      name: "unit",
      patterns: ["**/*.unit.test.ts", "*.unit.test.ts", "scripts/**", "lib/**"],
    },
    {
      name: "integration",
      patterns: [
        "**/*.integration.test.ts",
        "*.integration.test.ts",
        "time/**",
        "accounts/**",
        "billing/**",
        "cal/**",
      ],
    },
  ],
};

const DEFAULTS_DEFS: LoadDefsResult = {
  source: "defaults",
  defs: DEFAULT_DEFS,
};

describe("checkConformance", () => {
  it("deviation detected: test-system.md present, e2e test added to time/ (prescribed integration) → deviation", () => {
    // time/** prescribes integration; adding an e2e file there is a deviation
    const additions = [
      { path: "time/src/foo.e2e.test.ts", layer: "e2e" as const },
    ];
    const report = checkConformance(additions, TEST_SYSTEM_DEFS);
    expect(report.checked).toBe(true);
    expect(report.deviations).toHaveLength(1);
    expect(report.deviations[0].module).toBe("time/**");
    expect(report.deviations[0].prescribed).toBe("integration");
    expect(report.deviations[0].observed).toBe("e2e");
  });

  it("conforming: test-system.md present, integration test added to time/ → zero deviations", () => {
    // time/** prescribes integration; adding an integration test is conforming
    const additions = [
      {
        path: "time/src/foo.integration.test.ts",
        layer: "integration" as const,
      },
    ];
    const report = checkConformance(additions, TEST_SYSTEM_DEFS);
    expect(report.checked).toBe(true);
    expect(report.deviations).toHaveLength(0);
  });

  it("absent prescriptions (test-system.md absent): source=defaults → checked=false, zero deviations", () => {
    const additions = [
      { path: "time/src/foo.e2e.test.ts", layer: "e2e" as const },
    ];
    const report = checkConformance(additions, DEFAULTS_DEFS);
    expect(report.checked).toBe(false);
    expect(report.deviations).toHaveLength(0);
  });
});

// ─── run CLI entrypoint ───────────────────────────────────────────────────────

describe("run", () => {
  it("classifies paths from args and logs results", async () => {
    const logs: string[] = [];
    await run({
      fileReader: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      },
      args: ["time/foo.test.ts", "no-match.txt"],
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes("integration"))).toBe(true);
    expect(logs.some((l) => l.includes("unknown"))).toBe(true);
  });

  it("classifies paths from stdin when args is empty", async () => {
    const logs: string[] = [];
    await run({
      fileReader: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      },
      args: [],
      stdin: "scripts/foo.unit.test.ts\n",
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes("unit"))).toBe(true);
  });

  it("reports the layer definition source", async () => {
    const logs: string[] = [];
    await run({
      fileReader: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      },
      args: [],
      stdin: "",
      log: (msg) => logs.push(msg),
    });
    expect(logs[0]).toContain("defaults");
  });
});
