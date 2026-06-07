// Unit tests for classify_test_layer.ts — all logic tested via DI, no real FS access.

import { describe, expect, it } from "bun:test";
import {
  type LayerDef,
  type LoadDefsResult,
  PLAN_SESSION_DEFAULTS,
  checkConformance,
  classifyPath,
  loadDefs,
  parseDiff,
  parseDiffAdditions,
  parsePlanned,
  run,
} from "./classify_test_layer";

// ─── PLAN_SESSION_DEFAULTS shape ──────────────────────────────────────────────

describe("PLAN_SESSION_DEFAULTS — generic suffix-only defaults", () => {
  it("unit layer has ONLY suffix patterns (no scripts/** or lib/**)", () => {
    const unit = PLAN_SESSION_DEFAULTS.find((d) => d.name === "unit");
    expect(unit).toBeDefined();
    // Must not contain project-specific directory patterns
    expect(unit?.patterns.some((p) => p === "scripts/**")).toBe(false);
    expect(unit?.patterns.some((p) => p === "lib/**")).toBe(false);
    // Must contain only suffix-based patterns
    expect(unit?.patterns).toContain("**/*.unit.test.ts");
    expect(unit?.patterns).toContain("*.unit.test.ts");
    expect(unit?.patterns.every((p) => p.startsWith("*"))).toBe(true);
  });

  it("integration layer has ONLY suffix patterns (no time/**, accounts/**, billing/**, cal/**)", () => {
    const integration = PLAN_SESSION_DEFAULTS.find(
      (d) => d.name === "integration",
    );
    expect(integration).toBeDefined();
    // Must not contain project-specific directory patterns
    expect(integration?.patterns.some((p) => p === "time/**")).toBe(false);
    expect(integration?.patterns.some((p) => p === "accounts/**")).toBe(false);
    expect(integration?.patterns.some((p) => p === "billing/**")).toBe(false);
    expect(integration?.patterns.some((p) => p === "cal/**")).toBe(false);
    // Must contain only suffix-based patterns
    expect(integration?.patterns).toContain("**/*.integration.test.ts");
    expect(integration?.patterns).toContain("*.integration.test.ts");
    expect(integration?.patterns.every((p) => p.startsWith("*"))).toBe(true);
  });

  it("smoke layer is unchanged: only suffix patterns", () => {
    const smoke = PLAN_SESSION_DEFAULTS.find((d) => d.name === "smoke");
    expect(smoke).toBeDefined();
    expect(smoke?.patterns).toContain("**/*.smoke.test.ts");
    expect(smoke?.patterns).toContain("*.smoke.test.ts");
  });

  it("e2e layer retains both suffix patterns and generic e2e/** directory convention", () => {
    const e2e = PLAN_SESSION_DEFAULTS.find((d) => d.name === "e2e");
    expect(e2e).toBeDefined();
    expect(e2e?.patterns).toContain("**/*.e2e.test.ts");
    expect(e2e?.patterns).toContain("*.e2e.test.ts");
    expect(e2e?.patterns).toContain("e2e/**");
  });

  it("has exactly 4 layers in smoke → e2e → unit → integration order", () => {
    const names = PLAN_SESSION_DEFAULTS.map((d) => d.name);
    expect(names).toEqual(["smoke", "e2e", "unit", "integration"]);
  });
});

// ─── Default defs fixture (generic) ──────────────────────────────────────────

const DEFAULT_DEFS: LayerDef[] = [
  { name: "smoke", patterns: ["**/*.smoke.test.ts", "*.smoke.test.ts"] },
  { name: "e2e", patterns: ["**/*.e2e.test.ts", "*.e2e.test.ts", "e2e/**"] },
  {
    name: "unit",
    patterns: ["**/*.unit.test.ts", "*.unit.test.ts"],
  },
  {
    name: "integration",
    patterns: ["**/*.integration.test.ts", "*.integration.test.ts"],
  },
];

// ─── classifyPath ─────────────────────────────────────────────────────────────

