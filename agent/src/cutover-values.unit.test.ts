/**
 * agent/src/cutover-values.unit.test.ts
 * Unit tests for YAML generation logic — no I/O, pure function.
 */

import { describe, it, expect } from "bun:test";
import { generateCutoverValues } from "./cutover-values.ts";

describe("generateCutoverValues", () => {
  const AGENT_ID = "agent-abc-123";
  const IMAGE_TAG = "sha-deadbeef";
  const API_URL = "https://shipwright.example.com";

  it("includes the correct image tag", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain(`tag: "${IMAGE_TAG}"`);
    expect(yaml).toContain("ghcr.io/app-vitals/shipwright-agent");
  });

  it("includes SHIPWRIGHT_AGENT_ID set to the given agent ID", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain(`SHIPWRIGHT_AGENT_ID: "${AGENT_ID}"`);
  });

  it("includes SHIPWRIGHT_API_URL set to the given URL", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain(`SHIPWRIGHT_API_URL: "${API_URL}"`);
  });

  it("includes SHIPWRIGHT_INTERNAL_API_KEY placeholder", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain("SHIPWRIGHT_INTERNAL_API_KEY:");
  });

  it("lists the three env vars to remove", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain("VITALS_OS_API_URL");
    expect(yaml).toContain("VITALS_INTERNAL_API_KEY");
    expect(yaml).toContain("VITALS_OS_AGENT_USER_ID");
  });

  it("produces YAML that contains no parse-breaking syntax", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    // Basic structural checks: has at minimum the top-level agent: key
    expect(yaml).toContain("agent:");
    // Every line is either blank, a comment, or starts with indentation/key chars
    const lines = yaml.split("\n");
    for (const line of lines) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      // Should not contain tab characters (YAML indentation must be spaces)
      expect(line).not.toContain("\t");
    }
  });

  it("embeds the agent ID in the header comment", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG, API_URL);
    expect(yaml).toContain(AGENT_ID);
  });
});
