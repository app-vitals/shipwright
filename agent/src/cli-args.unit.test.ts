/**
 * agent/src/cli-args.unit.test.ts
 *
 * Unit tests for CLI argument parsing.
 * Pure logic — no I/O, no env side effects.
 */

import { describe, expect, it } from "bun:test";
import { parseCliArgs } from "./cli-args.ts";

describe("parseCliArgs — explicit flags", () => {
  it("parses --agent-id", () => {
    const result = parseCliArgs(["--agent-id", "agent-123"], {});
    expect(result.agentId).toBe("agent-123");
  });

  it("parses --api-url", () => {
    const result = parseCliArgs(["--api-url", "https://api.example.com"], {});
    expect(result.apiUrl).toBe("https://api.example.com");
  });

  it("parses --api-key", () => {
    const result = parseCliArgs(["--api-key", "secret-key"], {});
    expect(result.apiKey).toBe("secret-key");
  });

  it("parses all three flags together", () => {
    const result = parseCliArgs(
      [
        "--agent-id",
        "agent-abc",
        "--api-url",
        "https://api.test.com",
        "--api-key",
        "key-xyz",
      ],
      {},
    );
    expect(result.agentId).toBe("agent-abc");
    expect(result.apiUrl).toBe("https://api.test.com");
    expect(result.apiKey).toBe("key-xyz");
  });

  it("ignores unknown flags", () => {
    const result = parseCliArgs(["--unknown", "value", "--agent-id", "x"], {});
    expect(result.agentId).toBe("x");
  });
});

describe("parseCliArgs — env var fallback", () => {
  it("falls back to SHIPWRIGHT_AGENT_ID when --agent-id not provided", () => {
    const result = parseCliArgs([], {
      SHIPWRIGHT_AGENT_ID: "env-agent-id",
    });
    expect(result.agentId).toBe("env-agent-id");
  });

  it("falls back to SHIPWRIGHT_API_URL when --api-url not provided", () => {
    const result = parseCliArgs([], {
      SHIPWRIGHT_API_URL: "https://env.api.com",
    });
    expect(result.apiUrl).toBe("https://env.api.com");
  });

  it("falls back to SHIPWRIGHT_INTERNAL_API_KEY when --api-key not provided", () => {
    const result = parseCliArgs([], {
      SHIPWRIGHT_INTERNAL_API_KEY: "env-key",
    });
    expect(result.apiKey).toBe("env-key");
  });

  it("CLI flags take precedence over env vars", () => {
    const result = parseCliArgs(["--agent-id", "cli-agent"], {
      SHIPWRIGHT_AGENT_ID: "env-agent",
    });
    expect(result.agentId).toBe("cli-agent");
  });

  it("returns undefined when neither flag nor env var is set", () => {
    const result = parseCliArgs([], {});
    expect(result.agentId).toBeUndefined();
    expect(result.apiUrl).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
  });
});
