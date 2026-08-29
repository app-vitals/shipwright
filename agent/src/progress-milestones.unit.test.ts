/**
 * Tests for agent/src/progress-milestones.ts
 *
 * Strategy: call phaseForBlock directly with plain content-block objects.
 * The load-bearing invariant under test — `block.input` must never be read —
 * is verified both via string-absence assertions and via a `Proxy`/getter
 * trap that throws if `input` is ever accessed, proving the code path
 * genuinely never touches it (not just that it doesn't leak downstream).
 */

import { describe, expect, test } from "bun:test";
import { phaseForBlock } from "./progress-milestones.ts";

describe("phaseForBlock — thinking / text blocks", () => {
  test("maps a thinking block to the thinking phase", () => {
    expect(phaseForBlock({ type: "thinking", thinking: "hmm" })).toBe(
      "thinking",
    );
  });

  test("maps a text block to the writing phase", () => {
    expect(phaseForBlock({ type: "text", text: "Here you go." })).toBe(
      "writing",
    );
  });
});

describe("phaseForBlock — reading tools", () => {
  for (const name of ["Read", "NotebookRead"]) {
    test(`maps ${name} to the reading phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "reading",
      );
    });
  }
});

describe("phaseForBlock — searching tools", () => {
  for (const name of ["Grep", "Glob"]) {
    test(`maps ${name} to the searching phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "searching",
      );
    });
  }
});

describe("phaseForBlock — web tools", () => {
  for (const name of ["WebSearch", "WebFetch"]) {
    test(`maps ${name} to the web phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe("web");
    });
  }
});

describe("phaseForBlock — editing tools", () => {
  for (const name of ["Edit", "Write", "NotebookEdit"]) {
    test(`maps ${name} to the editing phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "editing",
      );
    });
  }
});

describe("phaseForBlock — running tools", () => {
  for (const name of ["Bash", "KillShell", "BashOutput"]) {
    test(`maps ${name} to the running phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "running",
      );
    });
  }
});

describe("phaseForBlock — delegating tools", () => {
  for (const name of ["Agent", "Task"]) {
    test(`maps ${name} to the delegating phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "delegating",
      );
    });
  }
});

describe("phaseForBlock — planning tools", () => {
  for (const name of ["TodoWrite", "ExitPlanMode", "EnterPlanMode"]) {
    test(`maps ${name} to the planning phase`, () => {
      expect(phaseForBlock({ type: "tool_use", name, input: {} })).toBe(
        "planning",
      );
    });
  }
});

describe("phaseForBlock — generic fallback", () => {
  test("maps an mcp__*-prefixed tool name to the generic tool phase", () => {
    expect(
      phaseForBlock({
        type: "tool_use",
        name: "mcp__linear__create_issue",
        input: {},
      }),
    ).toBe("tool");
  });

  test("maps an unrecognized tool name to the generic tool phase", () => {
    expect(
      phaseForBlock({ type: "tool_use", name: "SomeFutureTool", input: {} }),
    ).toBe("tool");
  });

  test("never throws for an unknown tool name — always returns a phase", () => {
    expect(() =>
      phaseForBlock({ type: "tool_use", name: "", input: {} }),
    ).not.toThrow();
    expect(phaseForBlock({ type: "tool_use", name: "", input: {} })).toBe(
      "tool",
    );
  });
});

describe("phaseForBlock — unmapped block types", () => {
  test("returns undefined for a tool_result block (out of scope)", () => {
    expect(
      phaseForBlock({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "ok",
      } as never),
    ).toBeUndefined();
  });
});

// ─── The load-bearing invariant: block.input is NEVER read ──────────────────

describe("phaseForBlock — never reads block.input", () => {
  test("phase output never contains secret/path substrings embedded in input", () => {
    const forbidden = ["/home/alice/.ssh/id_rsa", "sk-fake-12345"];
    const block = {
      type: "tool_use" as const,
      name: "Bash",
      input: {
        command: "cat /home/alice/.ssh/id_rsa",
        api_key: "sk-fake-12345",
      },
    };
    const phase = phaseForBlock(block);
    expect(phase).toBe("running");
    for (const secret of forbidden) {
      expect(String(phase)).not.toContain(secret);
    }
  });

  test("throws if `input` is ever accessed — proves the code path never reads it", () => {
    let accessed = false;
    const block = {
      type: "tool_use" as const,
      name: "Read",
      get input() {
        accessed = true;
        throw new Error("block.input must never be read by phaseForBlock");
      },
    };

    const phase = phaseForBlock(block);

    expect(accessed).toBe(false);
    expect(phase).toBe("reading");
  });

  test("throws-on-access input still works for an unrecognized tool name (generic fallback path)", () => {
    let accessed = false;
    const block = {
      type: "tool_use" as const,
      name: "SomeFutureTool",
      get input() {
        accessed = true;
        throw new Error("block.input must never be read by phaseForBlock");
      },
    };

    const phase = phaseForBlock(block);

    expect(accessed).toBe(false);
    expect(phase).toBe("tool");
  });
});