describe("classifyPath", () => {
  it("returns unknown for a path that matches no layer", () => {
    const result = classifyPath("no-match-path.txt", DEFAULT_DEFS);
    expect(result).toBe("unknown");
  });

  it("returns unknown for an empty defs list", () => {
    const result = classifyPath("foo.unit.test.ts", []);
    expect(result).toBe("unknown");
  });

  it("classifies foo.unit.test.ts as unit via suffix pattern", () => {
    const result = classifyPath("foo.unit.test.ts", DEFAULT_DEFS);
    expect(result).toBe("unit");
  });

  it("classifies nested/path/foo.unit.test.ts as unit via **/*.unit.test.ts", () => {
    const result = classifyPath("nested/path/foo.unit.test.ts", DEFAULT_DEFS);
    expect(result).toBe("unit");
  });

  it("classifies foo.integration.test.ts as integration via suffix pattern", () => {
    const result = classifyPath("foo.integration.test.ts", DEFAULT_DEFS);
    expect(result).toBe("integration");
  });

  it("classifies nested/path/foo.integration.test.ts as integration via **/*.integration.test.ts", () => {
    const result = classifyPath(
      "nested/path/foo.integration.test.ts",
      DEFAULT_DEFS,
    );
    expect(result).toBe("integration");
  });

  it("classifies foo.smoke.test.ts as smoke", () => {
    const result = classifyPath("foo.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies api/health.smoke.test.ts as smoke via **/*.smoke.test.ts", () => {
    const result = classifyPath("api/health.smoke.test.ts", DEFAULT_DEFS);
    expect(result).toBe("smoke");
  });

  it("classifies e2e/journeys/foo.spec.ts as e2e via e2e/**", () => {
    const result = classifyPath("e2e/journeys/foo.spec.ts", DEFAULT_DEFS);
    expect(result).toBe("e2e");
  });

  it("classifies api/journey.e2e.test.ts as e2e via **/*.e2e.test.ts", () => {
    const result = classifyPath("api/journey.e2e.test.ts", DEFAULT_DEFS);
    expect(result).toBe("e2e");
  });

  it("classifies scripts/check-coverage.ts as unknown (no directory pattern in generic defaults)", () => {
    const result = classifyPath("scripts/check-coverage.ts", DEFAULT_DEFS);
    expect(result).toBe("unknown");
  });

  it("classifies lib/clock.ts as unknown (no directory pattern in generic defaults)", () => {
    const result = classifyPath("lib/clock.ts", DEFAULT_DEFS);
    expect(result).toBe("unknown");
  });

  it("classifies time/foo.test.ts as unknown (no directory pattern in generic defaults)", () => {
    const result = classifyPath("time/foo.test.ts", DEFAULT_DEFS);
    expect(result).toBe("unknown");
  });
});

// ─── loadDefs ─────────────────────────────────────────────────────────────────

const TEST_SYSTEM_MD_STUB = `
## Layer definitions

| Layer | Patterns |
|---|---|
| **unit** | *.unit.test.ts |
| **integration** | *.integration.test.ts |
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

describe("loadDefs — test-system.md absent (fallback to generic defaults)", () => {
  it("reports source as 'defaults' when the file cannot be read", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    expect(result.source).toBe("defaults");
  });

  it("returns 4 layers in smoke → e2e → unit → integration order", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    expect(result.defs.length).toBe(4);
    const names = result.defs.map((d) => d.name);
    expect(names).toEqual(["smoke", "e2e", "unit", "integration"]);
  });

  it("default unit layer contains ONLY suffix patterns (no scripts/** or lib/**)", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    const unit = result.defs.find((d) => d.name === "unit");
    expect(unit).toBeDefined();
    expect(unit?.patterns).toContain("**/*.unit.test.ts");
    expect(unit?.patterns).toContain("*.unit.test.ts");
    expect(unit?.patterns.some((p) => p === "scripts/**")).toBe(false);
    expect(unit?.patterns.some((p) => p === "lib/**")).toBe(false);
  });

  it("default integration layer contains ONLY suffix patterns (no time/**, accounts/**, etc.)", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    const integration = result.defs.find((d) => d.name === "integration");
    expect(integration).toBeDefined();
    expect(integration?.patterns).toContain("**/*.integration.test.ts");
    expect(integration?.patterns).toContain("*.integration.test.ts");
    expect(integration?.patterns.some((p) => p === "time/**")).toBe(false);
    expect(integration?.patterns.some((p) => p === "accounts/**")).toBe(false);
  });

  it("default e2e layer retains e2e/** directory pattern", async () => {
    const fileReader = async (_path: string) => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    };
    const result = await loadDefs(fileReader);
    const e2e = result.defs.find((d) => d.name === "e2e");
    expect(e2e).toBeDefined();
    expect(e2e?.patterns).toContain("e2e/**");
  });
});

describe("loadDefs — file present but no parseable layer table", () => {
  it("falls back to defaults when test-system.md has no bold-layer table rows", async () => {
    const fileReader = async (_path: string) => "# No layer table here\n";
    const result = await loadDefs(fileReader);
    expect(result.source).toBe("defaults");
    expect(result.defs.length).toBe(4);
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

  it("counts an added unit test file (+++) under the unit layer", () => {
    const diff = `
diff --git a/src/foo.unit.test.ts b/src/foo.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/src/foo.unit.test.ts
@@ -0,0 +1,5 @@
+import { describe, it } from "bun:test";
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(1);
  });

  it("counts a deleted unit test file (---) as -1", () => {
    const diff = `
diff --git a/src/old.unit.test.ts b/src/old.unit.test.ts
deleted file mode 100644
--- a/src/old.unit.test.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-import { describe, it } from "bun:test";
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit).toBe(-1);
  });

  it("counts multiple added and deleted integration test files correctly", () => {
    const diff = `
diff --git a/src/a.integration.test.ts b/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new test
diff --git a/src/b.integration.test.ts b/src/b.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/src/b.integration.test.ts
@@ -0,0 +1,3 @@
+// new test 2
diff --git a/src/old.integration.test.ts b/src/old.integration.test.ts
deleted file mode 100644
--- a/src/old.integration.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// removed test
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    // 2 adds - 1 delete = net 1
    expect(result.integration).toBe(1);
  });

  it("ignores non-test source files in diff", () => {
    const diff = `
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,3 +1,4 @@
+// some change
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    for (const def of DEFAULT_DEFS) {
      expect(result[def.name] ?? 0).toBe(0);
    }
  });

  it("does not count a modified test file as an addition", () => {
    const diff = `
diff --git a/src/existing.unit.test.ts b/src/existing.unit.test.ts
--- a/src/existing.unit.test.ts
+++ b/src/existing.unit.test.ts
@@ -1,3 +1,4 @@
 import { describe, it } from "bun:test";
+// added a comment
`;
    const result = parseDiff(diff, DEFAULT_DEFS);
    expect(result.unit ?? 0).toBe(0);
  });

  it("counts a new test file added alongside a modified test file correctly", () => {
    const diff = `
diff --git a/src/existing.unit.test.ts b/src/existing.unit.test.ts
--- a/src/existing.unit.test.ts
+++ b/src/existing.unit.test.ts
@@ -1,3 +1,4 @@
+// modified
diff --git a/src/new.unit.test.ts b/src/new.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/src/new.unit.test.ts
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
      "Test decision (unit layer): add plugins/shipwright/scripts/classify_test_layer.unit.test.ts (bun:test); no existing tests retired — net-new module.";
    const result = parsePlanned([bullet]);
    expect(result).toHaveLength(1);
    expect(result[0].layers).toContain("unit");
    expect(result[0].added).toContain(
      "plugins/shipwright/scripts/classify_test_layer.unit.test.ts",
    );
    expect(result[0].retired).toHaveLength(0);
  });

  it("parses an integration layer AC bullet with retired tests", () => {
    const bullet =
      "Test decision (integration layer): add src/timer.integration.test.ts; remove src/timer.test.ts";
    const result = parsePlanned([bullet]);
    expect(result).toHaveLength(1);
    expect(result[0].layers).toContain("integration");
    expect(result[0].added).toContain("src/timer.integration.test.ts");
    expect(result[0].retired).toContain("src/timer.test.ts");
  });

  it("handles multiple bullets and returns one entry per bullet", () => {
    const bullets = [
      "Test decision (unit layer): add src/clock.unit.test.ts (bun:test); no existing tests retired — net-new module.",
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
      "Test decision (unit layer): add src/foo.unit.test.ts; retire src/foo.test.ts";
    const result = parsePlanned([bullet]);
    expect(result[0].retired).toContain("src/foo.test.ts");
  });
});

