/**
 * task-store/src/system-cron-service.unit.test.ts
 * Unit tests for resolveRepoScope (CRS-1.1) — pure validation, no DB.
 */

import { describe, expect, it } from "bun:test";
import { BadRequestError } from "./errors.ts";
import { MAX_FIRE_REPOS, resolveRepoScope } from "./system-cron-service.ts";

describe("resolveRepoScope", () => {
  it("defaults to all with no repos", () => {
    expect(resolveRepoScope({})).toEqual({ repoScope: "all", repos: [] });
  });

  it("'all' clears any supplied repos", () => {
    expect(resolveRepoScope({ repoScope: "all", repos: ["a/b"] })).toEqual({
      repoScope: "all",
      repos: [],
    });
  });

  it("'selected' de-duplicates, preserving first-seen order", () => {
    expect(
      resolveRepoScope({ repoScope: "selected", repos: ["a/b", "c/d", "a/b"] }),
    ).toEqual({ repoScope: "selected", repos: ["a/b", "c/d"] });
  });

  it("rejects an unknown scope", () => {
    expect(() => resolveRepoScope({ repoScope: "some" })).toThrow(
      BadRequestError,
    );
    expect(() => resolveRepoScope({ repoScope: 1 })).toThrow(BadRequestError);
  });

  it("rejects 'selected' with missing, empty or non-array repos", () => {
    for (const repos of [undefined, [], "a/b", null]) {
      expect(() => resolveRepoScope({ repoScope: "selected", repos })).toThrow(
        BadRequestError,
      );
    }
  });

  it("rejects invalid org/repo entries", () => {
    for (const bad of ["nope", "a/b/c", "a b/c", 5]) {
      expect(() =>
        resolveRepoScope({ repoScope: "selected", repos: [bad] }),
      ).toThrow(BadRequestError);
    }
  });

  it("caps at MAX_FIRE_REPOS", () => {
    const ok = Array.from({ length: MAX_FIRE_REPOS }, (_, i) => `a/r${i}`);
    expect(
      resolveRepoScope({ repoScope: "selected", repos: ok }).repos,
    ).toHaveLength(MAX_FIRE_REPOS);
    expect(() =>
      resolveRepoScope({ repoScope: "selected", repos: [...ok, "a/extra"] }),
    ).toThrow(BadRequestError);
  });

  it("falls back to the current definition for omitted fields", () => {
    const current = { repoScope: "selected", repos: ["a/b"] };
    expect(resolveRepoScope({}, current)).toEqual({
      repoScope: "selected",
      repos: ["a/b"],
    });
    expect(resolveRepoScope({ repos: ["c/d"] }, current).repos).toEqual([
      "c/d",
    ]);
    // current 'all' + repos-only patch: stays 'all', repos ignored.
    expect(
      resolveRepoScope({ repos: ["c/d"] }, { repoScope: "all", repos: [] }),
    ).toEqual({ repoScope: "all", repos: [] });
    expect(() =>
      resolveRepoScope(
        { repoScope: "selected" },
        { repoScope: "all", repos: [] },
      ),
    ).toThrow(BadRequestError);
  });
});
