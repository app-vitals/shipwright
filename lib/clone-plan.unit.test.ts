/**
 * lib/clone-plan.unit.test.ts
 * Unit tests for computeMissingClones() — relocated from hitl.unit.test.ts
 * (AWP-1.1) when the function was extracted out of scripts/hitl.ts into this
 * shared module. Same assertions, moved not duplicated.
 */

import { describe, expect, test } from "bun:test";
import { computeMissingClones, findRepoNameCollisions } from "./clone-plan.ts";

describe("computeMissingClones", () => {
  test("returns [] for an empty repos list", () => {
    expect(computeMissingClones([], "/ws/repos", () => false)).toEqual([]);
  });

  test("skips repos already cloned under reposDir", () => {
    const existing = new Set(["/ws/repos/shipwright"]);
    const missing = computeMissingClones(
      ["app-vitals/shipwright"],
      "/ws/repos",
      (path) => existing.has(path),
    );
    expect(missing).toEqual([]);
  });

  test("includes missing repos with the correct dest path", () => {
    const missing = computeMissingClones(
      ["app-vitals/shipwright"],
      "/ws/repos",
      () => false,
    );
    expect(missing).toEqual([
      { repo: "app-vitals/shipwright", dest: "/ws/repos/shipwright" },
    ]);
  });

  test("mix of already-cloned and missing repos — only missing ones are returned", () => {
    const existing = new Set(["/ws/repos/shipwright"]);
    const missing = computeMissingClones(
      ["app-vitals/shipwright", "some-org/other-repo"],
      "/ws/repos",
      (path) => existing.has(path),
    );
    expect(missing).toEqual([
      { repo: "some-org/other-repo", dest: "/ws/repos/other-repo" },
    ]);
  });
});

describe("findRepoNameCollisions", () => {
  test("reports the later-listed same-basename repo under a different owner", () => {
    expect(
      findRepoNameCollisions(["acme/api", "other/web", "globex/api"]),
    ).toEqual([{ repo: "globex/api", collidesWith: "acme/api" }]);
  });

  test("is case-insensitive on owner and name", () => {
    expect(findRepoNameCollisions(["Acme/API", "globex/api"])).toEqual([
      { repo: "globex/api", collidesWith: "Acme/API" },
    ]);
    expect(findRepoNameCollisions(["Acme/api", "acme/API"])).toEqual([]);
  });

  test("ignores identical repos and distinct names", () => {
    expect(findRepoNameCollisions(["acme/api", "acme/api"])).toEqual([]);
    expect(findRepoNameCollisions(["acme/api", "acme/web"])).toEqual([]);
    expect(findRepoNameCollisions([])).toEqual([]);
  });
});