// ─── parseDiffAdditions ───────────────────────────────────────────────────────

describe("parseDiffAdditions", () => {
  it("returns per-file additions for a new integration test file", () => {
    const diff = `
diff --git a/src/a.integration.test.ts b/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new test
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/a.integration.test.ts");
    expect(result[0].layer).toBe("integration");
  });

  it("does not include modified test files (same path on --- and +++)", () => {
    const diff = `
diff --git a/src/existing.unit.test.ts b/src/existing.unit.test.ts
--- a/src/existing.unit.test.ts
+++ b/src/existing.unit.test.ts
@@ -1,3 +1,4 @@
+// modified
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("does not include deleted test files", () => {
    const diff = `
diff --git a/src/removed.unit.test.ts b/src/removed.unit.test.ts
deleted file mode 100644
--- a/src/removed.unit.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// deleted
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("does not include non-test source files", () => {
    const diff = `
diff --git a/src/service.ts b/src/service.ts
--- /dev/null
+++ b/src/service.ts
@@ -0,0 +1,3 @@
+// new file
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(0);
  });

  it("handles multiple additions and returns all", () => {
    const diff = `
diff --git a/src/a.integration.test.ts b/src/a.integration.test.ts
new file mode 100644
--- /dev/null
+++ b/src/a.integration.test.ts
@@ -0,0 +1,3 @@
+// new
diff --git a/src/foo.unit.test.ts b/src/foo.unit.test.ts
new file mode 100644
--- /dev/null
+++ b/src/foo.unit.test.ts
@@ -0,0 +1,3 @@
+// new
`;
    const result = parseDiffAdditions(diff, DEFAULT_DEFS);
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.path);
    expect(paths).toContain("src/a.integration.test.ts");
    expect(paths).toContain("src/foo.unit.test.ts");
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
  it("classifies suffix-based paths from args and logs results", async () => {
    const logs: string[] = [];
    await run({
      fileReader: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      },
      args: ["src/foo.unit.test.ts", "no-match.txt"],
      log: (msg) => logs.push(msg),
    });
    expect(logs.some((l) => l.includes("unit"))).toBe(true);
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
      stdin: "src/foo.unit.test.ts\n",
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
