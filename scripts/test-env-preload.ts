/**
 * scripts/test-env-preload.ts
 *
 * Wired into bunfig.toml's `[test] preload` array so this runs before any
 * test file loads, for every `bun test` invocation in this repo — the root
 * suite, any subpackage's own test script, and any single-file invocation
 * (`bun test path/to/file.test.ts`). This is defense-in-depth so
 * `buildSentryInitOptions()` (lib/sentry.ts) reliably treats test runs as
 * inert, without depending on the invoking shell/CI/human not already having
 * exported a conflicting NODE_ENV. Centralizing here (rather than prefixing
 * individual invocation sites, as SEN-3.1 did) means every future test
 * invocation path is covered automatically, with no per-site risk of someone
 * forgetting the prefix.
 */

export function setTestEnv(): void {
  process.env.NODE_ENV = "test";
}

setTestEnv();
