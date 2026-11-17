/**
 * admin/src/coding/admin-ui-system-crons.smoke.test.ts
 * Smoke tests for GET/POST /admin/settings/system-crons (SCR-1.4), via
 * app.request() against the composed coding admin app. The task-store
 * endpoints and the GitHub-enterprise status API are plain in-memory doubles.
 */

import { describe, expect, it } from "bun:test";
import { makeSessionCookie } from "@app-vitals/agent-admin/admin-ui.fixtures";
import {
  createCodingTestApp,
  makeCodingMockDeps as makeBaseCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type {
  SystemCronItem,
  SystemCronsFetchers,
} from "./admin-ui-system-crons.ts";
import { CODING_SETTINGS_NAV_ITEMS } from "./coding-settings-nav.ts";

/** Base deps plus what the platform merges in from the extension at composition time. */
const makeCodingMockDeps = () => ({
  ...makeBaseCodingMockDeps(),
  settingsNavItems: CODING_SETTINGS_NAV_ITEMS,
});

const PATH = "/admin/settings/system-crons";

function makeCron(overrides: Partial<SystemCronItem> = {}): SystemCronItem {
  return {
    id: "dep-audit",
    name: "Dependency audit",
    schedule: "0 9 * * 1",
    timezone: "UTC",
    enabled: true,
    titleTemplate: "Audit: {repo}",
    descriptionTemplate: "Audit {repo} deps.",
    ...overrides,
  };
}

function makeStore(seed: SystemCronItem[] = [makeCron()]) {
  const crons = [...seed];
  const calls: string[] = [];
  return {
    calls,
    crons,
    fetchSystemCrons: async () => ({ systemCrons: crons }),
    patchSystemCron: async (
      id: string,
      patch: {
        titleTemplate?: string;
        descriptionTemplate?: string;
        repoScope?: "all" | "selected";
        repos?: string[];
      },
    ) => {
      calls.push(`patch ${id} ${JSON.stringify(patch)}`);
      const c = crons.find((x) => x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      return c;
    },
    setSystemCronEnabled: async (id: string, enabled: boolean) => {
      calls.push(`${enabled ? "enable" : "disable"} ${id}`);
      const c = crons.find((x) => x.id === id);
      if (!c) return null;
      c.enabled = enabled;
      return c;
    },
  };
}

const gheApi = (lookup: unknown) => async () =>
  Response.json({ configured: true, installer: null, lookup });

async function adminCookie() {
  return `admin_session=${await makeSessionCookie()}`;
}

function form(fields: Record<string, string>) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("GET /admin/settings/system-crons", () => {
  it("lists definitions with toggle and template fields; no banner when the lookup App exists", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
      githubEnterpriseApi: gheApi({ slug: "lookup-app" }),
    });
    const res = await app.request(PATH, {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Dependency audit");
    expect(html).toContain("Audit: {repo}");
    expect(html).toContain(`${PATH}/dep-audit/disable`);
    expect(html).not.toContain("lookup-app-missing");
    // Admin-only Settings nav entry is present.
    expect(html).toContain(">Settings</a>");
  });

  it("shows the banner linking to GitHub enterprise settings when the lookup App is missing", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
      githubEnterpriseApi: gheApi(null),
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(html).toContain("lookup-app-missing");
    expect(html).toMatch(
      /data-banner="lookup-app-missing">[^<]*<a href="\/admin\/settings\/github-enterprise">/,
    );
  });

  it("renders inside the shared settings layout with System crons active (SGL-3.2)", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
      githubEnterpriseApi: gheApi({ slug: "lookup-app" }),
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(html).toContain('class="settings-sidebar"');
    expect(html).toContain(
      `<a class="settings-nav-link" href="${PATH}" aria-current="page">System crons</a>`,
    );
    expect(html).toContain('href="/admin/settings/notifications"');
    expect(html).toContain('<div class="settings-nav-label">Platform</div>');
    expect(html).toContain('<div class="settings-nav-label">Personal</div>');
    // The sidebar replaces the ad hoc header cross-link and page header.
    expect(html).not.toContain("GitHub Enterprise settings</a>");
    expect(html).not.toContain('class="page-header"');
  });

  it("shows the banner when the GHE API is not wired", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(html).toContain("lookup-app-missing");
  });

  it("renders degraded (200) when the task store is unconfigured", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const res = await app.request(PATH, {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("task store is not configured");
  });

  it("is forbidden to non-admins and rejects unauthenticated callers", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
      githubEnterpriseApi: gheApi(null),
    });
    const member = `admin_session=${await makeSessionCookie(undefined, "u2", "member@example.com", false)}`;
    expect(
      (await app.request(PATH, { headers: { Cookie: member } })).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${PATH}/dep-audit/disable`, {
          ...form({}),
          headers: { Cookie: member },
        })
      ).status,
    ).toBe(403);
    const anon = await app.request(PATH, { redirect: "manual" });
    expect(anon.status).toBe(401);
  });
});

describe("POST toggle and template edit", () => {
  it("disables then enables a definition through the task-store, redirecting with a notice", async () => {
    const store = makeStore();
    const app = createCodingTestApp({ ...makeCodingMockDeps(), ...store });
    const headers = { Cookie: await adminCookie() };
    const off = await app.request(`${PATH}/dep-audit/disable`, {
      method: "POST",
      headers,
    });
    expect(off.status).toBe(302);
    expect(off.headers.get("location")).toBe(`${PATH}?notice=disabled`);
    expect(store.crons[0]?.enabled).toBe(false);
    const on = await app.request(`${PATH}/dep-audit/enable`, {
      method: "POST",
      headers,
    });
    expect(on.headers.get("location")).toBe(`${PATH}?notice=enabled`);
    expect(store.crons[0]?.enabled).toBe(true);
  });

  it("saves edited templates and shows the flash on the redirected page", async () => {
    const store = makeStore();
    const app = createCodingTestApp({ ...makeCodingMockDeps(), ...store });
    const cookie = await adminCookie();
    const res = await app.request(`${PATH}/dep-audit`, {
      ...form({
        titleTemplate: "New {repo}",
        descriptionTemplate: "Do {repo}",
      }),
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${PATH}?notice=saved`);
    expect(store.crons[0]?.titleTemplate).toBe("New {repo}");
    const page = await (
      await app.request(`${PATH}?notice=saved`, { headers: { Cookie: cookie } })
    ).text();
    expect(page).toContain("Templates saved.");
  });

  it("rejects an empty template with a 400 and does not call the task-store", async () => {
    const store = makeStore();
    const app = createCodingTestApp({ ...makeCodingMockDeps(), ...store });
    const res = await app.request(`${PATH}/dep-audit`, {
      ...form({ titleTemplate: "  ", descriptionTemplate: "ok" }),
      headers: {
        Cookie: await adminCookie(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Title template must not be empty.");
    expect(store.calls).toEqual([]);
  });

  it("redirects with an error code when the definition is missing or the store is unavailable", async () => {
    const store = makeStore();
    const app = createCodingTestApp({ ...makeCodingMockDeps(), ...store });
    const headers = { Cookie: await adminCookie() };
    const missing = await app.request(`${PATH}/nope/enable`, {
      method: "POST",
      headers,
    });
    expect(missing.headers.get("location")).toBe(`${PATH}?error=not_found`);
    const bare = createCodingTestApp(makeCodingMockDeps());
    const res = await bare.request(`${PATH}/dep-audit/enable`, {
      method: "POST",
      headers,
    });
    expect(res.headers.get("location")).toBe(
      `${PATH}?error=task_store_unavailable`,
    );
  });
});

describe("Recent runs (SCR-1.10)", () => {
  const trig = (scheduledFor: string, taskCount: number) => ({
    scheduledFor,
    claimedAt: scheduledFor,
    taskCount,
  });
  const get = async (
    store: ReturnType<typeof makeStore> & SystemCronsFetchers,
  ) => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...store,
      githubEnterpriseApi: gheApi({ slug: "lookup-app" }),
    });
    return app.request(PATH, { headers: { Cookie: await adminCookie() } });
  };

  it("lists the last 5 triggers newest first with time and task count", async () => {
    const asked: Array<[string, number]> = [];
    const res = await get({
      ...makeStore(),
      fetchSystemCronTriggers: async (id: string, limit: number) => {
        asked.push([id, limit]);
        return {
          triggers: [
            trig("2026-11-01T09:00:00.000Z", 1),
            trig("2026-11-08T09:00:00.000Z", 3),
          ],
        };
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(asked).toEqual([["dep-audit", 5]]);
    expect(html).toContain('data-recent-runs="list"');
    const newer = html.indexOf("2026-11-08 09:00 UTC — 3 tasks created");
    const older = html.indexOf("2026-11-01 09:00 UTC — 1 task created");
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newer);
  });

  it("shows an empty state when the cron has never fired", async () => {
    const html = await (
      await get({
        ...makeStore(),
        fetchSystemCronTriggers: async () => ({ triggers: [] }),
      })
    ).text();
    expect(html).toContain('data-recent-runs="empty"');
    expect(html).toContain("has not fired yet");
  });

  it("renders an inline note for a failed fetch without breaking the page", async () => {
    const store = makeStore([
      makeCron(),
      makeCron({ id: "docs-sweep", name: "Docs sweep" }),
    ]);
    const res = await get({
      ...store,
      fetchSystemCronTriggers: async (id: string) => {
        if (id === "dep-audit") throw new Error("task-store 500");
        return { triggers: [trig("2026-11-08T09:00:00.000Z", 2)] };
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-recent-runs="error"');
    expect(html).toContain("Recent runs are unavailable");
    expect(html).toContain("2026-11-08 09:00 UTC — 2 tasks created");
    expect(html).toContain("Docs sweep");
  });
});

describe("Repo selection (CRS-1.3)", () => {
  const lookup = (
    repos = [
      { fullName: "acme/web", archived: false },
      { fullName: "acme/old", archived: true },
    ],
    configured = true,
  ) => ({ listRepositories: async () => ({ configured, repos }) });
  const post = async (
    app: ReturnType<typeof createCodingTestApp>,
    fields: URLSearchParams,
  ) =>
    app.request(`${PATH}/dep-audit`, {
      method: "POST",
      headers: {
        Cookie: await adminCookie(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: fields.toString(),
    });
  const base = {
    titleTemplate: "T {repo}",
    descriptionTemplate: "D {repo}",
  };

  it("renders radios, a searchable checklist and an 'All' default summary", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore(),
      githubLookup: lookup(),
      githubEnterpriseApi: gheApi({ slug: "l" }),
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(html).toContain('name="repoScope" value="all" checked');
    expect(html).toContain('name="repoScope" value="selected"');
    expect(html).toContain("data-repo-search");
    expect(html).toContain('value="acme/web"');
    expect(html).toContain("archived");
    expect(html).toContain(">All repositories</span>");
  });

  it("shows the N-repos summary, and flags selected repos missing from the listing", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore([
        makeCron({
          repoScope: "selected",
          repos: ["acme/web", "acme/gone<x>"],
        }),
      ]),
      githubLookup: lookup(),
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(html).toContain(">2 repos</span>");
    expect(html).toContain('value="selected" checked');
    expect(html).toContain('value="acme/gone&lt;x&gt;" checked');
    expect(html).not.toContain("acme/gone<x>");
    expect(html).toContain('data-repo-flag="missing"');
    expect(html).toContain('value="acme/web" checked');
  });

  it("degrades gracefully when the lookup App is unconfigured", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore([makeCron({ repoScope: "selected", repos: ["acme/web"] })]),
      githubLookup: lookup([], false),
      githubEnterpriseApi: gheApi(null),
    });
    const res = await app.request(PATH, {
      headers: { Cookie: await adminCookie() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("lookup-app-missing");
    expect(html).toContain('data-repo-list="unavailable"');
    expect(html).toContain('value="acme/web" checked');
    expect(html).not.toContain('data-repo-flag="missing"');
  });

  it("saves 'selected' with the checked repos and 'all' clearing them", async () => {
    const store = makeStore();
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...store,
      githubLookup: lookup(),
    });
    const sel = new URLSearchParams(base);
    sel.set("repoScope", "selected");
    sel.append("repos", "acme/web");
    sel.append("repos", "acme/old");
    const r1 = await post(app, sel);
    expect(r1.status).toBe(302);
    expect(store.crons[0]?.repoScope).toBe("selected");
    expect(store.crons[0]?.repos).toEqual(["acme/web", "acme/old"]);
    const all = new URLSearchParams(base);
    all.set("repoScope", "all");
    all.append("repos", "acme/web");
    expect((await post(app, all)).status).toBe(302);
    expect(store.crons[0]?.repoScope).toBe("all");
    expect(store.crons[0]?.repos).toEqual([]);
  });

  it("rejects 'selected' with nothing checked (400) without calling the store, keeping the draft", async () => {
    const store = makeStore();
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...store,
      githubLookup: lookup(),
    });
    const f = new URLSearchParams(base);
    f.set("repoScope", "selected");
    const res = await post(app, f);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Select at least one repository");
    expect(html).toContain('value="selected" checked');
    expect(store.calls).toEqual([]);
  });

  it("leaves scope untouched when the form carries no scope field", async () => {
    const store = makeStore([
      makeCron({ repoScope: "selected", repos: ["acme/web"] }),
    ]);
    const app = createCodingTestApp({ ...makeCodingMockDeps(), ...store });
    expect((await post(app, new URLSearchParams(base))).status).toBe(302);
    expect(store.calls[0]).not.toContain("repoScope");
    expect(store.crons[0]?.repos).toEqual(["acme/web"]);
  });

  it("renders each cron's checklist from its own account's listing, one call per account", async () => {
    const calls: (string | null | undefined)[] = [];
    const byAccount: Record<string, string> = {
      a1: "acme/a1-repo",
      a2: "acme/a2-repo",
    };
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      ...makeStore([
        makeCron({ id: "dep-audit", name: "Dep audit", accountId: "a1" }),
        makeCron({ id: "docs-sweep", name: "Docs sweep", accountId: "a2" }),
        makeCron({ id: "third", name: "Third", accountId: "a1" }),
      ]),
      githubLookup: {
        listRepositories: async (accountId?: string | null) => {
          calls.push(accountId);
          return {
            configured: true,
            repos: [{ fullName: byAccount[accountId ?? ""], archived: false }],
          };
        },
      },
    });
    const html = await (
      await app.request(PATH, { headers: { Cookie: await adminCookie() } })
    ).text();
    expect(calls.sort()).toEqual(["a1", "a2"]);
    const card = (id: string) => {
      const start = html.indexOf(`data-system-cron="${id}"`);
      return html.slice(start, html.indexOf("Recent runs", start));
    };
    expect(card("dep-audit")).toContain("acme/a1-repo");
    expect(card("dep-audit")).not.toContain("acme/a2-repo");
    expect(card("docs-sweep")).toContain("acme/a2-repo");
    expect(card("docs-sweep")).not.toContain("acme/a1-repo");
    expect(card("third")).toContain("acme/a1-repo");
  });
});
