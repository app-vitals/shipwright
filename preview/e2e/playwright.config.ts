/**
 * Playwright configuration for the preview-environment browser specs.
 * Targets an already-running stack from `task preview:up` (no webServer);
 * run via `task preview:e2e`.
 */

import { defineConfig } from "@playwright/test";

const adminUrl = process.env.PREVIEW_ADMIN_URL;
if (!adminUrl) {
  throw new Error(
    "PREVIEW_ADMIN_URL is not set. Load the env file written by `task preview:up -- --env-out <file>` (e.g. `task preview:e2e ENV_FILE=<file>`).",
  );
}

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  // Generous for a cold kind cluster.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  use: {
    baseURL: adminUrl,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
