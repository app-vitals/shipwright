/**
 * scripts/generate-admin-spec.ts
 * Generate the OpenAPI 3.1 specs for the Shipwright admin service.
 *
 *   1. Builds the platform-only document (buildPlatformAdminSpec from the
 *      @app-vitals/agent-admin package: the admin CRUD app and the agent
 *      runtime app merged, no extension routes) and writes it to
 *      admin/openapi.platform.json. It feeds the platform half of the admin
 *      types (lib/admin-types.ts).
 *   2. Folds in the static OpenAPI contributions of the admin extensions
 *      main.ts composes (AEP-2.1): the coding extension's routes, each placed
 *      at its historical position (AEP-3.2), and writes the composed document
 *      to admin/openapi.json (unchanged by the split).
 *   3. Writes the coding extension's contributions alone as a standalone
 *      document to admin/src/coding/openapi.coding.json. It feeds the coding
 *      half of the admin types (admin/src/coding/admin-types.ts), kept by
 *      Shipwright.
 *
 * Usage:
 *   bun run generate:admin-spec
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyOpenApiContributions,
  collectOpenApiContributions,
} from "@app-vitals/agent-admin/admin-extension";
import { buildPlatformAdminSpec } from "@app-vitals/agent-admin/admin-spec";
import { adminExtensions } from "@app-vitals/agent-admin/main";

/** The admin package directory (admin/ in this repo). */
export const ADMIN_DIR = dirname(
  Bun.resolveSync("@app-vitals/agent-admin/package.json", import.meta.dir),
);

export interface AdminSpecArtifacts {
  /** admin/openapi.platform.json — platform routes only. */
  platform: ReturnType<typeof buildPlatformAdminSpec>;
  /** admin/openapi.json — platform plus every composed extension. */
  composed: ReturnType<typeof buildPlatformAdminSpec>;
  /** admin/src/coding/openapi.coding.json — the extensions' routes alone. */
  coding: {
    openapi: "3.1.0";
    info: { title: string; version: string; description: string };
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };
}

/** Builds the three admin spec documents; pure apart from app construction. */
export function buildAdminSpecArtifacts(): AdminSpecArtifacts {
  const platform = buildPlatformAdminSpec();
  const contributions = collectOpenApiContributions(adminExtensions);
  return {
    platform,
    composed: applyOpenApiContributions(platform, contributions),
    coding: {
      openapi: "3.1.0",
      info: {
        title: "Shipwright Admin API (coding extension)",
        version: platform.info.version,
        description:
          "The coding admin extension's routes alone — the part of admin/openapi.json not served by the platform admin.",
      },
      paths: contributions.paths,
      components: { schemas: contributions.schemas },
    },
  };
}

/** Repo-relative output path of each artifact, keyed like AdminSpecArtifacts. */
export const ADMIN_SPEC_OUTPUTS: Record<keyof AdminSpecArtifacts, string> = {
  platform: join(ADMIN_DIR, "openapi.platform.json"),
  composed: join(ADMIN_DIR, "openapi.json"),
  coding: join(ADMIN_DIR, "src", "coding", "openapi.coding.json"),
};

/** The exact bytes written for a spec document. */
export function serializeSpec(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

if (import.meta.main) {
  const artifacts = buildAdminSpecArtifacts();
  for (const key of Object.keys(ADMIN_SPEC_OUTPUTS) as Array<
    keyof AdminSpecArtifacts
  >) {
    writeFileSync(ADMIN_SPEC_OUTPUTS[key], serializeSpec(artifacts[key]));
    console.log(`Written to ${ADMIN_SPEC_OUTPUTS[key]}`);
  }
}
