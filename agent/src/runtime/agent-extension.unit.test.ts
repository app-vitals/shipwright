import { describe, expect, it, spyOn } from "bun:test";
import {
  type AgentExtension,
  classifyAllGeneric,
  composeExtensions,
  type ExtensionCronJob,
  type PeriodicPass,
  planCronSchedule,
  runPeriodicPasses,
} from "./agent-extension.ts";

const job = (id: string, enabled = true): ExtensionCronJob => ({
  id,
  name: id,
  enabled,
  parentCronId: null,
});

describe("planCronSchedule", () => {
  it("calls onCronJobs before classifyCronJobs, with the same fresh list", () => {
    const calls: string[] = [];
    const jobs = [job("a")];
    const extension: AgentExtension = {
      onCronJobs: (j) => {
        calls.push(`onCronJobs:${j === jobs}`);
      },
      classifyCronJobs: (j) => {
        calls.push(`classify:${j === jobs}`);
        return [];
      },
    };
    planCronSchedule(extension, jobs);
    planCronSchedule(extension, jobs);
    expect(calls).toEqual([
      "onCronJobs:true",
      "classify:true",
      "onCronJobs:true",
      "classify:true",
    ]);
  });

  it("defaults to all-generic when the extension has no classifier", () => {
    const planned = planCronSchedule({}, [job("a"), job("b", false)]);
    expect(planned).toEqual([{ job: job("a"), dispatch: "generic" }]);
  });
});

describe("classifyAllGeneric", () => {
  it("keeps only enabled jobs, all generic", () => {
    expect(
      classifyAllGeneric([job("a"), job("b", false)]).map((e) => e.dispatch),
    ).toEqual(["generic"]);
  });
});

describe("runPeriodicPasses", () => {
  it("runs passes in order and isolates a failing pass with its own log prefix", async () => {
    const order: string[] = [];
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const pass = (name: string, fail = false): PeriodicPass => ({
      name,
      logPrefix: `[${name}]`,
      run: async () => {
        order.push(name);
        if (fail) throw new Error("boom");
      },
    });
    await runPeriodicPasses([pass("one"), pass("two", true), pass("three")]);
    expect(order).toEqual(["one", "two", "three"]);
    expect(errors).toHaveBeenCalledWith(
      "[two] tick failed (non-fatal):",
      "boom",
    );
    errors.mockRestore();
  });
});

describe("composeExtensions", () => {
  it("with no extensions behaves like an agent with no agent-type behavior", async () => {
    const extension = composeExtensions([]);
    expect(() => extension.onConfigSync?.({})).not.toThrow();
    expect(extension.periodicPasses).toEqual([]);
    expect(planCronSchedule(extension, [job("a"), job("b", false)])).toEqual([
      { job: job("a"), dispatch: "generic" },
    ]);
    expect(extension.dispatchLoop).toBeUndefined();
  });

  it("returns a single extension as-is", () => {
    const stub: AgentExtension = { periodicPasses: [] };
    expect(composeExtensions([stub])).toBe(stub);
  });

  it("fans out notify hooks and concatenates passes in order", () => {
    const calls: string[] = [];
    const pass = (name: string): PeriodicPass => ({
      name,
      logPrefix: `[${name}]`,
      run: async () => {},
    });
    const a: AgentExtension = {
      onConfigSync: () => calls.push("a:sync"),
      onCronJobs: () => calls.push("a:jobs"),
      periodicPasses: [pass("a1")],
    };
    const b: AgentExtension = {
      onConfigSync: () => calls.push("b:sync"),
      periodicPasses: [pass("b1"), pass("b2")],
    };
    const composed = composeExtensions([a, b]);
    composed.onConfigSync?.({});
    composed.onCronJobs?.([]);
    expect(calls).toEqual(["a:sync", "b:sync", "a:jobs"]);
    expect(composed.periodicPasses?.map((p) => p.name)).toEqual([
      "a1",
      "b1",
      "b2",
    ]);
  });

  it("lets the first extension defining classify / dispatchLoop own it", async () => {
    const dispatched: string[] = [];
    const owner: AgentExtension = {
      classifyCronJobs: (jobs) =>
        jobs.map((j) => ({ job: j, dispatch: "loop" })),
      dispatchLoop: async (id) => {
        dispatched.push(id);
      },
    };
    const composed = composeExtensions([
      {},
      owner,
      { dispatchLoop: async () => {} },
    ]);
    expect(planCronSchedule(composed, [job("x")])[0].dispatch).toBe("loop");
    await composed.dispatchLoop?.("x");
    expect(dispatched).toEqual(["x"]);
  });
});
