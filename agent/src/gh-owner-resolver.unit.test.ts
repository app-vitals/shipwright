/**
 * agent/src/gh-owner-resolver.unit.test.ts
 *
 * Unit tests for gh owner resolution. Pure logic — exec is injected.
 */

import { describe, expect, it } from "bun:test";
import { type ExecFn, resolveGhOwner } from "./gh-owner-resolver.ts";

const DEFAULT = "default-org";
const resolve = (args: string[], exec?: ExecFn) =>
  resolveGhOwner(args, { defaultOwner: DEFAULT, cwd: "/work", exec });
const remote =
  (url: string): ExecFn =>
  () =>
    url;

describe("resolveGhOwner — repo flags", () => {
  it("-R OWNER/REPO", () => {
    expect(resolve(["pr", "list", "-R", "acme/widgets"])).toBe("acme");
  });
  it("--repo OWNER/REPO", () => {
    expect(resolve(["pr", "list", "--repo", "acme/widgets"])).toBe("acme");
  });
  it("--repo=OWNER/REPO", () => {
    expect(resolve(["pr", "list", "--repo=acme/widgets"])).toBe("acme");
  });
  it("HOST/OWNER/REPO", () => {
    expect(resolve(["pr", "list", "-R", "github.com/acme/widgets"])).toBe(
      "acme",
    );
  });
  it("flag wins over api path and cwd remote", () => {
    expect(
      resolve(
        ["api", "repos/other/x/pulls", "-R", "acme/widgets"],
        remote("git@github.com:z/y.git"),
      ),
    ).toBe("acme");
  });
  it("dangling -R falls back to default", () => {
    expect(resolve(["pr", "list", "-R"])).toBe(DEFAULT);
  });
});

describe("resolveGhOwner — api paths", () => {
  it("repos/<owner>/...", () => {
    expect(resolve(["api", "repos/acme/widgets/pulls"])).toBe("acme");
  });
  it("/repos/<owner>/...", () => {
    expect(resolve(["api", "/repos/acme/widgets/pulls"])).toBe("acme");
  });
  it("full API URL", () => {
    expect(
      resolve(["api", "https://api.github.com/repos/acme/widgets/pulls"]),
    ).toBe("acme");
  });
  it("GHES API URL", () => {
    expect(
      resolve(["api", "https://ghe.example.com/api/v3/repos/acme/widgets"]),
    ).toBe("acme");
  });
  it("finds the path after leading flags", () => {
    expect(resolve(["api", "-X", "POST", "repos/acme/widgets/issues"])).toBe(
      "acme",
    );
  });
  it("gh api graphql falls back to default, ignoring cwd remote", () => {
    expect(
      resolve(
        ["api", "graphql", "-f", "query=x"],
        remote("git@github.com:acme/w.git"),
      ),
    ).toBe(DEFAULT);
  });
  it("non-repo api path falls back to default", () => {
    expect(resolve(["api", "user"])).toBe(DEFAULT);
  });
});

describe("resolveGhOwner — repo clone", () => {
  it("OWNER/REPO", () => {
    expect(resolve(["repo", "clone", "acme/widgets"])).toBe("acme");
  });
  it("URL", () => {
    expect(resolve(["repo", "clone", "https://github.com/acme/widgets"])).toBe(
      "acme",
    );
  });
  it("ignores git flags after --", () => {
    expect(
      resolve(["repo", "clone", "acme/widgets", "--", "--depth", "1"]),
    ).toBe("acme");
  });
  it("bare repo name falls through to cwd remote", () => {
    expect(
      resolve(
        ["repo", "clone", "widgets"],
        remote("https://github.com/cwd-org/x.git"),
      ),
    ).toBe("cwd-org");
  });
});

describe("resolveGhOwner — cwd remote", () => {
  it("ssh remote", () => {
    expect(
      resolve(["pr", "list"], remote("git@github.com:acme/widgets.git")),
    ).toBe("acme");
  });
  it("https remote", () => {
    expect(
      resolve(["pr", "list"], remote("https://github.com/acme/widgets.git")),
    ).toBe("acme");
  });
  it("exec failure falls back to default", () => {
    expect(
      resolve(["pr", "list"], () => {
        throw new Error("not a git repo");
      }),
    ).toBe(DEFAULT);
  });
  it("non-github remote falls back to default", () => {
    expect(resolve(["pr", "list"], remote("git@gitlab.com:acme/w.git"))).toBe(
      DEFAULT,
    );
  });
  it("no exec injected falls back to default", () => {
    expect(resolve(["pr", "list"])).toBe(DEFAULT);
  });
});

describe("resolveGhOwner — defaults and invalid owners", () => {
  it("owner-less commands fall back to default", () => {
    expect(
      resolve(["auth", "status"], remote("git@github.com:acme/w.git")),
    ).toBe(DEFAULT);
  });
  it("no args", () => {
    expect(resolve([])).toBe(DEFAULT);
  });
  it.each([
    ["leading hyphen", "-bad/repo"],
    ["shell metachar", "ac;me/repo"],
    ["path traversal", "../repo"],
    ["too long", `${"a".repeat(40)}/repo`],
    ["empty owner", "/repo"],
    ["no slash", "justarepo"],
  ])("invalid owner (%s) falls back to default", (_n, ref) => {
    expect(
      resolve(["pr", "list", "-R", ref], remote("git@github.com:acme/w.git")),
    ).toBe(DEFAULT);
  });
  it("invalid owner in api path falls back to default", () => {
    expect(resolve(["api", "repos/bad$owner/x/pulls"])).toBe(DEFAULT);
  });
});
