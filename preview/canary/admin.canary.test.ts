import { describe, expect, it } from "bun:test";
import { loadTargets } from "./client.ts";

const t = loadTargets();

describe("admin canary", () => {
  it("health returns 200", async () => {
    const res = await fetch(`${t.adminUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("readiness returns 200", async () => {
    const res = await fetch(`${t.adminUrl}/health/ready`);
    expect(res.status).toBe(200);
  });
});
