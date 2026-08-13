---
name: verify
description: >-
  Project override for verifying a change in this repository. Activates whenever you are about
  to confirm that a change actually works — "verify this", "does this work", "check the page
  renders", "confirm the dashboard loads", "test this in a browser" — or whenever you are
  about to tell the user you could not verify something locally. In this repo a real headless
  Chromium IS available via `launchBrowser()`, so browser-testable changes must be verified
  locally rather than deferred to CI.
---

# Verify — project override for this repository

This repo ships its own headless Chromium. **Do not fall back to "I can't test this locally,
trust CI"** for a change on a browser-testable surface here. That framing is wrong in this
repository, and using it hides regressions until after a PR is open.

## The rule

Before claiming a change is unverifiable locally, check which case you are in:

| Situation | What to do |
|---|---|
| The change touches a browser-testable surface **in this repo** | Verify it locally with `launchBrowser()`. Do not defer to CI. |
| The executing environment genuinely lacks the capability | Say so explicitly, name the missing capability, then fall back to CI. |
| The change is in **another repo** without this capability | Fall back to CI — this skill's guarantee is repo-local. |

"Genuinely lacks the capability" means Playwright's chromium-headless-shell is not installed —
e.g. non-agent-image local dev where `bun install` did not pull browsers. It does **not** mean
"running headless", "no display", or "in a container". Those are all supported.

## The local-verification path

`launchBrowser()` lives in [`agent/src/browser.ts`](../../../agent/src/browser.ts) (added in
PW-1.2). It returns a Playwright `Browser` already configured for this repo's restricted
container `securityContext` — headless, `chromiumSandbox: false`, and
`--no-sandbox --disable-setuid-sandbox`. You do not need to configure any of that yourself.

```ts
import { launchBrowser } from "./agent/src/browser.ts";

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3460/dashboard");
  await page.waitForSelector("[data-testid=…]");
  // assert on rendered output, console errors, network failures
} finally {
  await browser.close();
}
```

Always close the browser in a `finally` — a leaked Chromium process will hang the test run.

## Browser-testable surfaces in this repo

- `site/*.spec.ts` — the Astro marketing site (Playwright, run from `site/`, **not** part of
  root `bun test`)
- `metrics/e2e/` — the metrics dashboard (`dashboard.e2e.ts`, served by `test-server.ts`)
- `admin/e2e/` — the admin console (`agents-page.e2e.ts`, `login-page.e2e.ts`)

A change to the server-rendered dashboard, the admin console UI, or the marketing site is
browser-testable. Verify it.

## What this does not change

This skill governs **how you verify**, not what tests you commit. The repo's test-layer
conventions still apply — tests land with the code, at the correct layer, in the same PR, with
the layer encoded in the filename (see `docs/testing.md`). Running a browser to confirm a
change works is not a substitute for landing the appropriate `*.e2e.ts` / `*.smoke.test.ts`
coverage.
