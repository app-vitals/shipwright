#!/usr/bin/env bun
/**
 * scripts/refresh-anthropic-openapi-spec.ts
 * Refresh the vendored Anthropic OpenAPI spec used to validate the Anthropic
 * identity client's test cassettes.
 *
 * Downloads scripts/mock-spec.json.gz from anthropics/anthropic-sdk-typescript
 * at the git tag matching the exact @anthropic-ai/sdk version in
 * admin/package.json (tag format: sdk-v<version>), verifies it is an OpenAPI
 * 3.1 document, and writes it unchanged (gzipped) next to a SDK_VERSION marker
 * in admin/src/fixtures/anthropic-openapi/.
 *
 * The spec is kept gzipped: it is a ~3.6 MB single-line JSON document, so a
 * decompressed copy would be neither reviewable as a diff nor small.
 *
 * Usage: bun scripts/refresh-anthropic-openapi-spec.ts
 * Bump the SDK first (admin/package.json, exact version), then run this.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_PACKAGE_JSON = join(REPO_ROOT, "admin", "package.json");
const DEFAULT_OUT_DIR = join(
  REPO_ROOT,
  "admin",
  "src",
  "fixtures",
  "anthropic-openapi",
);

export function specUrlForVersion(version: string): string {
  return `https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/sdk-v${version}/scripts/mock-spec.json.gz`;
}

/** The exact @anthropic-ai/sdk version declared in a package.json. */
export function readPinnedSdkVersion(packageJson: string): string {
  const pkg = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
  };
  const version = pkg.dependencies?.["@anthropic-ai/sdk"];
  if (!version) {
    throw new Error("@anthropic-ai/sdk is not a dependency in package.json");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `@anthropic-ai/sdk must be pinned to an exact version (got "${version}") so the spec cannot drift from the SDK`,
    );
  }
  return version;
}

export interface RefreshOptions {
  version: string;
  outDir: string;
  fetchFn: typeof fetch;
  writeFile: (path: string, data: Uint8Array | string) => void;
}

export async function refreshAnthropicOpenApiSpec(
  opts: RefreshOptions,
): Promise<{ version: string; url: string; bytes: number }> {
  const url = specUrlForVersion(opts.version);
  const resp = await opts.fetchFn(url);
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  const gz = new Uint8Array(await resp.arrayBuffer());
  let spec: { openapi?: string };
  try {
    spec = JSON.parse(gunzipSync(gz).toString("utf-8"));
  } catch {
    throw new Error(`${url} is not a gzipped JSON document`);
  }
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.1")) {
    throw new Error(`${url} is not an OpenAPI 3.1 document`);
  }
  opts.writeFile(join(opts.outDir, "mock-spec.json.gz"), gz);
  opts.writeFile(join(opts.outDir, "SDK_VERSION"), `${opts.version}\n`);
  return { version: opts.version, url, bytes: gz.byteLength };
}

if (import.meta.main) {
  const version = readPinnedSdkVersion(
    readFileSync(ADMIN_PACKAGE_JSON, "utf-8"),
  );
  mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const result = await refreshAnthropicOpenApiSpec({
    version,
    outDir: DEFAULT_OUT_DIR,
    fetchFn: fetch,
    writeFile: (path, data) => writeFileSync(path, data),
  });
  console.log(
    `Wrote Anthropic OpenAPI spec for @anthropic-ai/sdk ${result.version} (${result.bytes} bytes) from ${result.url}`,
  );
}
