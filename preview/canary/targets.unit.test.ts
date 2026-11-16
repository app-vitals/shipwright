import { describe, expect, it } from "bun:test";
import { readTargets } from "./targets.ts";

const VALID: Record<string, string> = {
  PREVIEW_ADMIN_URL: "http://127.0.0.1:13001",
  PREVIEW_METRICS_URL: "http://127.0.0.1:13460",
  PREVIEW_TASK_STORE_URL: "http://localhost:13002",
  PREVIEW_CHAT_URL: "http://127.0.0.1:13003",
  PREVIEW_MCP_URL: "http://127.0.0.1:13004",
  PREVIEW_TASK_STORE_TOKEN: "ts-token",
  PREVIEW_MCP_TOKEN: "mcp-token",
};

describe("readTargets", () => {
  it("returns all seven fields when set", () => {
    expect(readTargets(VALID)).toEqual({
      adminUrl: "http://127.0.0.1:13001",
      metricsUrl: "http://127.0.0.1:13460",
      taskStoreUrl: "http://localhost:13002",
      chatUrl: "http://127.0.0.1:13003",
      mcpUrl: "http://127.0.0.1:13004",
      taskStoreToken: "ts-token",
      mcpToken: "mcp-token",
    });
  });

  it("strips a trailing slash from URLs", () => {
    const t = readTargets({
      ...VALID,
      PREVIEW_ADMIN_URL: "http://127.0.0.1:13001/",
    });
    expect(t.adminUrl).toBe("http://127.0.0.1:13001");
  });

  it("names every missing variable in one error", () => {
    const { PREVIEW_CHAT_URL, PREVIEW_MCP_TOKEN, ...rest } = VALID;
    let message = "";
    try {
      readTargets(rest);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("PREVIEW_CHAT_URL");
    expect(message).toContain("PREVIEW_MCP_TOKEN");
    expect(message).not.toContain("PREVIEW_ADMIN_URL");
  });

  it("treats empty values as missing", () => {
    expect(() => readTargets({ ...VALID, PREVIEW_ADMIN_URL: "" })).toThrow(
      "PREVIEW_ADMIN_URL",
    );
  });

  it("names all seven variables for an empty environment", () => {
    let message = "";
    try {
      readTargets({});
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of Object.keys(VALID)) expect(message).toContain(name);
  });

  it("refuses a non-local URL", () => {
    expect(() =>
      readTargets({ ...VALID, PREVIEW_ADMIN_URL: "https://admin.example.com" }),
    ).toThrow("PREVIEW_ADMIN_URL");
  });

  it("refuses a host that merely starts with a local name", () => {
    expect(() =>
      readTargets({
        ...VALID,
        PREVIEW_MCP_URL: "http://localhost.evil.example",
      }),
    ).toThrow("PREVIEW_MCP_URL");
  });

  it("refuses https even for a local host", () => {
    expect(() =>
      readTargets({ ...VALID, PREVIEW_CHAT_URL: "https://127.0.0.1:13003" }),
    ).toThrow("PREVIEW_CHAT_URL");
  });

  it("refuses an unparseable URL", () => {
    expect(() =>
      readTargets({ ...VALID, PREVIEW_METRICS_URL: "not a url" }),
    ).toThrow("PREVIEW_METRICS_URL");
  });

  it("names every non-local URL in one error", () => {
    let message = "";
    try {
      readTargets({
        ...VALID,
        PREVIEW_ADMIN_URL: "http://10.0.0.5:3001",
        PREVIEW_CHAT_URL: "http://chat.example.com",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("PREVIEW_ADMIN_URL");
    expect(message).toContain("PREVIEW_CHAT_URL");
  });

  it("allows a remote URL when PREVIEW_ALLOW_REMOTE is exactly true", () => {
    const t = readTargets({
      ...VALID,
      PREVIEW_ADMIN_URL: "https://admin.example.com",
      PREVIEW_ALLOW_REMOTE: "true",
    });
    expect(t.adminUrl).toBe("https://admin.example.com");
  });

  it("does not treat other PREVIEW_ALLOW_REMOTE values as consent", () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(() =>
        readTargets({
          ...VALID,
          PREVIEW_ADMIN_URL: "https://admin.example.com",
          PREVIEW_ALLOW_REMOTE: value,
        }),
      ).toThrow("PREVIEW_ADMIN_URL");
    }
  });
});
