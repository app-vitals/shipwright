import { describe, expect, it } from "bun:test";
import {
  type CallerScope,
  type CallerScopeDeps,
  resolveCallerScope,
  scopeIncludesAgent,
} from "./caller-scope.ts";

function makeDeps(opts: {
  account?: Record<string, string>;
  accountAgents?: Record<string, string[]>;
  members?: Record<string, string[]>;
}): CallerScopeDeps {
  return {
    getAccountIdByEmail: async (e) => opts.account?.[e] ?? null,
    listAgentIdsByAccount: async (id) => opts.accountAgents?.[id] ?? [],
    listMemberAgentIds: async (e) => opts.members?.[e] ?? [],
  };
}

const deps = makeDeps({
  account: { "a@x.com": "acct-a", "both@x.com": "acct-a" },
  accountAgents: { "acct-a": ["ag-1", "ag-2"] },
  members: { "m@x.com": ["ag-9"], "both@x.com": ["ag-2", "ag-9"] },
});

const run = (email: string, isAdmin = false, flagEnabled = true) =>
  resolveCallerScope({ email, isAdmin, flagEnabled }, deps);

describe("resolveCallerScope", () => {
  it("returns all for admins", async () => {
    expect(await run("a@x.com", true)).toEqual({ kind: "all" });
  });

  it("account member gets every account agent", async () => {
    expect(await run("a@x.com")).toEqual({
      kind: "scoped",
      accountId: "acct-a",
      agentIds: ["ag-1", "ag-2"],
    });
  });

  it("explicit member gets only AgentMember agents", async () => {
    expect(await run("m@x.com")).toEqual({
      kind: "scoped",
      accountId: null,
      agentIds: ["ag-9"],
    });
  });

  it("account + explicit membership is unioned and deduplicated", async () => {
    const scope = await run("BOTH@x.com");
    expect(scope.kind === "scoped" && scope.agentIds.sort()).toEqual([
      "ag-1",
      "ag-2",
      "ag-9",
    ]);
  });

  it("caller with neither gets an empty scope", async () => {
    expect(await run("none@x.com")).toEqual({
      kind: "scoped",
      accountId: null,
      agentIds: [],
    });
  });

  it("flag off: account membership contributes nothing", async () => {
    expect(await run("both@x.com", false, false)).toEqual({
      kind: "scoped",
      accountId: null,
      agentIds: ["ag-2", "ag-9"],
    });
    expect(await run("a@x.com", false, false)).toEqual({
      kind: "scoped",
      accountId: null,
      agentIds: [],
    });
  });
});

describe("scopeIncludesAgent", () => {
  it("all includes anything; scoped only listed ids", () => {
    expect(scopeIncludesAgent({ kind: "all" }, "x")).toBe(true);
    const s: CallerScope = {
      kind: "scoped",
      accountId: null,
      agentIds: ["a"],
    };
    expect(scopeIncludesAgent(s, "a")).toBe(true);
    expect(scopeIncludesAgent(s, "b")).toBe(false);
  });
});
