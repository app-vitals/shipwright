/**
 * agent/src/browser.ts
 *
 * Launches a headless Chromium browser for the agent's browser-driven tools
 * (e.g. the PW-1.x line of work). Runs under the container's restricted
 * securityContext (runAsNonRoot, allowPrivilegeEscalation: false, no sudo) —
 * there is no real Linux user-namespace sandbox available, so Chromium's own
 * OS-level sandbox must be disabled via --no-sandbox / --disable-setuid-sandbox
 * (and Playwright's chromiumSandbox option, which wraps the same behavior).
 *
 * Browser resolution: chromium.launch({ headless: true }) with no explicit
 * `channel` resolves to the chromium-headless-shell executable whenever it's
 * installed (confirmed against playwright-core@1.61.1's actual launch-time
 * executable resolution: BrowserType.getExecutableName() returns
 * "chromium-headless-shell" when options.headless is true and no channel is
 * set — see server/chromium/chromium.ts, bundled into lib/coreBundle.js).
 * This matches Playwright's documented default headless-mode behavior since
 * v1.49 (https://github.com/microsoft/playwright/issues/33566) — no channel
 * string needs to be passed. agent/Dockerfile installs exactly this browser
 * (`playwright install chromium-headless-shell`, PW-1.1), so no other
 * Chromium variant is present in the runtime image for headless launches to
 * fall back to.
 */

import { chromium } from "playwright";
import type { Browser } from "playwright";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}
