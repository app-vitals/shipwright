/**
 * scripts/generate-admin-spec.unit.test.ts
 *
 * The committed admin spec artifacts are exactly what generate-admin-spec.ts
 * writes: byte-identical, so a route change that skipped
 * `bun run generate:admin-spec` fails here. The composed admin/openapi.json is
 * the platform document with the coding contributions folded in; the platform
 * document itself is the one @app-vitals/agent-admin ships (AGR-4.2).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ADMIN_SPEC_OUTPUTS,
  buildAdminSpecArtifacts,
  serializeSpec,
} from "./generate-admin-spec.ts";

const artifacts = buildAdminSpecArtifacts();

describe("generate-admin-spec artifacts", () => {
  for (const key of ["composed", "coding"] as const) {
    it(`committed ${key} spec is byte-identical to the generated one`, () => {
      // If this fails, run `bun run generate:admin-spec && bun run generate:admin-types`.
      expect(readFileSync(ADMIN_SPEC_OUTPUTS[key], "utf8")).toBe(
        serializeSpec(artifacts[key]),
      );
    });
  }

  it("the platform spec is the one @app-vitals/agent-admin ships", () => {
    expect(
      readFileSync(
        Bun.resolveSync(
          "@app-vitals/agent-admin/openapi.platform.json",
          import.meta.dir,
        ),
        "utf8",
      ),
    ).toBe(serializeSpec(artifacts.platform));
  });

  it("the platform spec carries no coding path or schema", () => {
    const platformPaths = Object.keys(artifacts.platform.paths);
    const platformSchemas = Object.keys(
      artifacts.platform.components?.schemas ?? {},
    );
    expect(
      Object.keys(artifacts.coding.paths).filter((p) =>
        platformPaths.includes(p),
      ),
    ).toEqual([]);
    // Shared component names (e.g. Error) are allowed; coding-only ones are not.
    expect(
      ["PhaseMethodologyListWrapper", "WorkQueueSnapshotWrapper"].filter((s) =>
        platformSchemas.includes(s),
      ),
    ).toEqual([]);
  });

  it("platform + coding paths are exactly the composed spec's paths", () => {
    expect(
      [
        ...Object.keys(artifacts.platform.paths),
        ...Object.keys(artifacts.coding.paths),
      ].sort(),
    ).toEqual(Object.keys(artifacts.composed.paths).sort());
  });
});
