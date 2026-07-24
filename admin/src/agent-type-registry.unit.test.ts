/**
 * admin/src/agent-type-registry.unit.test.ts
 * Unit tests for the pure Agent Type manifest schema + parser. No I/O, no
 * network, no fs — parseAgentTypeManifest takes a YAML string in memory and
 * returns/throws in-process.
 */

import { describe, expect, it } from "bun:test";
import {
  AgentTypeManifestSchema,
  parseAgentTypeManifest,
} from "./agent-type-registry.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const validManifestYaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: A laid-back team member agent.
  version: 1.0.0
  skills:
    - id: chill
      name: Stay Chill
      description: Keeps things mellow.
      tags: [vibe]
identity:
  templatesDir: templates/dude
crons:
  - name: morning-brief
    schedule: "0 9 * * 1-5"
    prompt: Run the morning brief.
plugins:
  - "@shipwright/plugin"
tools:
  - Read
  - Write
env:
  required:
    - key: SHIPWRIGHT_API_URL
      description: Base URL of the admin API.
      secret: false
  optional:
    - key: GROQ_API_KEY
      description: Optional Groq API key for voice.
      secret: true
members:
  - alice
repos:
  - my-org/my-repo
chat: true
voice: false
`;

function parseYamlFixture(yaml: string) {
  return parseAgentTypeManifest(yaml);
}

// ─── Valid manifest ─────────────────────────────────────────────────────────

describe("parseAgentTypeManifest — valid manifest", () => {
  it("parses a valid minimal manifest successfully", () => {
    const manifest = parseYamlFixture(validManifestYaml);
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("AgentType");
    expect(manifest.metadata.name).toBe("dude-agent");
    expect(manifest.identity.templatesDir).toBe("templates/dude");
    expect(manifest.crons).toHaveLength(1);
    expect(manifest.chat).toBe(true);
    expect(manifest.voice).toBe(false);
  });

  it("accepts a cron whose parentCron resolves to a sibling cron name", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: A laid-back team member agent.
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons:
  - name: parent-cron
    schedule: "0 9 * * 1-5"
    prompt: Parent prompt.
  - name: child-cron
    schedule: "0 10 * * 1-5"
    prompt: Child prompt.
    parentCron: parent-cron
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: false
`;
    const manifest = parseYamlFixture(yaml);
    expect(manifest.crons[1].parentCron).toBe("parent-cron");
  });
});

// ─── Acceptance criterion 1 — failure cases ────────────────────────────────

