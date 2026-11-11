/**
 * plugins/shipwright/scripts/prompt-audit/adherence.unit.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  commandOfFile,
  fetchCommandAdherence,
  parseDevTaskAdherence,
  rankAdherence,
} from "./adherence.ts";

describe("commandOfFile", () => {
  test("maps command and skill files, ignores others", () => {
    expect(commandOfFile("plugins/shipwright/commands/dev-task.md")).toBe(
      "dev-task",
    );
    expect(commandOfFile("plugins/shipwright/skills/patch/SKILL.md")).toBe(
      "patch",
    );
    expect(commandOfFile("docs/dev-task.md")).toBeNull();
  });
});

describe("parseDevTaskAdherence", () => {
  test("rate is adherentRuns / runs", () => {
    expect(
      parseDevTaskAdherence({ overall: { runs: 4, adherentRuns: 3 } }),
    ).toEqual([{ command: "dev-task", runs: 4, adherentRuns: 3, rate: 0.75 }]);
  });
  test("zero runs yields no rows; malformed yields null", () => {
    expect(
      parseDevTaskAdherence({ overall: { runs: 0, adherentRuns: 0 } }),
    ).toEqual([]);
    expect(parseDevTaskAdherence({})).toBeNull();
    expect(parseDevTaskAdherence(null)).toBeNull();
  });
});

describe("rankAdherence", () => {
  test("lowest rate first, ties by name", () => {
    const row = (command: string, rate: number) => ({
      command,
      runs: 10,
      adherentRuns: rate * 10,
      rate,
    });
    expect(
      rankAdherence([row("b", 0.9), row("c", 0.2), row("a", 0.2)]).map(
        (r) => r.command,
      ),
    ).toEqual(["a", "c", "b"]);
  });
});

describe("fetchCommandAdherence", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SHIPWRIGHT_API_URL = "https://admin.test/";
    process.env.SHIPWRIGHT_AGENT_API_KEY = "k";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test("hits the adherence endpoint with bearer auth and from param", async () => {
    let seen: { url: string; auth: string } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        auth: (init.headers as Record<string, string>).Authorization,
      };
      return Response.json({ overall: { runs: 2, adherentRuns: 1 } });
    }) as unknown as typeof fetch;
    const out = await fetchCommandAdherence({ fetchFn, from: "2026-10-01" });
    expect(out?.[0].rate).toBe(0.5);
    expect(seen?.url).toBe(
      "https://admin.test/agents/all/cron-runs/dev-task-adherence?from=2026-10-01",
    );
    expect(seen?.auth).toBe("Bearer k");
  });

  test("null when env missing, non-2xx, or fetch throws", async () => {
    const bad = (async () =>
      new Response("no", { status: 404 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchCommandAdherence({ fetchFn: bad })).toBeNull();
    expect(await fetchCommandAdherence({ fetchFn: boom })).toBeNull();
    delete process.env.SHIPWRIGHT_API_URL;
    expect(await fetchCommandAdherence({ fetchFn: bad })).toBeNull();
  });
});
