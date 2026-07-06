import { describe, it, expect } from "bun:test";
import { app } from "./index.js";

describe("mcp-server", () => {
  it("exports an app", () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe("object");
  });

  it("responds to a health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
