// Unit tests for classify-ci-failure.ts — pure logic, no I/O.

import { describe, expect, it } from "bun:test";
import { classifyCiFailure } from "./classify-ci-failure";

const job = (name: string, failedStep: string, conclusion = "failure") => ({
  name,
  conclusion,
  steps: [
    { name: "Set up job", conclusion: "success" },
    { name: failedStep, conclusion: "failure" },
  ],
});

describe("classifyCiFailure — infra-flake signatures", () => {
  it("failed checkout step -> infra-flake", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("build", "Run actions/checkout@v4")],
    });
    expect(r.classification).toBe("infra-flake");
    expect(r.scanNeverRan).toBe(false);
  });

  it("'Repository not found' log on checkout step -> infra-flake", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("build", "Checkout")],
      failedStepLog: "remote: Repository not found.",
    });
    expect(r.classification).toBe("infra-flake");
  });

  it("'exit code 128' log on checkout/setup step -> infra-flake", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("build", "Set up job")],
      failedStepLog: "The process '/usr/bin/git' failed with exit code 128",
    });
    expect(r.classification).toBe("infra-flake");
  });

  it("startup_failure -> infra-flake", () => {
    expect(classifyCiFailure({ conclusion: "startup_failure" }).classification).toBe(
      "infra-flake",
    );
  });

  it("runner shutdown signal with cancelled conclusion -> infra-flake", () => {
    const r = classifyCiFailure({
      conclusion: "cancelled",
      jobs: [job("test", "Run tests", "cancelled")],
      failedStepLog: "The runner has received a shutdown signal.",
    });
    expect(r.classification).toBe("infra-flake");
  });

  it("cancelled without a shutdown log -> real-failure", () => {
    const r = classifyCiFailure({
      conclusion: "cancelled",
      jobs: [job("test", "Run tests", "cancelled")],
      failedStepLog: "",
    });
    expect(r.classification).toBe("real-failure");
  });
});

describe("classifyCiFailure — downstream-repo incident shape", () => {
  it("checkout + Repository not found in a scan job -> scanNeverRan", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("Secret scan (gitleaks)", "Run actions/checkout@v4")],
      failedStepLog: "fatal: Repository not found.",
    });
    expect(r.classification).toBe("infra-flake");
    expect(r.scanNeverRan).toBe(true);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("classifyCiFailure — real failures", () => {
  it("failing test step -> real-failure", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("test", "Run bun test")],
      failedStepLog: "1 test failed",
    });
    expect(r.classification).toBe("real-failure");
    expect(r.scanNeverRan).toBe(false);
  });

  it("test step whose log mentions exit code 128 stays real", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("test", "Run bun test")],
      failedStepLog: "process exited with exit code 128; Repository not found",
    });
    expect(r.classification).toBe("real-failure");
  });

  it("failing scan job on a real scan step is not scanNeverRan", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      jobs: [job("secret scan", "Run gitleaks")],
      failedStepLog: "leaks found",
    });
    expect(r.classification).toBe("real-failure");
    expect(r.scanNeverRan).toBe(false);
  });
});

describe("classifyCiFailure — fail closed", () => {
  it("empty input -> real-failure", () => {
    const r = classifyCiFailure({});
    expect(r.classification).toBe("real-failure");
    expect(r.scanNeverRan).toBe(false);
  });

  it("malformed input -> real-failure", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
    expect(classifyCiFailure(null as any).classification).toBe("real-failure");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
    expect(classifyCiFailure("x" as any).classification).toBe("real-failure");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
    expect(classifyCiFailure({ jobs: "nope" } as any).classification).toBe(
      "real-failure",
    );
  });

  it("log-only flake text with no failed step info -> real-failure", () => {
    const r = classifyCiFailure({
      conclusion: "failure",
      failedStepLog: "Repository not found",
    });
    expect(r.classification).toBe("real-failure");
  });
});
