import { describe, it, expect } from "bun:test";
import { name } from "./index.ts";

describe("mcp-server module", () => {
  it("should export a name constant", () => {
    expect(name).toBe("@shipwright/mcp-server");
  });
});
