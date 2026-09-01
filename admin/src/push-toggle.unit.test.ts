/**
 * admin/src/push-toggle.unit.test.ts
 * Unit tests for the push-toggle fragment rendered into the chat thread page.
 *
 * AC 5: the toggle requests permission ONLY inside a click handler; a denied
 *       state shows guidance and never re-prompts.
 * AC 6: when push is disabled server-side the fragment is EXACTLY "" — the page
 *       degrades to the CFB-3.2 page with no toggle and no remnants.
 */

import { describe, expect, it } from "bun:test";
import { renderPushToggle } from "./push-toggle.ts";

describe("renderPushToggle — server-side gate (AC 6)", () => {
  it("renders nothing when push is disabled server-side", () => {
    expect(
      renderPushToggle({
        pushEnabled: false,
        vapidPublicKey: "",
        agentId: "a",
        threadId: "t",
      }),
    ).toBe("");
  });

  it("renders nothing when the vapid public key is missing even if flagged enabled", () => {
    expect(
      renderPushToggle({
        pushEnabled: true,
        vapidPublicKey: "",
        agentId: "a",
        threadId: "t",
      }),
    ).toBe("");
  });
});

describe("renderPushToggle — enabled", () => {
  const html = renderPushToggle({
    pushEnabled: true,
    vapidPublicKey: "BPUBLICKEY",
    agentId: "agt_1",
    threadId: "thr_1",
  });

  it("embeds the vapid public key for pushManager.subscribe", () => {
    expect(html).toContain("BPUBLICKEY");
    expect(html).toContain("pushManager");
  });

  it("requests permission ONLY inside a click handler, never on load (AC 5)", () => {
    // requestPermission must be lexically inside an addEventListener('click').
    const clickIdx = html.indexOf("addEventListener('click'");
    const permIdx = html.indexOf("Notification.requestPermission");
    expect(clickIdx).toBeGreaterThan(-1);
    expect(permIdx).toBeGreaterThan(clickIdx);
    // It must NOT be called on page load.
    expect(html).not.toContain("requestPermission();\n"); // no bare top-level call
  });

  it("guards against re-prompting when permission is already denied (AC 5)", () => {
    expect(html).toContain("'denied'");
    // Guidance text for the denied state.
    expect(html.toLowerCase()).toContain("browser settings");
  });

  it("distinguishes iOS not-yet-installed from unsupported (iOS honesty)", () => {
    expect(html).toContain("standalone");
    expect(html.toLowerCase()).toContain("add to home screen");
  });

  it("only touches pushManager after serviceWorker.ready", () => {
    const readyIdx = html.indexOf("serviceWorker.ready");
    const subIdx = html.indexOf("pushManager.subscribe");
    expect(readyIdx).toBeGreaterThan(-1);
    expect(subIdx).toBeGreaterThan(readyIdx);
  });
});
