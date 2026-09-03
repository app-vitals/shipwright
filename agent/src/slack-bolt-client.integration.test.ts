/**
 * agent/src/slack-bolt-client.integration.test.ts
 *
 * Regression coverage for the streaming API surface SlackProgress
 * (slack-progress.ts) now depends on unconditionally. With the
 * SHIPWRIGHT_SLACK_THINKING_STEPS_ENABLED flag removed (TSD-1.1),
 * streaming is the *only* mode — every agent, on every message, hits
 * `chat.startStream`, `chat.appendStream`, and `chat.stopStream` on the
 * client Bolt hands its event handlers (`app.client`).
 *
 * That client is built internally by @slack/bolt from *its own*
 * dependency's `@slack/web-api` resolution — not the top-level
 * `@slack/web-api` dependency declared in agent/package.json used elsewhere
 * (e.g. the standalone `new WebClient(...)` in index.ts). This is the same
 * class of risk the original setStatus-focused test (#2997/#3003) guarded
 * against, now pointed at the streaming namespace: if Bolt's nested
 * `@slack/web-api` copy ever diverges from (or predates) the top-level one
 * and lacks these streaming methods, `app.client.chat.startStream` is
 * `undefined` at runtime and every progress call silently fails (caught and
 * warn-logged by SlackProgress, never crashing — see slack-progress.ts).
 * The old setStatus/agents.sessions assertion is gone because that code
 * path was removed with the flag.
 *
 * Neither existing suite catches this:
 *   - slack-progress.unit.test.ts mocks `client.chat.startStream` etc.
 *     directly, so it passes regardless of which @slack/web-api Bolt actually
 *     resolves.
 *   - slack.integration.test.ts injects a MockApp via createSlackApp's
 *     appFactory param — it never constructs a real @slack/bolt App, so it
 *     can't observe Bolt's real internal client shape.
 *
 * This test constructs a REAL @slack/bolt App (construction only — no
 * .start(), no live socket-mode connection) with dummy credentials and
 * asserts the resolved dependency tree actually has the streaming APIs on
 * the client Bolt builds. This is the only test in the suite that would
 * catch a future re-pin or transitive bump that un-dedupes the nested
 * @slack/web-api copy from the top-level one.
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
 * already promises ("construction only ... no live connection") — the client
 * shape assertion doesn't depend on verifying the dummy token is valid.
 */

import { describe, expect, test } from "bun:test";
import { App } from "@slack/bolt";

describe("real @slack/bolt App — client dependency resolution", () => {
  test("app.client.chat has the streaming APIs SlackProgress depends on", () => {
    const app = new App({
      token: "xoxb-dummy-token",
      appToken: "xapp-dummy-token",
      socketMode: true,
      signingSecret: "dummy-signing-secret",
      tokenVerificationEnabled: false,
    });

    // The three streaming methods SlackProgress now calls unconditionally in
    // every mode (flag removed, TSD-1.1) — see slack-progress.ts.
    expect(typeof app.client.chat.startStream).toBe("function");
    expect(typeof app.client.chat.appendStream).toBe("function");
    expect(typeof app.client.chat.stopStream).toBe("function");
  });
});
