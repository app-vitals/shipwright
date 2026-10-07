import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_ENV } from "./default-agent-env.ts";
import { SECRET_ENV_VARS } from "./secret-env-vars.ts";

describe("DEFAULT_AGENT_ENV", () => {
  it("never defaults a secret-shaped env var", () => {
    for (const key of Object.keys(DEFAULT_AGENT_ENV)) {
      expect(SECRET_ENV_VARS as readonly string[]).not.toContain(key);
    }
  });

  it("defaults ANTHROPIC_MODEL to a non-empty value", () => {
    expect(DEFAULT_AGENT_ENV.ANTHROPIC_MODEL).toMatch(/^claude-/);
  });
});
