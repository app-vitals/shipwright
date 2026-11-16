import { describe, expect, it } from "bun:test";
import { loadTargets } from "./client.ts";

const t = loadTargets();

describe("chat canary", () => {
  it("health returns 200", async () => {
    const res = await fetch(`${t.chatUrl}/health`);
    expect(res.status).toBe(200);
  });
});
