/**
 * Playwright configuration for Admin UI E2E tests.
 * Runs headless Chromium against a local Bun.serve instance (port 3490).
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3490",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
