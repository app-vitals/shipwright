import { defineConfig, devices } from "@playwright/test";

// Smoke config: build the static site, then serve it with `astro preview`.
// Astro preview defaults to port 4321.
const PORT = 4321;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // SKIP_PAGEFIND=1 lets CI-equivalent local environments skip the pagefind
    // indexing step (e.g. ARM systems where the pagefind binary fails due to
    // jemalloc/page-size incompatibilities). CI always runs without this var,
    // so pagefind runs normally in GitHub Actions.
    command: process.env.SKIP_PAGEFIND
      ? `bunx astro build && bunx astro preview --port ${PORT}`
      : `bunx astro build && bunx pagefind --site dist && bunx astro preview --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
