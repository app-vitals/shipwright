/**
 * admin/src/agent-type-registry.unit.test.ts
 * Unit tests for the pure Agent Type manifest schema + parser. No I/O, no
 * network, no fs — parseAgentTypeManifest takes a YAML string in memory and
 * returns/throws in-process.
 */

import { describe, expect, it } from "bun:test";
import { stringify as stringifyYaml } from "yaml";
import {
  AgentTypeManifestSchema,
  parseAgentTypeManifest,
} from "./agent-type-registry.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A minimal valid manifest object. Pass overrides for the fields a test cares about. */
function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "shipwright.dev/v1alpha1",
    kind: "AgentType",
    metadata: {
      name: "dude-agent",
      displayName: "The Dude",
      description: "A laid-back team member agent.",
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
    ...overrides,
  };
}

/** Round-trips a manifest object through YAML so tests exercise the real parse path. */
function parseManifestYaml(manifest: Record<string, unknown>) {
  return parseAgentTypeManifest(stringifyYaml(manifest));
}

function expectThrowsWithMessage(manifest: Record<string, unknown>, ...fragments: string[]) {
  expect(() => parseManifestYaml(manifest)).toThrow();
  try {
    parseManifestYaml(manifest);
    throw new Error("expected parseAgentTypeManifest to throw");
  } catch (err) {
    const message = (err as Error).message;
    for (const fragment of fragments) {
      expect(message).toContain(fragment);
    }
  }
}

// ─── Valid manifest ─────────────────────────────────────────────────────────

describe("parseAgentTypeManifest — valid manifest", () => {
  it("parses a valid minimal manifest successfully", () => {
    const manifest = parseManifestYaml(
      baseManifest({
        metadata: {
          name: "dude-agent",
          displayName: "The Dude",
          description: "A laid-back team member agent.",
          version: "1.0.0",
          skills: [
            {
              id: "chill",
              name: "Stay Chill",
              description: "Keeps things mellow.",
              tags: ["vibe"],
            },
          ],
        },
        crons: [
          {
            name: "morning-brief",
            schedule: "0 9 * * 1-5",
            prompt: "Run the morning brief.",
          },
        ],
        plugins: ["@shipwright/plugin"],
        tools: ["Read", "Write"],
        env: {
          required: [
            {
              key: "SHIPWRIGHT_API_URL",
              description: "Base URL of the admin API.",
              secret: false,
            },
          ],
          optional: [
            {
              key: "GROQ_API_KEY",
              description: "Optional Groq API key for voice.",
              secret: true,
            },
          ],
        },
        members: ["alice"],
        repos: ["my-org/my-repo"],
      }),
    );
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("AgentType");
    expect(manifest.metadata.name).toBe("dude-agent");
    expect(manifest.identity.templatesDir).toBe("templates/dude");
    expect(manifest.crons).toHaveLength(1);
    expect(manifest.chat).toBe(true);
    expect(manifest.voice).toBe(false);
  });

  it("accepts a cron whose parentCron resolves to a sibling cron name", () => {
    const manifest = parseManifestYaml(
      baseManifest({
        crons: [
          {
            name: "parent-cron",
            schedule: "0 9 * * 1-5",
            prompt: "Parent prompt.",
          },
          {
            name: "child-cron",
            schedule: "0 10 * * 1-5",
            prompt: "Child prompt.",
            parentCron: "parent-cron",
          },
        ],
      }),
    );
    expect(manifest.crons[1].parentCron).toBe("parent-cron");
  });
});

// ─── Acceptance criterion 1 — failure cases ────────────────────────────────

describe("parseAgentTypeManifest — invalid manifests fail with field-path errors", () => {
  it("rejects a cron missing its required schedule field", () => {
    expectThrowsWithMessage(
      baseManifest({
        crons: [{ name: "bad-cron", prompt: "Missing schedule." }],
      }),
      "crons",
      "schedule",
    );
  });

  it("rejects an unknown top-level field", () => {
    expectThrowsWithMessage(
      baseManifest({ unknownField: "surprise" }),
      "unknownField",
    );
  });

  it("rejects an env entry carrying a value key (trust boundary)", () => {
    expectThrowsWithMessage(
      baseManifest({
        env: {
          required: [
            {
              key: "SOME_KEY",
              description: "has a value, which is forbidden",
              secret: false,
              value: "should not be allowed",
            },
          ],
          optional: [],
        },
      }),
      "env",
      "value",
    );
  });

  it("rejects a dangling parentCron reference", () => {
    expectThrowsWithMessage(
      baseManifest({
        crons: [
          {
            name: "only-cron",
            schedule: "0 9 * * 1-5",
            prompt: "Prompt.",
            parentCron: "does-not-exist",
          },
        ],
      }),
      "parentCron",
    );
  });

  it("rejects a non-RFC1123 metadata.name", () => {
    expectThrowsWithMessage(
      baseManifest({
        metadata: {
          name: "Dude_Agent!",
          displayName: "The Dude",
          description: "desc",
          version: "1.0.0",
          skills: [],
        },
      }),
      "metadata",
      "name",
    );
  });
});

// ─── Schema-level checks (direct safeParse, matching repo convention) ──────

describe("AgentTypeManifestSchema.safeParse", () => {
  it("rejects a self-referencing parentCron", () => {
    const result = AgentTypeManifestSchema.safeParse(
      baseManifest({
        crons: [
          {
            name: "self-cron",
            schedule: "0 9 * * 1-5",
            prompt: "Prompt.",
            parentCron: "self-cron",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("defaults silent/enabled on a cron entry when omitted", () => {
    const result = AgentTypeManifestSchema.safeParse(
      baseManifest({
        crons: [
          { name: "morning-brief", schedule: "0 9 * * 1-5", prompt: "Prompt." },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.crons[0].silent).toBe(false);
      expect(result.data.crons[0].enabled).toBe(true);
    }
  });

  it("rejects a bad apiVersion literal", () => {
    const result = AgentTypeManifestSchema.safeParse(
      baseManifest({ apiVersion: "shipwright.dev/v1" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a repos entry not in org/repo format", () => {
    const result = AgentTypeManifestSchema.safeParse(
      baseManifest({ repos: ["not-a-valid-repo"] }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts an optional resources override", () => {
    const result = AgentTypeManifestSchema.safeParse(
      baseManifest({
        resources: {
          requests: { cpu: "500m", memory: "2Gi", "ephemeral-storage": "1Gi" },
          limits: { memory: "8Gi", "ephemeral-storage": "1Gi" },
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});
