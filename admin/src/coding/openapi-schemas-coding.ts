/**
 * admin/src/coding/openapi-schemas-coding.ts
 * Zod/OpenAPI schemas for the coding extension's admin API routes (phase
 * methodology overrides, work-queue snapshots), moved out of
 * openapi-schemas.ts (AEP-3.2). Component names are unchanged, so the
 * generated admin/openapi.json is too.
 */

import { AGENT_PHASES } from "@app-vitals/agent-admin/openapi-schemas";
import { z } from "@hono/zod-openapi";

// ─── AgentPhaseMethodology ──────────────────────────────────────────────────────

export const AgentPhaseMethodologySchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    phase: z.enum(AGENT_PHASES).openapi({ example: "review" }),
    subagentType: z
      .string()
      .nullable()
      .openapi({ example: "shipwright:code-reviewer" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentPhaseMethodology");

export type AgentPhaseMethodology = z.infer<typeof AgentPhaseMethodologySchema>;

export const PutAgentPhaseMethodologyBodySchema = z
  .object({
    subagentType: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "shipwright:code-reviewer" }),
  })
  .openapi("PutAgentPhaseMethodologyBody");

export const PhaseParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  phase: z.enum(AGENT_PHASES).openapi({ example: "review" }),
});

// ─── AgentWorkQueueSnapshot ───────────────────────────────────────────────────

/**
 * A single ranked work item, mirroring the RankedWorkItem interface in
 * agent/src/coding/work-selector.ts (type/phase are string enums there — validated
 * here for real, since this is a request body needing genuine validation,
 * not just an opaque Json passthrough).
 *
 * `phase` MUST stay in lockstep with RankedWorkItem["phase"] in
 * agent/src/coding/work-selector.ts — the loop orchestrator POSTs a snapshot every
 * tick, so a phase the agent can emit but this enum doesn't list 400s the
 * whole snapshot (PDR-4.1 added "plan").
 */
const RankedWorkItemSchema = z
  .object({
    type: z.enum(["task", "pr"]).openapi({ example: "task" }),
    id: z.string().openapi({ example: "WLS-2.2" }),
    title: z
      .string()
      .optional()
      .openapi({ example: "Add work queue snapshot endpoints" }),
    phase: z
      .enum(["dev-task", "plan", "review", "patch", "deploy"])
      .openapi({ example: "dev-task" }),
    age: z.string().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description: "ISO timestamp",
    }),
  })
  .openapi("RankedWorkItem");

export type RankedWorkItem = z.infer<typeof RankedWorkItemSchema>;

/**
 * POST /agents/:id/work-queue body — the envelope an agent pushes each time
 * it recomputes its ranked work queue. Upserts the single row for that
 * agentId, overwriting any prior snapshot.
 */
export const PushWorkQueueSnapshotBodySchema = z
  .object({
    computedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    items: z.array(RankedWorkItemSchema),
  })
  .openapi("PushWorkQueueSnapshotBody");

/**
 * GET /agents/:id/work-queue response — the latest pushed snapshot.
 */
export const AgentWorkQueueSnapshotSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    computedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    items: z.array(RankedWorkItemSchema),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentWorkQueueSnapshot");
