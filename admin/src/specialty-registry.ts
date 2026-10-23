/**
 * admin/src/specialty-registry.ts
 *
 * Specialty manifest schema — the single source of truth for the
 * `shipwright.dev/v1alpha1` / `Specialty` YAML manifest that declares an
 * specialty's identity, crons, plugins, tools, env contract, membership,
 * repos, and chat/voice toggles.
 *
 * Named "specialty-registry" (not "manifest") to avoid colliding with the
 * two existing "manifest" concepts in this repo: the Kubernetes manifests in
 * ./agent-manifest.ts and the Slack app manifest. This module is unrelated
 * to either — it's a declarative spec fed into scripts/CLI tooling, not a
 * wire type, so it uses plain `zod` rather than `@hono/zod-openapi`'s
 * `.openapi()`-augmented `z` (kept simple for JSON Schema conversion).
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
import { isOrgRepo } from "@shipwright/lib/org-repo";

/** RFC1123 label pattern (see admin/src/agent-manifest.ts's sanitizeAgentName). */
const RFC1123_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// ─── metadata.skills[] (A2A-aligned) ───────────────────────────────────────

/**
 * Minimal A2A (Agent2Agent) "skill" shape: what the specialty can do, as a
 * small catalog entry. Kept intentionally narrow — id/name/description plus
 * optional free-form tags — since this repo has no existing A2A convention
 * to align with beyond the general shape of an agent capability card.
 */
const SpecialtySkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()).optional(),
  })
  .strict();

// ─── metadata ───────────────────────────────────────────────────────────────

const SpecialtyMetadataSchema = z
  .object({
    name: z
      .string()
      .regex(RFC1123_NAME, "metadata.name must be a valid RFC1123 label"),
    displayName: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    skills: z.array(SpecialtySkillSchema),
  })
  .strict();

// ─── identity ───────────────────────────────────────────────────────────────

const SpecialtyIdentitySchema = z
  .object({
    templatesDir: z.string().min(1),
  })
  .strict();

// ─── crons[] ────────────────────────────────────────────────────────────────

/**
 * A single cron template declared inside a Specialty manifest. Distinct
 * from the runtime, DB-backed AgentCronJobSchema (admin/src/openapi-schemas.ts)
 * and CreateAgentCronJobInput (admin/src/agent-cron-jobs.ts) — those describe
 * per-agent-instance rows already created in Postgres; this describes a
 * *template* inside a versioned spec. `parentCron` here is a name reference
 * resolved within this manifest's own crons[] array (validated by the
 * top-level schema's superRefine below), not a DB id reference.
 */
const SpecialtyCronSchema = z
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
const SpecialtyEnvEntrySchema = z
  .object({
    key: z.string().min(1),
    description: z.string().min(1),
    secret: z.boolean(),
  })
  .strict();

const SpecialtyEnvSchema = z
  .object({
    required: z.array(SpecialtyEnvEntrySchema),
    optional: z.array(SpecialtyEnvEntrySchema),
  })
  .strict();

// ─── resources override (optional) ─────────────────────────────────────────

/**
 * Optional override of the default agent container resources (see
 * resolveAgentContainerResources in admin/src/agent-manifest.ts). All fields
 * optional — a manifest may override just one of requests/limits.
 *
 * Not yet wired to any provisioner — parsed as part of
 * SpecialtyManifestSchema.resources but inert until a future task consumes it
 * ahead of resolveAgentContainerResources's env-override layer (see that
 * function's precedence-rule doc comment).
 */
const SpecialtyResourceListSchema = z
  .object({
    cpu: z.string().optional(),
    memory: z.string().optional(),
    "ephemeral-storage": z.string().optional(),
  })
  .strict();

const SpecialtyResourcesSchema = z
  .object({
    requests: SpecialtyResourceListSchema.optional(),
    limits: SpecialtyResourceListSchema.optional(),
  })
  .strict();

// ─── Top-level Specialty manifest ──────────────────────────────────────────

export const SpecialtyManifestSchema = z
  .object({
    apiVersion: z.literal("shipwright.dev/v1alpha1"),
    kind: z.literal("Specialty"),
    metadata: SpecialtyMetadataSchema,
    identity: SpecialtyIdentitySchema,
    crons: z.array(SpecialtyCronSchema),
    plugins: z.array(z.string()),
    tools: z.array(z.string()),
    env: SpecialtyEnvSchema,
    members: z.array(z.string()),
    repos: z.array(
      z.string().refine(isOrgRepo, {
        message: "each repo must be in org/repo format",
      }),
    ),
    chat: z.boolean(),
    voice: z.boolean(),
    resources: SpecialtyResourcesSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const cronNames = new Set(manifest.crons.map((c) => c.name));
    manifest.crons.forEach((cron, index) => {
      if (cron.parentCron === undefined) return;
      if (cron.parentCron === cron.name) {
        ctx.addIssue({
          code: "custom",
          path: ["crons", index, "parentCron"],
          message: `parentCron "${cron.parentCron}" cannot reference its own cron entry`,
        });
        return;
      }
      if (!cronNames.has(cron.parentCron)) {
        ctx.addIssue({
          code: "custom",
          path: ["crons", index, "parentCron"],
          message: `parentCron "${cron.parentCron}" does not match any cron name in this manifest`,
        });
      }
    });
  });

export type SpecialtyManifest = z.infer<typeof SpecialtyManifestSchema>;

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse and validate a YAML Specialty manifest string.
 *
 * Pure — no I/O. `content` is the already-read YAML text; throws a
 * descriptive Error (with the underlying ZodError's field-path issues
 * embedded in `message`, and the ZodError itself reachable via `cause`) if
 * the manifest fails schema validation.
 */
export function parseSpecialtyManifest(content: string): SpecialtyManifest {
  const raw: unknown = parseYaml(content);
  const result = SpecialtyManifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid Specialty manifest — ${details}`, {
      cause: result.error,
    });
  }
  return result.data;
}

// ─── JSON Schema generation ─────────────────────────────────────────────────

/**
 * Build the JSON-serializable JSON Schema object for SpecialtyManifestSchema.
 *
 * Pure — no file I/O — so both scripts/generate-specialty-schema.ts's CLI
 * entrypoint and its content test can call this directly instead of shelling
 * out. Uses zod 4's built-in `z.toJSONSchema` (draft-07 target, to stay
 * contract-compatible with the previous zod-to-json-schema output).
 */
export function buildSpecialtyJsonSchema(): Record<string, unknown> {
  const { $schema, ...definition } = z.toJSONSchema(SpecialtyManifestSchema, {
    target: "draft-7",
    io: "input",
  });
  // Wrap as a named definition (`$ref` + `definitions`) — the shape the
  // previous zod-to-json-schema output used, so consumers see no change.
  return {
    $ref: "#/definitions/SpecialtyManifest",
    definitions: { SpecialtyManifest: definition },
    $schema,
  };
}
