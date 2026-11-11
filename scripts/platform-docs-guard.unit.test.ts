/**
 * scripts/platform-docs-guard.unit.test.ts
 *
 * Unit layer for the platform docs snapshot guard (PLD-2.1).
 */

import { describe, expect, it } from "bun:test";
import {
  BUMP_BRANCH,
  evaluate,
  findSnapshotPaths,
  formatFailure,
} from "./platform-docs-guard.ts";

describe("findSnapshotPaths", () => {
  it("flags files under docs/platform/ only", () => {
    expect(
      findSnapshotPaths([
        "docs/platform/agent.md",
        "docs/platform/sub/x.md",
        "docs/platform.md",
        "docs/platformer/a.md",
        "docs/architecture.md",
        "scripts/platform-docs-guard.ts",
      ]),
    ).toEqual(["docs/platform/agent.md", "docs/platform/sub/x.md"]);
  });
});

describe("evaluate", () => {
  it("fails a hand edit from an ordinary branch", () => {
    const r = evaluate(["docs/platform/agent.md"], "feat/x");
    expect(r.ok).toBe(false);
    expect(r.touched).toEqual(["docs/platform/agent.md"]);
  });

  it("passes the platform release bump branch", () => {
    const r = evaluate(["docs/platform/agent.md", "bun.lock"], BUMP_BRANCH);
    expect(r.ok).toBe(true);
    expect(r.bypassed).toBe(true);
  });

  it("passes a PR that does not touch the snapshot", () => {
    const r = evaluate(["docs/architecture.md"], "feat/x");
    expect(r).toEqual({ ok: true, bypassed: false, touched: [] });
  });

  it("does not let a fork-prefixed lookalike branch through", () => {
    expect(evaluate(["docs/platform/a.md"], `fork:${BUMP_BRANCH}`).ok).toBe(
      false,
    );
  });

  it("failure message points at the platform repo", () => {
    const msg = formatFailure(["docs/platform/a.md"]);
    expect(msg).toContain("docs/platform/a.md");
    expect(msg).toContain("app-vitals/agent");
  });
});
