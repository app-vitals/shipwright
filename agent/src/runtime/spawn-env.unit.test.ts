import { describe, expect, test } from "bun:test";
import { buildSpawnEnv, defaultOwnerOf } from "./spawn-env.ts";

function collector() {
  const lines: string[] = [];
  return { lines, warn: (m: string) => lines.push(m) };
}

describe("buildSpawnEnv", () => {
  test("loop-dispatched item carries its owner and preserves extraEnv", () => {
    const c = collector();
    const env = buildSpawnEnv({
      kind: "loop",
      id: "GOR-1.3",
      owner: "acme",
      extraEnv: { SLACK_CHANNEL_ID: "C1" },
      warn: c.warn,
    });
    expect(env).toEqual({
      SLACK_CHANNEL_ID: "C1",
      SHIPWRIGHT_GH_OWNER: "acme",
    });
    expect(c.lines).toEqual([]);
  });

  test("cron without a repo carries the default org", () => {
    const c = collector();
    expect(
      buildSpawnEnv({
        kind: "cron",
        id: "nightly",
        owner: "default-org",
        warn: c.warn,
      }),
    ).toEqual({ SHIPWRIGHT_GH_OWNER: "default-org" });
    expect(c.lines).toEqual([]);
  });

  test("DM spawn carries no hint and logs nothing, even if an owner is passed", () => {
    const c = collector();
    expect(buildSpawnEnv({ kind: "dm", warn: c.warn })).toBeUndefined();
    expect(
      buildSpawnEnv({
        kind: "dm",
        owner: "acme",
        extraEnv: { A: "b" },
        warn: c.warn,
      }),
    ).toEqual({ A: "b" });
    expect(c.lines).toEqual([]);
  });

  test("loop or cron spawn with no owner warns exactly once, naming kind and id", () => {
    const c = collector();
    const env = buildSpawnEnv({
      kind: "loop",
      id: "GOR-9.9",
      extraEnv: { SLACK_CHANNEL_ID: "C1" },
      warn: c.warn,
    });
    expect(env).toEqual({ SLACK_CHANNEL_ID: "C1" });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain("loop");
    expect(c.lines[0]).toContain("GOR-9.9");

    buildSpawnEnv({ kind: "cron", id: "nightly", owner: null, warn: c.warn });
    expect(c.lines).toHaveLength(2);
    expect(c.lines[1]).toContain("cron");
    expect(c.lines[1]).toContain("nightly");
  });
});

describe("defaultOwnerOf", () => {
  const inst = (id: number, owner: string | null) => ({
    id,
    owner,
    pinned: false,
    health: "ok" as const,
    reason: null,
  });
  test("returns the default installation's owner", () => {
    expect(
      defaultOwnerOf({
        installations: [inst(1, "a"), inst(2, "b")],
        defaultId: 2,
      }),
    ).toBe("b");
  });
  test("null when there is no default or no snapshot", () => {
    expect(defaultOwnerOf({ installations: [], defaultId: null })).toBeNull();
    expect(defaultOwnerOf(null)).toBeNull();
    expect(
      defaultOwnerOf({ installations: [inst(1, null)], defaultId: 1 }),
    ).toBeNull();
  });
});
