import { describe, expect, it, spyOn } from "bun:test";
import {
  type AgentExtension,
  classifyAllGeneric,
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
