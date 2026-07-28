/**
 * scripts/test-env-preload.ts
 *
 * Wired into bunfig.toml's `[test] preload` array so this runs before any
 * test file loads, for every `bun test` invocation whose cwd is the repo
 * root — the root suite and any single-file invocation run from root
 * (`bun test path/to/file.test.ts`). This is defense-in-depth so
 * `buildSentryInitOptions()` (lib/sentry.ts) reliably treats test runs as
 * inert, without depending on the invoking shell/CI/human not already having
 * exported a conflicting NODE_ENV.
 *
 * Bun does not apply a root bunfig.toml's preload to a `bun test` run whose
 * cwd is a subpackage directory (no local bunfig.toml there) — each
 * subpackage's own `test` script (mcp-server, task-store, agent, metrics,
 * admin, plugins/shipwright, chat) carries an explicit `NODE_ENV=test`
 * prefix as a second guard for that invocation shape, until Bun supports
 * preload inheritance for nested/filtered runs.
 */

export function setTestEnv(): void {
  process.env.NODE_ENV = "test";
}

setTestEnv();
