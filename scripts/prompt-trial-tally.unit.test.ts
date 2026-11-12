import { describe, expect, test } from "bun:test";
import {
  costOf,
  formatReport,
  median,
  parseArgs,
  parseTranscript,
  tallyVariants,
} from "./prompt-trial-tally";

const line = (o: unknown) => JSON.stringify(o);
const user = (sessionId: string, text: string) =>
  line({ type: "user", sessionId, message: { role: "user", content: text } });
const assistant = (
  sessionId: string,
  opts: {
    sidechain?: boolean;
    usage?: Record<string, number>;
    costUSD?: number;
    tools?: { name: string; input: Record<string, unknown> }[];
    id?: string;
  },
) =>
  line({
    type: "assistant",
    sessionId,
    isSidechain: opts.sidechain ?? false,
    ...(opts.costUSD === undefined ? {} : { costUSD: opts.costUSD }),
    message: {
      role: "assistant",
      ...(opts.id === undefined ? {} : { id: opts.id }),
      usage: opts.usage ?? {},
      content: (opts.tools ?? []).map((t) => ({ type: "tool_use", ...t })),
    },
  });

// 1M input tokens = $3, 1M output = $15 => easy numbers.
const M = 1_000_000;

const leanA = [
  user("a", "[Cron job: x]\n\n/shipwright:dev-task-lean DTA-9.4"),
  assistant("a", {
    usage: { input_tokens: M, output_tokens: 0 },
    tools: [
      {
        name: "Read",
        input: { file_path: "/p/references/dev-task-lean/push-and-ci.md" },
      },
      { name: "Agent", input: { subagent_type: "implementer" } },
    ],
  }),
  assistant("a", {
    sidechain: true,
    usage: { output_tokens: M },
    tools: [
      {
        name: "Bash",
        input: { command: "cat references/dev-task-lean/pre-ship.md" },
      },
    ],
  }),
].join("\n");
const leanB = [
  user("b", "/shipwright:dev-task-lean DTA-1.1"),
  assistant("b", { costUSD: 1, usage: { input_tokens: M } }),
  assistant("b", { usage: { input_tokens: 0 } }),
].join("\n");
const full = [
  user("c", "/shipwright:dev-task DTA-2.2"),
  assistant("c", {
    usage: { cache_read_input_tokens: M },
    tools: [
      { name: "Agent", input: { subagent_type: "implementer" } },
      { name: "Agent", input: { subagent_type: "reviewer" } },
    ],
  }),
].join("\n");
const other = [
  user("d", "/shipwright:review 5"),
  assistant("d", { usage: { input_tokens: M } }),
].join("\n");
const subFile = assistant("a", {
  sidechain: true,
  usage: { cache_creation_input_tokens: M },
});

describe("parseTranscript", () => {
  test("counts a multi-block response once but scans every block's tools", () => {
    const t = parseTranscript(
      [
        user("d", "/shipwright:dev-task DTA-1"),
        assistant("d", { id: "m1", usage: { input_tokens: M } }),
        assistant("d", {
          id: "m1",
          usage: { input_tokens: M },
          tools: [{ name: "Agent", input: { subagent_type: "implementer" } }],
        }),
        assistant("d", { id: "m2", usage: { input_tokens: M } }),
      ].join("\n"),
    );
    expect(t.turns.main).toBe(2);
    expect(t.cost.main).toBeCloseTo(6);
    expect(t.dispatches.implementer).toBe(1);
  });

  test("extracts command, session, turns, refs, dispatches", () => {
    const t = parseTranscript(leanA);
    expect(t.sessionId).toBe("a");
    expect(t.name).toBe("dev-task-lean");
    expect(t.turns).toEqual({ main: 1, sub: 1 });
    expect([...t.refs].sort()).toEqual([
      "dev-task-lean/pre-ship.md",
      "dev-task-lean/push-and-ci.md",
    ]);
    expect(t.dispatches).toEqual({ implementer: 1 });
    expect(t.cost.main).toBeCloseTo(3);
    expect(t.cost.sub).toBeCloseTo(15);
  });

  test("tolerates blank and malformed lines; forcedSidechain", () => {
    const t = parseTranscript(`\nnot json\n${subFile}`, true);
    expect(t.name).toBeUndefined();
    expect(t.turns).toEqual({ main: 0, sub: 1 });
    expect(t.cost.sub).toBeCloseTo(3.75);
  });
});

describe("costOf", () => {
  test("prices usage and prefers numeric costUSD", () => {
    expect(
      costOf({
        input_tokens: M,
        output_tokens: M,
        cache_read_input_tokens: M,
        cache_creation_input_tokens: M,
      }),
    ).toBeCloseTo(3 + 15 + 0.3 + 3.75);
    expect(costOf({ input_tokens: M }, 0.5)).toBe(0.5);
  });
});

describe("median", () => {
  test("odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("tallyVariants", () => {
  const sessions = [
    parseTranscript(leanA),
    parseTranscript(leanB),
    parseTranscript(full),
    parseTranscript(other),
  ];
  const tally = tallyVariants(sessions, "dev-task");

  test("groups by variant and ignores other commands", () => {
    expect(tally.map((v) => v.variant).sort()).toEqual([
      "dev-task",
      "dev-task-lean",
    ]);
  });

  test("load rates dedupe by run", () => {
    const lean = tally.find((v) => v.variant === "dev-task-lean");
    expect(lean?.runs).toBe(2);
    const rates = Object.fromEntries(
      lean?.refs.map((r) => [r.ref, r.rate]) ?? [],
    );
    expect(rates).toEqual({
      "dev-task-lean/push-and-ci.md": 0.5,
      "dev-task-lean/pre-ship.md": 0.5,
    });
  });

  test("cost, turns and dispatch", () => {
    const lean = tally.find((v) => v.variant === "dev-task-lean");
    // run a: 3 main + 15 sub = 18; run b: 1 + 0 = 1
    expect(lean?.cost.total.mean).toBeCloseTo(9.5);
    expect(lean?.cost.main.mean).toBeCloseTo(2);
    expect(lean?.cost.sub.mean).toBeCloseTo(7.5);
    expect(lean?.turns.main.mean).toBe(1.5);
    expect(lean?.turns.sub.mean).toBe(0.5);
    expect(lean?.turns.total.median).toBe(2);
    expect(lean?.dispatch.meanPerRun).toBe(0.5);
    expect(lean?.dispatch.bySubagent).toEqual({ implementer: 0.5 });
    const d = tally.find((v) => v.variant === "dev-task");
    expect(d?.dispatch.meanPerRun).toBe(2);
    expect(d?.dispatch.bySubagent).toEqual({ implementer: 1, reviewer: 1 });
  });

  test("formatReport renders table", () => {
    const out = formatReport(tally);
    expect(out).toContain("dev-task-lean");
    expect(out).toContain("push-and-ci.md");
    expect(out).toContain("50%");
    expect(out).toContain("implementer");
  });
});

describe("parseArgs", () => {
  test("parses flags", () => {
    expect(
      parseArgs(["--command", "dev-task", "--dir", "a", "--dir", "b", "--json"]),
    ).toEqual({ command: "dev-task", dirs: ["a", "b"], json: true });
  });
  test("errors on missing command or unknown flag", () => {
    expect(() => parseArgs([])).toThrow(/--command/);
    expect(() => parseArgs(["--command", "x", "--bogus"])).toThrow(/bogus/);
    expect(() => parseArgs(["--command"])).toThrow(/--command/);
  });
});
