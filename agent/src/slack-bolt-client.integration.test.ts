/**
 * agent/src/slack-bolt-client.integration.test.ts
 *
 * Regression coverage for the #2997/#3003 incident: SlackProgress
 * (slack-progress.ts) calls `this.client.agents.sessions.setStatus(...)` on
 * the client Bolt hands its event handlers (`app.client`). That client is
 * built internally by @slack/bolt from *its own* dependency's `@slack/web-api`
 * resolution — not the top-level `@slack/web-api` dependency declared in
 * agent/package.json used elsewhere (e.g. the standalone `new WebClient(...)`
 * in index.ts). If Bolt's nested `@slack/web-api` copy predates the Agent
 * Sessions API, `app.client.agents` is `undefined` at runtime and every
 * setStatus call silently fails (caught and warn-logged by
 * SlackProgress.setStatus, never crashing — see slack-progress.ts).
 *
 * Neither existing suite catches this:
 *   - slack-progress.unit.test.ts mocks `client.agents.sessions.setStatus`
 *     directly, so it passes regardless of which @slack/web-api Bolt actually
 *     resolves.
 *   - slack.integration.test.ts injects a MockApp via createSlackApp's
 *     appFactory param — it never constructs a real @slack/bolt App, so it
 *     can't observe Bolt's real internal client shape.
 *
 * This test constructs a REAL @slack/bolt App (construction only — no
 * .start(), no live socket-mode connection) with dummy credentials and
 * asserts the resolved dependency tree actually has the Agent Sessions API
 * on the client Bolt builds. This is the only test in the suite that would
 * catch a future re-pin or transitive bump that un-dedupes the nested
 * @slack/web-api copy from the top-level one again.
 *
 * CPS-1.1 follow-up: Bolt 5.x's `App` constructor — independent of
 * `socketMode`/receiver config, confirmed by reading App.js's init()
 * (node_modules/@slack/bolt/dist/App.js) — calls `this.client.auth.test({
 * token })` to verify the token, gated on the constructor's
 * `tokenVerificationEnabled` option (defaults to `true`). With this suite's
 * dummy token that call reached the real Slack API and rejected with
 * WebAPIPlatformError("invalid_auth") shortly *after* construction
 * returned — this test's assertion had already run and the (synchronous)
 * test had already finished, so bun:test had no handle on that promise. It
 * surfaced process-wide as an "Unhandled error between tests" landing in
 * whichever file happened to be running at that moment — the root cause of
 * the "different unrelated test fails every CI run" pattern observed on PR
 * #3006 and #3008. `tokenVerificationEnabled: false` below disables that
 * auth.test() call entirely, matching what this test's own docstring above
 * already promised ("construction only ... no live connection") but wasn't
 * actually achieving — the client shape assertion doesn't depend on
 * verifying the dummy token is valid.
 */

import { describe, expect, test } from "bun:test";
import { App } from "@slack/bolt";

describe("real @slack/bolt App — client dependency resolution", () => {
  test("app.client.agents.sessions.setStatus is a function (Agent Sessions API present)", () => {
    const app = new App({
      token: "xoxb-dummy-token",
      appToken: "xapp-dummy-token",
      socketMode: true,
      signingSecret: "dummy-signing-secret",
      tokenVerificationEnabled: false,
    });

    expect(typeof app.client.agents?.sessions?.setStatus).toBe("function");
  });
});
