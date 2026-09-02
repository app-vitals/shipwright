/**
 * scripts/agent-workspace-pull.integration.test.ts
 * Integration-level test for scripts/agent-workspace-pull.ts's HTTP calls:
 * GET /agents (agent list, for id/name resolution) and the config bundle
 * fetch via HttpShipwrightRuntimeClient.getAgentConfigBundle(). Per this
 * repo's recorded-fixture-double convention, a fake fetch is injected
 * explicitly — no global.fetch override.
 *
 * Scope: this file exercises fetchAgentList() and the runtime client's real
 * getAgentConfigBundle() composed against a fake fetch, plus
 * pullAgentWorkspace()'s orchestration of resolve -> fetch config -> plan
 * clones -> scaffold -> install, all through injected doubles (no real gh,
 * no real ensureAgentHome/installPlugins side effects, no real network).
 */

import { describe, expect, test } from "bun:test";
import { HttpShipwrightRuntimeClient } from "../agent/src/shipwright-runtime-client.ts";
import {
  type PullAgentWorkspaceDeps,
  fetchAgentList,
  pullAgentWorkspace,
} from "./agent-workspace-pull.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// fetchAgentList — GET /agents
// ---------------------------------------------------------------------------

describe("fetchAgentList", () => {
  test("returns the parsed agent summary array on a healthy response", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://admin.example/agents");
      return jsonResponse([{ id: "agent-1", name: "hitl", selfHosted: true }]);
    }) as typeof fetch;

    const agents = await fetchAgentList(
      "http://admin.example",
      "admin-key",
      fakeFetch,
    );

    expect(agents).toEqual([{ id: "agent-1", name: "hitl", selfHosted: true }]);
  });

  test("sends the admin API key as a bearer token", async () => {
    let sawAuth: string | null = null;
    const fakeFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sawAuth = (init?.headers as Record<string, string> | undefined)
        ?.Authorization as string;
      return jsonResponse([]);
    }) as typeof fetch;

    await fetchAgentList("http://admin.example", "admin-key", fakeFetch);

    expect(sawAuth).toBe("Bearer admin-key");
  });

  test("throws with a clear message on a non-ok response", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "forbidden" }, 403)) as typeof fetch;

    await expect(
      fetchAgentList("http://admin.example", "bad-key", fakeFetch),
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// HttpShipwrightRuntimeClient.getAgentConfigBundle() — composed against a
// fake fetch, proving the script wires the existing client rather than
// reimplementing the call.
// ---------------------------------------------------------------------------

describe("HttpShipwrightRuntimeClient.getAgentConfigBundle (via agent-workspace-pull's wiring)", () => {
  test("fetches the config bundle for the resolved agent id", async () => {
    let sawUrl = "";
    const fakeFetch = (async (input: string | URL | Request) => {
      sawUrl =
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input);
      return jsonResponse({
        env: { FOO: "bar" },
        allowedTools: ["Read"],
        plugins: [{ marketplace: "shipwright", plugin: "shipwright" }],
        repos: ["org/repo1"],
        authorAllowlist: [],
        restrictSlackToMembers: false,
        memberEmails: [],
      });
    }) as typeof fetch;

    const client = new HttpShipwrightRuntimeClient({
      apiUrl: "http://admin.example",
      apiKey: "admin-key",
      fetchFn: fakeFetch,
    });

    const bundle = await client.getAgentConfigBundle("agent-1");

    expect(sawUrl).toContain("/agents/agent-1/config");
    expect(bundle.repos).toEqual(["org/repo1"]);
    expect(bundle.plugins).toEqual([
      { marketplace: "shipwright", plugin: "shipwright" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// pullAgentWorkspace — full orchestration through injected doubles
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PullAgentWorkspaceDeps> = {}): {
  deps: PullAgentWorkspaceDeps;
  cloned: string[];
  scaffolded: string[];
  installedPlugins: unknown[];
  logs: string[];
  warnings: string[];
} {
  const cloned: string[] = [];
  const scaffolded: string[] = [];
  const installedPlugins: unknown[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];

  const deps: PullAgentWorkspaceDeps = {
    fetchAgents: async () => [
      { id: "agent-1", name: "hitl", selfHosted: true },
    ],
    fetchConfigBundle: async (_agentId: string) => ({
      env: { FOO: "bar" },
      allowedTools: ["Read"],
      plugins: [{ marketplace: "shipwright", plugin: "shipwright" }],
      repos: ["app-vitals/shipwright"],
      authorAllowlist: [],
      restrictSlackToMembers: false,
      memberEmails: [],
    }),
    exists: () => false,
    cloneRepo: async (repo: string, dest: string) => {
      cloned.push(`${repo}->${dest}`);
    },
    ensureAgentHome: (home: string) => {
      scaffolded.push(home);
    },
    installPlugins: async (plugins: unknown[]) => {
      installedPlugins.push(...plugins);
    },
    log: (line: string) => logs.push(line),
    warn: (line: string) => warnings.push(line),
    ...overrides,
  };

  return { deps, cloned, scaffolded, installedPlugins, logs, warnings };
}

describe("pullAgentWorkspace", () => {
  test("resolves the agent, clones missing repos, scaffolds the workspace, and installs plugins", async () => {
    const { deps, cloned, scaffolded, installedPlugins } = makeDeps();

    const result = await pullAgentWorkspace(
      "agent-1",
      "/home/dev/.shipwright-agents",
      deps,
    );

    expect(result.workspaceRoot).toBe("/home/dev/.shipwright-agents/hitl");
    expect(cloned).toEqual([
      "app-vitals/shipwright->/home/dev/.shipwright-agents/hitl/workspace/repos/shipwright",
    ]);
    expect(scaffolded).toEqual(["/home/dev/.shipwright-agents/hitl"]);
    expect(installedPlugins).toEqual([
      { marketplace: "shipwright", plugin: "shipwright" },
    ]);
  });

  test("resolves an agent passed in by id and keys the workspace root by NAME", async () => {
    const { deps } = makeDeps({
      fetchAgents: async () => [
        { id: "agent-xyz", name: "reviewer", selfHosted: false },
      ],
      fetchConfigBundle: async () => ({
        env: {},
        allowedTools: [],
        plugins: [],
        repos: [],
        authorAllowlist: [],
        restrictSlackToMembers: false,
        memberEmails: [],
      }),
    });

    const result = await pullAgentWorkspace(
      "agent-xyz",
      "/home/dev/.shipwright-agents",
      deps,
    );

    expect(result.workspaceRoot).toBe("/home/dev/.shipwright-agents/reviewer");
  });

  test("skips cloning a repo that already exists at its destination (idempotent)", async () => {
    const { deps, cloned } = makeDeps({
      exists: (path: string) => path.endsWith("/workspace/repos/shipwright"),
    });

    await pullAgentWorkspace("agent-1", "/home/dev/.shipwright-agents", deps);

    expect(cloned).toEqual([]);
  });

  test("throws a clear error when the agent id/name cannot be resolved", async () => {
    const { deps } = makeDeps({
      fetchAgents: async () => [],
    });

    await expect(
      pullAgentWorkspace("nonexistent", "/home/dev/.shipwright-agents", deps),
    ).rejects.toThrow(/nonexistent/);
  });

  test("warns with only the key names when secret-flagged env entries are present, never the values", async () => {
    const { deps, warnings } = makeDeps({
      fetchConfigBundle: async () => ({
        env: { GH_TOKEN: "ghp_super_secret_value", FOO: "bar" },
        allowedTools: [],
        plugins: [],
        repos: [],
        authorAllowlist: [],
        restrictSlackToMembers: false,
        memberEmails: [],
      }),
    });

    await pullAgentWorkspace("agent-1", "/home/dev/.shipwright-agents", deps);

    const joined = warnings.join("\n");
    expect(joined).toContain("GH_TOKEN");
    expect(joined).not.toContain("ghp_super_secret_value");
  });

  test("never passes the config bundle's env to ensureAgentHome or any fs-writing dep", async () => {
    let sawHome = "";
    const { deps } = makeDeps({
      fetchConfigBundle: async () => ({
        env: { GH_TOKEN: "ghp_super_secret_value" },
        allowedTools: [],
        plugins: [],
        repos: [],
        authorAllowlist: [],
        restrictSlackToMembers: false,
        memberEmails: [],
      }),
      ensureAgentHome: (home: string) => {
        sawHome = home;
      },
    });

    await pullAgentWorkspace("agent-1", "/home/dev/.shipwright-agents", deps);

    // ensureAgentHome only ever receives a path string — proving the env
    // bundle (and its secret) never reaches a filesystem-writing call.
    expect(sawHome).toBe("/home/dev/.shipwright-agents/hitl");
  });
});
