/**
 * plugins/shipwright/scripts/prompt-audit/usage-attribution.unit.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attributeTranscripts,
  fetchCronSkillStats,
  readLocalSkillStats,
  type TranscriptFs,
} from "./usage-attribution.ts";

const usage = (input: number, creation = 0, output = 1, read = 0) => ({
  input_tokens: input,
  cache_creation_input_tokens: creation,
  output_tokens: output,
  cache_read_input_tokens: read,
});

const asst = (
  id: string,
  u: ReturnType<typeof usage>,
  content: unknown[] = [],
  parent?: string,
) =>
  JSON.stringify({
    type: "assistant",
    ...(parent && { parent_tool_use_id: parent }),
    message: { id, usage: u, content },
  });

const skill = (id: string, name: string) => ({
  type: "tool_use",
  id,
  name: "Skill",
  input: { skill: name },
});

// Shared fixture: root turn, skill invoke, loaded turn, subagent turn, switch.
const FIXTURE = [
  asst("m1", usage(100, 50), [skill("t1", "shipwright:a")]),
  asst("m2", usage(10, 900), []),
  asst("m2", usage(10, 900), []), // repeated message id: not double counted
  asst("m3", usage(5, 5), [
    {
      type: "tool_use",
      id: "t2",
      name: "Agent",
      input: { subagent_type: "x" },
    },
  ]),
  asst("m4", usage(7, 3), [], "t2"),
  asst("m5", usage(1, 1), [skill("t3", "shipwright:b")]),
  asst("m6", usage(2, 2)),
  "not json",
].join("\n");

const by = (rows: ReturnType<typeof attributeTranscripts>, key: string) =>
  rows.find((r) => `${r.kind}:${r.name}` === key);

describe("attributeTranscripts", () => {
  test("last-wins attribution with root, skill and agent buckets", () => {
    const rows = attributeTranscripts([FIXTURE]);
    // m1 invokes a skill, so its own turn is charged to that skill (as in
    // run-telemetry.ts) and the root bucket never fills.
    expect(by(rows, "root:root")).toBeUndefined();
    expect(by(rows, "skill:shipwright:a")).toMatchObject({
      invocations: 1,
      turns: 3, // m1 + m2 + m3 (m2 repeated id not double counted)
      runs: 1,
      avgInvokeContextDelta: 150,
    });
    expect(by(rows, "skill:shipwright:b")).toMatchObject({
      invocations: 1,
      turns: 2,
      avgInvokeContextDelta: 2,
    });
    expect(by(rows, "agent:x")).toMatchObject({
      invocations: 1,
      turns: 1,
      input: 7,
    });
  });

  test("aggregates runs and average delta across sessions", () => {
    const s2 = [
      asst("a", usage(1, 999), [skill("t1", "shipwright:a")]),
      asst("b", usage(0, 1090)),
    ].join("\n");
    const row = by(attributeTranscripts([FIXTURE, s2]), "skill:shipwright:a");
    expect(row).toMatchObject({ runs: 2, invocations: 2 });
    expect(row?.avgInvokeContextDelta).toBe(575);
  });

  test("empty input yields no rows", () => {
    expect(attributeTranscripts([""])).toEqual([]);
  });
});

describe("readLocalSkillStats", () => {
  test("reads transcripts through the injected fs, skipping unreadable files", () => {
    const fs: TranscriptFs = {
      listTranscripts: () => ["/p/a.jsonl", "/p/bad.jsonl"],
      readFile: (p) => {
        if (p.endsWith("bad.jsonl")) throw new Error("EACCES");
        return FIXTURE;
      },
    };
    const rows = readLocalSkillStats({ root: "/p", fs });
    expect(rows).toEqual(attributeTranscripts([FIXTURE]));
  });

  test("returns null when the projects root is unreadable", () => {
    const fs: TranscriptFs = {
      listTranscripts: () => {
        throw new Error("ENOENT");
      },
      readFile: () => "",
    };
    expect(readLocalSkillStats({ fs })).toBeNull();
  });
});

describe("fetchCronSkillStats", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SHIPWRIGHT_API_URL = "https://admin.test/";
    process.env.SHIPWRIGHT_AGENT_API_KEY = "k";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const row = {
    kind: "skill",
    name: "shipwright:dev-task",
    runs: 4,
    invocations: 5,
    turns: 40,
    input: 600,
    output: 300,
    cacheRead: 60,
    cacheCreation: 30,
    avgInvokeContextDelta: 1200,
  };

  test("returns bySkill rows from a reachable admin", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ bySkill: [row] }) };
    }) as unknown as typeof fetch;
    const out = await fetchCronSkillStats({ fetchFn, from: "2026-01-01" });
    expect(out).toEqual([row]);
    expect(calls[0]?.[0]).toBe(
      "https://admin.test/agents/all/cron-runs/stats?from=2026-01-01",
    );
    expect(calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer k" });
  });

  test("returns null without throwing when unreachable", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchCronSkillStats({ fetchFn })).toBeNull();
  });

  test("returns null on non-2xx, missing bySkill, or missing env", async () => {
    const mk = (r: unknown) => (async () => r) as unknown as typeof fetch;
    expect(
      await fetchCronSkillStats({ fetchFn: mk({ ok: false, status: 403 }) }),
    ).toBeNull();
    expect(
      await fetchCronSkillStats({
        fetchFn: mk({ ok: true, json: async () => ({}) }),
      }),
    ).toBeNull();
    delete process.env.SHIPWRIGHT_API_URL;
    expect(await fetchCronSkillStats({ fetchFn: mk({ ok: true }) })).toBeNull();
  });
});