describe("parseAgentTypeManifest — invalid manifests fail with field-path errors", () => {
  it("rejects a cron missing its required schedule field", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: desc
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons:
  - name: bad-cron
    prompt: Missing schedule.
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: false
`;
    expect(() => parseYamlFixture(yaml)).toThrow();
    try {
      parseYamlFixture(yaml);
      throw new Error("expected parseAgentTypeManifest to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("crons");
      expect(message).toContain("schedule");
    }
  });

  it("rejects an unknown top-level field", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: desc
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons: []
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: false
unknownField: surprise
`;
    expect(() => parseYamlFixture(yaml)).toThrow();
    try {
      parseYamlFixture(yaml);
      throw new Error("expected parseAgentTypeManifest to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("unknownField");
    }
  });

  it("rejects an env entry carrying a value key (trust boundary)", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: desc
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons: []
plugins: []
tools: []
env:
  required:
    - key: SOME_KEY
      description: has a value, which is forbidden
      secret: false
      value: "should not be allowed"
  optional: []
members: []
repos: []
chat: true
voice: false
`;
    expect(() => parseYamlFixture(yaml)).toThrow();
    try {
      parseYamlFixture(yaml);
      throw new Error("expected parseAgentTypeManifest to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("env");
      expect(message).toContain("value");
    }
  });

  it("rejects a dangling parentCron reference", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: dude-agent
  displayName: The Dude
  description: desc
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons:
  - name: only-cron
    schedule: "0 9 * * 1-5"
    prompt: Prompt.
    parentCron: does-not-exist
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: false
`;
    expect(() => parseYamlFixture(yaml)).toThrow();
    try {
      parseYamlFixture(yaml);
      throw new Error("expected parseAgentTypeManifest to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("parentCron");
    }
  });

  it("rejects a non-RFC1123 metadata.name", () => {
    const yaml = `
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: Dude_Agent!
  displayName: The Dude
  description: desc
  version: 1.0.0
  skills: []
identity:
  templatesDir: templates/dude
crons: []
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: false
`;
    expect(() => parseYamlFixture(yaml)).toThrow();
    try {
      parseYamlFixture(yaml);
      throw new Error("expected parseAgentTypeManifest to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("metadata");
      expect(message).toContain("name");
    }
  });
});

// ─── Schema-level checks (direct safeParse, matching repo convention) ──────

describe("AgentTypeManifestSchema.safeParse", () => {
  it("rejects a self-referencing parentCron", () => {
    const result = AgentTypeManifestSchema.safeParse({
      apiVersion: "shipwright.dev/v1alpha1",
      kind: "AgentType",
      metadata: {
        name: "dude-agent",
        displayName: "The Dude",
        description: "desc",
        version: "1.0.0",
        skills: [],
      },
      identity: { templatesDir: "templates/dude" },
      crons: [
        {
          name: "self-cron",
          schedule: "0 9 * * 1-5",
          prompt: "Prompt.",
          parentCron: "self-cron",
        },
      ],
      plugins: [],
      tools: [],
      env: { required: [], optional: [] },
      members: [],
      repos: [],
      chat: true,
      voice: false,
    });
    expect(result.success).toBe(false);
  });

  it("defaults silent/enabled on a cron entry when omitted", () => {
    const result = AgentTypeManifestSchema.safeParse({
      apiVersion: "shipwright.dev/v1alpha1",
      kind: "AgentType",
      metadata: {
        name: "dude-agent",
        displayName: "The Dude",
        description: "desc",
        version: "1.0.0",
        skills: [],
      },
      identity: { templatesDir: "templates/dude" },
      crons: [
        {
          name: "morning-brief",
          schedule: "0 9 * * 1-5",
          prompt: "Prompt.",
        },
      ],
      plugins: [],
      tools: [],
      env: { required: [], optional: [] },
      members: [],
      repos: [],
      chat: true,
      voice: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.crons[0].silent).toBe(false);
      expect(result.data.crons[0].enabled).toBe(true);
    }
  });

  it("rejects a bad apiVersion literal", () => {
    const result = AgentTypeManifestSchema.safeParse({
      apiVersion: "shipwright.dev/v1",
      kind: "AgentType",
      metadata: {
        name: "dude-agent",
        displayName: "The Dude",
        description: "desc",
        version: "1.0.0",
        skills: [],
      },
      identity: { templatesDir: "templates/dude" },
      crons: [],
      plugins: [],
      tools: [],
      env: { required: [], optional: [] },
      members: [],
      repos: [],
      chat: true,
      voice: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a repos entry not in org/repo format", () => {
    const result = AgentTypeManifestSchema.safeParse({
      apiVersion: "shipwright.dev/v1alpha1",
      kind: "AgentType",
      metadata: {
        name: "dude-agent",
        displayName: "The Dude",
        description: "desc",
        version: "1.0.0",
        skills: [],
      },
      identity: { templatesDir: "templates/dude" },
      crons: [],
      plugins: [],
      tools: [],
      env: { required: [], optional: [] },
      members: [],
      repos: ["not-a-valid-repo"],
      chat: true,
      voice: false,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional resources override", () => {
    const result = AgentTypeManifestSchema.safeParse({
      apiVersion: "shipwright.dev/v1alpha1",
      kind: "AgentType",
      metadata: {
        name: "dude-agent",
        displayName: "The Dude",
        description: "desc",
        version: "1.0.0",
        skills: [],
      },
      identity: { templatesDir: "templates/dude" },
      crons: [],
      plugins: [],
      tools: [],
      env: { required: [], optional: [] },
      members: [],
      repos: [],
      chat: true,
      voice: false,
      resources: {
        requests: { cpu: "500m", memory: "2Gi", "ephemeral-storage": "1Gi" },
        limits: { memory: "8Gi", "ephemeral-storage": "1Gi" },
      },
    });
    expect(result.success).toBe(true);
  });
});
