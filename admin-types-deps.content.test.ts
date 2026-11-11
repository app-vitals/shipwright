/**
 * Content guard for the `generate:admin-types` dependency resolution (AFB-1.1).
 *
 * @redocly/openapi-core (pulled in by openapi-typescript) pins js-yaml 4.3.2 and
 * needs `types.merge`, which js-yaml 5 dropped. The root keeps js-yaml on v5 for
 * its own code, so redocly must resolve a nested 4.x copy.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");

describe("generate:admin-types dependency resolution", () => {
  it("scopes redocly's js-yaml to 4.3.2 via overrides", () => {
    expect(pkg.overrides["@redocly/openapi-core"]).toEqual({
      "js-yaml": "4.3.2",
    });
  });

  it("keeps the root js-yaml override on v5", () => {
    expect(pkg.overrides["js-yaml"]).toMatch(/^\^5/);
  });

  it("locks a nested js-yaml 4.x for redocly and no js-yaml 5 link", () => {
    expect(lock).toMatch(/"@redocly\/openapi-core\/js-yaml": \["js-yaml@4\./);
    expect(lock).toMatch(/"js-yaml": \["js-yaml@5\./);
  });

  it("pins the openapi-typescript version the script invokes", () => {
    expect(pkg.scripts["generate:admin-types"]).toContain(
      "bunx openapi-typescript@7.",
    );
  });
});
