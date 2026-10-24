/**
 * scripts/platform-freeze-guard.unit.test.ts
 *
 * Unit layer for the platform path freeze guard (AGR-2.4).
 */

import { describe, expect, it } from "bun:test";
import {
  BYPASS_LABEL,
  evaluate,
  findFrozenPaths,
  formatFailure,
} from "./platform-freeze-guard.ts";
import type { PlatformManifest } from "./platform-gate.ts";

const manifest: PlatformManifest = {
  version: 1,
  include: ["agent/src/runtime/**", "admin/**"],
  exclude: ["admin/src/coding/**"],
  lib: [],
  generated: [],
  compositionRoots: [{ path: "admin/src/main.ts", reason: "per consumer" }],
  exemptions: [],
};

describe("findFrozenPaths", () => {
  it("flags platform paths", () => {
    expect(
      findFrozenPaths(
        ["admin/src/server.ts", "agent/src/runtime/boot.ts"],
        manifest,
      ),
    ).toEqual(["admin/src/server.ts", "agent/src/runtime/boot.ts"]);
  });

  it("ignores composition roots", () => {
    expect(findFrozenPaths(["admin/src/main.ts"], manifest)).toEqual([]);
  });

  it("ignores coding and unrelated paths", () => {
    expect(
      findFrozenPaths(
        ["admin/src/coding/x.ts", "task-store/src/a.ts", "README.md"],
        manifest,
      ),
    ).toEqual([]);
  });
});

describe("evaluate", () => {
  it("fails a PR touching a platform path", () => {
    const r = evaluate(["admin/src/server.ts"], [], manifest);
    expect(r.ok).toBe(false);
    expect(r.frozen).toEqual(["admin/src/server.ts"]);
  });

  it("passes a PR touching only coding or task-store", () => {
    const r = evaluate(
      ["admin/src/coding/x.ts", "task-store/src/a.ts"],
      [],
      manifest,
    );
    expect(r.ok).toBe(true);
    expect(r.bypassed).toBe(false);
  });

  it("passes a PR touching only a composition root", () => {
    expect(evaluate(["admin/src/main.ts"], [], manifest).ok).toBe(true);
  });

  it("bypasses with the cutover label", () => {
    const r = evaluate(["admin/src/server.ts"], [BYPASS_LABEL], manifest);
    expect(r.ok).toBe(true);
    expect(r.bypassed).toBe(true);
  });

  it("does not report bypass when nothing is frozen", () => {
    expect(evaluate(["README.md"], [BYPASS_LABEL], manifest).bypassed).toBe(
      false,
    );
  });
});

describe("formatFailure", () => {
  it("points contributors at app-vitals/agent", () => {
    const msg = formatFailure(["admin/src/server.ts"]);
    expect(msg).toContain("app-vitals/agent");
    expect(msg).toContain("admin/src/server.ts");
    expect(msg).toContain(BYPASS_LABEL);
  });
});
