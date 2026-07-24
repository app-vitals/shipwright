/**
 * admin/src/agent-type-registry.ts
 *
 * Agent Type manifest schema — the single source of truth for the
 * `shipwright.dev/v1alpha1` / `AgentType` YAML manifest that declares an
 * agent type's identity, crons, plugins, tools, env contract, membership,
 * repos, and chat/voice toggles.
 *
 * Named "agent-type-registry" (not "manifest") to avoid colliding with the
 * two existing "manifest" concepts in this repo: the Kubernetes manifests in
 * ./agent-manifest.ts and the Slack app manifest. This module is unrelated
 * to either — it's a declarative spec fed into scripts/CLI tooling, not a
 * wire type, so it uses plain `zod` rather than `@hono/zod-openapi`'s
 * `.openapi()`-augmented `z` (kept simple for zod-to-json-schema conversion).
 *
 * Manifests are treated as a trust boundary: they may originate from
 * third-party contributors, so every object schema is `.strict()` (unknown
 * keys rejected, not silently stripped) and the env contract is
 * deliberately keys-only — no `value`/`default` field is permitted on an
 * env entry, so a manifest can declare *that* a var is needed without ever
 * carrying a real value.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { isOrgRepo } from "@shipwright/lib/org-repo";

/** RFC1123 label pattern (see admin/src/agent-manifest.ts's sanitizeAgentName). */
const RFC1123_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// ─── metadata.skills[] (A2A-aligned) ───────────────────────────────────────

/**
 * Minimal A2A (Agent2Agent) "skill" shape: what the agent type can do, as a
 * small catalog entry. Kept intentionally narrow — id/name/description plus
 * optional free-form tags — since this repo has no existing A2A convention
 * to align with beyond the general shape of an agent capability card.
 */
const AgentTypeSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()).optional(),
  })
  .strict();

// ─── metadata ───────────────────────────────────────────────────────────────

const AgentTypeMetadataSchema = z
  .object({
    name: z
      .string()
      .regex(RFC1123_NAME, "metadata.name must be a valid RFC1123 label"),
    displayName: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    skills: z.array(AgentTypeSkillSchema),
  })
  .strict();

// ─── identity ───────────────────────────────────────────────────────────────

const AgentTypeIdentitySchema = z
  .object({
    templatesDir: z.string().min(1),
  })
  .strict();

// ─── crons[] ────────────────────────────────────────────────────────────────

/**
 * A single cron template declared inside an AgentType manifest. Distinct
 * from the runtime, DB-backed AgentCronJobSchema (admin/src/openapi-schemas.ts)
 * and CreateAgentCronJobInput (admin/src/agent-cron-jobs.ts) — those describe
 * per-agent-instance rows already created in Postgres; this describes a
 * *template* inside a versioned spec. `parentCron` here is a name reference
 * resolved within this manifest's own crons[] array (validated by the
 * top-level schema's superRefine below), not a DB id reference.
 */
const AgentTypeCronSchema = z
  .object({
    name: z.string().min(1),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    preCheck: z.string().optional(),
    silent: z.boolean().optional().default(false),
    enabled: z.boolean().optional().default(true),
    parentCron: z.string().optional(),
  })
  .strict();

// ─── env contract ───────────────────────────────────────────────────────────

/**
 * A single env contract entry. Keys-only by design: a manifest declares that
 * a var is needed (and whether it's secret) — it never carries a `value` or
 * `default`. `.strict()` ensures an unexpected `value` key is rejected, not
 * silently stripped, since manifests are potential third-party input.
 */
const AgentTypeEnvEntrySchema = z
  .object({
    key: z.string().min(1),
    description: z.string().min(1),
    secret: z.boolean(),
  })
  .strict();

const AgentTypeEnvSchema = z
  .object({
    required: z.array(AgentTypeEnvEntrySchema),
    optional: z.array(AgentTypeEnvEntrySchema),
  })
  .strict();

// ─── resources override (optional) ─────────────────────────────────────────

/**
 * Optional override of the default agent container resources (see
 * AGENT_CONTAINER_RESOURCES in admin/src/agent-manifest.ts). All fields
 * optional — a manifest may override just one of requests/limits.
 */
const AgentTypeResourceListSchema = z
  .object({
    cpu: z.string().optional(),
    memory: z.string().optional(),
    "ephemeral-storage": z.string().optional(),
  })
  .strict();

const AgentTypeResourcesSchema = z
  .object({
    requests: AgentTypeResourceListSchema.optional(),
    limits: AgentTypeResourceListSchema.optional(),
  })
  .strict();

// ─── Top-level AgentType manifest ──────────────────────────────────────────

export const AgentTypeManifestSchema = z
  .object({
    apiVersion: z.literal("shipwright.dev/v1alpha1"),
    kind: z.literal("AgentType"),
    metadata: AgentTypeMetadataSchema,
    identity: AgentTypeIdentitySchema,
    crons: z.array(AgentTypeCronSchema),
    plugins: z.array(z.string()),
    tools: z.array(z.string()),
    env: AgentTypeEnvSchema,
    members: z.array(z.string()),
    repos: z.array(
      z.string().refine(isOrgRepo, {
        message: "each repo must be in org/repo format",
      }),
    ),
    chat: z.boolean(),
    voice: z.boolean(),
    resources: AgentTypeResourcesSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const cronNames = new Set(manifest.crons.map((c) => c.name));
    manifest.crons.forEach((cron, index) => {
      if (cron.parentCron === undefined) return;
      if (cron.parentCron === cron.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["crons", index, "parentCron"],
          message: `parentCron "${cron.parentCron}" cannot reference its own cron entry`,
        });
        return;
      }
      if (!cronNames.has(cron.parentCron)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["crons", index, "parentCron"],
          message: `parentCron "${cron.parentCron}" does not match any cron name in this manifest`,
        });
      }
    });
  });

export type AgentTypeManifest = z.infer<typeof AgentTypeManifestSchema>;

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse and validate a YAML AgentType manifest string.
 *
 * Pure — no I/O. `content` is the already-read YAML text; throws a
 * descriptive Error (with the underlying ZodError's field-path issues
 * embedded in `message`, and the ZodError itself reachable via `cause`) if
 * the manifest fails schema validation.
 */
export function parseAgentTypeManifest(content: string): AgentTypeManifest {
  const raw: unknown = parseYaml(content);
  const result = AgentTypeManifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid AgentType manifest — ${details}`, {
      cause: result.error,
    });
  }
  return result.data;
}

// ─── JSON Schema generation ─────────────────────────────────────────────────

/**
 * Build the JSON-serializable JSON Schema object for AgentTypeManifestSchema.
 *
 * Pure — no file I/O — so both scripts/generate-agent-type-schema.ts's CLI
 * entrypoint and its content test can call this directly instead of shelling
 * out. The `zod-to-json-schema` import is kept in this module (rather than
 * in the scripts/ entrypoint) so Bun's node_modules resolution — which walks
 * up from the *importing file's* directory — finds it via admin/node_modules,
 * where it's declared as a direct dependency.
 */
export function buildAgentTypeJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(
    AgentTypeManifestSchema,
    "AgentTypeManifest",
  ) as Record<string, unknown>;
}
