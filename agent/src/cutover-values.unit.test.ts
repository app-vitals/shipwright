/**
 * agent/src/cutover-values.unit.test.ts
 * Unit tests for the cutover-values YAML generation function.
 */

import { describe, expect, it } from "bun:test";
import { generateCutoverValues } from "./cutover-values.ts";

describe("generateCutoverValues", () => {
  const AGENT_ID = "agent-abc123";
  const IMAGE_TAG = "v1.2.3";

  it("includes the image tag", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("v1.2.3");
  });

  it("sets image.tag in YAML", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("tag:");
    expect(yaml).toMatch(/tag:\s*["']?v1\.2\.3["']?/);
  });

  it("adds SHIPWRIGHT_API_URL to env", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("SHIPWRIGHT_API_URL");
  });

  it("adds SHIPWRIGHT_AGENT_API_KEY to env", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("SHIPWRIGHT_AGENT_API_KEY");
  });

  it("adds SHIPWRIGHT_AGENT_ID with the given agent ID", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("SHIPWRIGHT_AGENT_ID");
    expect(yaml).toContain(AGENT_ID);
  });

  it("removes VITALS_OS_API_URL", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("VITALS_OS_API_URL");
  });

  it("removes VITALS_INTERNAL_API_KEY", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("VITALS_INTERNAL_API_KEY");
  });

  it("removes VITALS_OS_AGENT_USER_ID", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("VITALS_OS_AGENT_USER_ID");
  });

  it("produces valid YAML structure with add and remove sections", () => {
    const yaml = generateCutoverValues(AGENT_ID, IMAGE_TAG);
    expect(yaml).toContain("add:");
    expect(yaml).toContain("remove:");
  });

  it("works with any agent ID", () => {
    const yaml = generateCutoverValues("different-agent-xyz", "v2.0.0");
    expect(yaml).toContain("different-agent-xyz");
    expect(yaml).toContain("v2.0.0");
  });

  it("throws when agentId contains a double quote", () => {
    expect(() => generateCutoverValues('agent"inject', IMAGE_TAG)).toThrow(
      /Invalid agentId/,
    );
  });

  it("throws when imageTag contains a double quote", () => {
    expect(() => generateCutoverValues(AGENT_ID, 'v1.0"inject')).toThrow(
      /Invalid imageTag/,
    );
  });

  it("throws when agentId contains a backslash", () => {
    expect(() => generateCutoverValues("agent\\bad", IMAGE_TAG)).toThrow(
      /Invalid agentId/,
    );
  });

  it("throws when imageTag is empty", () => {
    expect(() => generateCutoverValues(AGENT_ID, "")).toThrow(
      /Invalid imageTag/,
    );
  });
});
