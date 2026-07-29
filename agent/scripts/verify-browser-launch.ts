/**
 * agent/scripts/verify-browser-launch.ts
 * CI-only smoke check: proves Chromium actually launches inside the built
 * agent image under the pod's restricted securityContext.
 *
 * A green `bun test` run in CI's normal (unrestricted) process does not
 * prove Chromium launches under Kubernetes' runAsNonRoot +
 * allowPrivilegeEscalation: false + no-sudo securityContext — only running
 * the built image with matching restrictions does. The `agent-docker-build`
 * CI job invokes this script via:
 *
 *   docker run --rm --user 1000 --security-opt=no-new-privileges \
 *     --entrypoint bun shipwright-agent:ci \
 *     run agent/scripts/verify-browser-launch.ts
 *
 * Launches via launchBrowser() (agent/src/browser.ts), navigates a trivial
 * data: URL, and confirms the page content is readable. Exits 0 on success,
 * 1 with a clear stderr message on any failure.
 */

import { launchBrowser } from "../src/browser.ts";

try {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(
      "data:text/html,<title>verify-browser-launch</title><h1>ok</h1>",
    );
    const title = await page.title();
    const content = await page.content();
    if (title !== "verify-browser-launch" || !content.includes("ok")) {
      throw new Error(
        `unexpected page state: title="${title}" content="${content}"`,
      );
    }
    console.log("Browser launched and navigated successfully.");
  } finally {
    await browser.close();
  }
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`Error: browser failed to launch or navigate — ${msg}`);
  process.exit(1);
}

process.exit(0);
