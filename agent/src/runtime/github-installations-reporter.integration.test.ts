/**
 * Integration: GitHubInstallationsManager -> HttpGitHubInstallationsReporter.
 * Real manager with injected auth/fetch/clock, reporter wired via onChange.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { GitHubInstallationsManager } from "./github-installations.ts";
import { HttpGitHubInstallationsReporter } from "./github-installations-reporter.ts";

const SECRET_TOKEN = "ghs_SECRET_TOKEN_VALUE";
const SECRET_JWT = "eyJ.SECRET.JWT";

function setup(opts: { reporterFetch?: typeof fetch } = {}) {
  let mintFail: number | null = null;
  let seq = 0;
  const bodies: string[] = [];
  const auth = async (p?: { type: string }) =>
    p?.type === "app"
      ? { token: SECRET_JWT, expiresAt: "", type: "app", tokenType: "app" }
      : mintFail
        ? Promise.reject(
            Object.assign(new Error("rejected"), { status: mintFail }),
          )
        : {
            token: `${SECRET_TOKEN}_${++seq}`,
            expiresAt: new Date(Date.UTC(2030, 0, 1)).toISOString(),
            type: "token",
            tokenType: "installation",
          };
  const discovery = (async () =>
    new Response(
      JSON.stringify([
        { id: 1, account: { login: "acme" }, suspended_at: null },
      ]),
    )) as unknown as typeof fetch;
  const reporterFetch =
    opts.reporterFetch ??
    ((async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
  const clock = { now: () => new Date(Date.UTC(2029, 0, 1)) };
  const reporter = new HttpGitHubInstallationsReporter({
    apiUrl: "http://api",
    agentId: "a1",
    apiKey: "KEY",
    fetchFn: reporterFetch,
    clock,
  });
  const manager = new GitHubInstallationsManager({
    auth: auth as never,
    fetchFn: discovery,
    clock,
    onChange: (s) => void reporter.report(s),
  });
  return {
    manager,
    bodies,
    setMintFail: (s: number | null) => {
      mintFail = s;
    },
  };
}

describe("manager -> reporter", () => {
  let spies: ReturnType<typeof spyOn>[];
  beforeEach(() => {
    spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  it("mint failure marks broken without discovery; later success clears it", async () => {
    const h = setup();
    h.setMintFail(403);
    await h.manager.reconcile(["acme"]);
    await h.manager.refresh();
    const states = () =>
      h.bodies.map((b) => JSON.parse(b).installations[0].state as string);
    expect(states().at(-1)).toBe("broken");
    h.setMintFail(null);
    await h.manager.reconcile(["acme"]); // clears the rejection for retry
    await h.manager.refresh();
    expect(states().at(-1)).toBe("ok");
  });

  it("refresh with no state change posts nothing extra", async () => {
    const h = setup();
    await h.manager.reconcile(["acme"]);
    await h.manager.refresh();
    const n = h.bodies.length;
    await h.manager.refresh();
    await h.manager.refresh();
    expect(h.bodies).toHaveLength(n);
  });

  it("a reporter that rejects or times out does not change manager behavior", async () => {
    const h = setup({
      reporterFetch: (async () => {
        throw new Error("timeout");
      }) as unknown as typeof fetch,
    });
    await h.manager.reconcile(["acme"]);
    await h.manager.refresh();
    expect(h.manager.getState().installations[0].health).toBe("ok");
    expect(await h.manager.getToken(1)).toContain(SECRET_TOKEN);
  });

  it("no token or key material in any posted payload", async () => {
    const h = setup();
    await h.manager.reconcile(["acme"]);
    await h.manager.refresh();
    expect(h.bodies.length).toBeGreaterThan(0);
    for (const b of h.bodies) {
      expect(b).not.toContain("ghs_");
      expect(b).not.toContain("SECRET");
    }
  });
});
