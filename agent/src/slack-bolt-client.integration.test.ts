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
 * tokenVerificationEnabled: false is required — with the (Bolt) default of
 * true, the App constructor fires a REAL, unawaited `client.auth.test(...)`
 * call against the live Slack API as a side effect of building the
 * `authorize` function, even though this test never calls .start() or
 * emits an event. With a dummy token that call rejects (invalid_auth) on
 * its own timeline; since nothing in this test awaits or catches it, the
 * rejection surfaces as an unhandled rejection attributed to whichever
 * *other* test happens to be running when the network response lands —
 * only reproducible under full-suite load, where enough wall-clock time
 * passes for the response to arrive mid-suite. Disabling eager token
 * verification defers the auth.test call until `authorize` is actually
 * invoked, which never happens here, and doesn't change what this test
 * verifies (the client's dependency-resolution shape).
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
