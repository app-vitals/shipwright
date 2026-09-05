/**
 * agent/src/agents.ts
 * AgentService — CRUD/read access to the Agent model.
 *
 * Mirrors the sibling *Service modules (AgentEnvService, AgentTokenService,
 * etc.) so route handlers never call prisma.agent.* directly.
 */

import type { PrismaClient } from "../prisma/client/index.js";
import { AgentMemberService } from "./agent-members.ts";
import {
  type AgentTypeManifestResolver,
  AgentTypeRegistry,
} from "./agent-type-manifest-loader.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateAgentInput {
  name: string;
  slackId?: string | null;
  selfHosted?: boolean;
  /** Agent Type name. Omitted means Prisma's column default ("coding") applies. */
  typeName?: string;
  /** Initial repos[] — the manifest repos merged with any request-supplied repos. */
  repos?: string[];
  /** Initial reviewAuthorAllowlist[]. */
  reviewAuthorAllowlist?: string[];
  /** Initial patchAuthorAllowlist[]. Independent of reviewAuthorAllowlist. */
  patchAuthorAllowlist?: string[];
  /** Initial restrictSlackToMembers flag. Omitted means the column default (false) applies. */
  restrictSlackToMembers?: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  typeName: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optional here even though listAll()/listByIds()/searchByName() below
   * always return the full Prisma row (repos included, since none of them
   * pass a `select` clause) — kept optional so existing call sites/test
   * doubles constructing a narrower AgentRecord literal don't need updating.
   * Consumed by the merged fleet-wide queue-activity view (AAV-2.1) to build
   * the repo -> agentId[] eligibility index (agent-work-queue-merge.ts's
   * buildEligibilityIndex()).
   */
  repos?: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
  selfHosted: boolean;
  typeName: string;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  repos: string[];
  reviewAuthorAllowlist: string[];
  patchAuthorAllowlist: string[];
  restrictSlackToMembers: boolean;
  typeName: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Required env keys declared by the agent's type manifest that have no
   * corresponding AgentEnv row yet — key names only, never values
   * (secrets_in_logs). Always present (empty array when the type's required
   * contract is empty or every required key is set). Informational only —
   * not a create blocker or provisioning gate (ATS-4.2).
   */
  missingRequiredEnv: string[];
}

export interface UpdateSelfHostedInput {
  /**
   * Optional to mirror Prisma's generated AgentUpdateInput shape (undefined
   * means "leave unchanged"); callers such as PATCH /agents/:id currently
   * always pass a value since selfHosted is treated as required at the route
   * level, but the type stays permissive to match the underlying data layer.
   */
  selfHosted?: boolean;
  repos?: string[];
  reviewAuthorAllowlist?: string[];
  patchAuthorAllowlist?: string[];
  restrictSlackToMembers?: boolean;
  /**
   * Backfills agent.slackId (UAP-1.3) — nullable so it can also be
   * explicitly cleared via PATCH /agents/:id.
   */
  slackId?: string | null;
}

interface AgentIdAndRepos {
  id: string;
  repos: string[];
  reviewAuthorAllowlist: string[];
  patchAuthorAllowlist: string[];
  restrictSlackToMembers: boolean;
  memberEmails: string[];
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface UpdateAgentFieldsInput {
  name?: string;
  repos?: string[];
  reviewAuthorAllowlist?: string[];
  patchAuthorAllowlist?: string[];
  restrictSlackToMembers?: boolean;
  selfHosted?: boolean;
  slackId?: string | null;
}

// ─── Select shapes ────────────────────────────────────────────────────────────

const SUMMARY_SELECT = {
  id: true,
  name: true,
  selfHosted: true,
  typeName: true,
} as const;

const DETAIL_SELECT = {
  id: true,
  name: true,
  slackId: true,
  selfHosted: true,
  repos: true,
  reviewAuthorAllowlist: true,
  patchAuthorAllowlist: true,
  restrictSlackToMembers: true,
  typeName: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ─── Service ──────────────────────────────────────────────────────────────────

export class AgentService {
  constructor(
    private prisma: PrismaClient,
    private agentTypeRegistry: AgentTypeManifestResolver = new AgentTypeRegistry(),
    private agentMemberService: Pick<
      AgentMemberService,
      "listByAgentId"
    > = new AgentMemberService(prisma),
  ) {}

  /**
   * Create a new agent row, plus `missingRequiredEnv` (see
   * computeMissingRequiredEnv) — a freshly created agent has no AgentEnv rows
   * yet, so this always reflects the full set of the type's required keys.
   */
  async create(input: CreateAgentInput): Promise<AgentDetail> {
    const row = await this.prisma.agent.create({
      data: {
        name: input.name,
        slackId: input.slackId ?? null,
        selfHosted: input.selfHosted ?? false,
        ...(input.typeName !== undefined ? { typeName: input.typeName } : {}),
        ...(input.repos !== undefined ? { repos: input.repos } : {}),
        ...(input.reviewAuthorAllowlist !== undefined
          ? { reviewAuthorAllowlist: input.reviewAuthorAllowlist }
          : {}),
        ...(input.patchAuthorAllowlist !== undefined
          ? { patchAuthorAllowlist: input.patchAuthorAllowlist }
          : {}),
        ...(input.restrictSlackToMembers !== undefined
          ? { restrictSlackToMembers: input.restrictSlackToMembers }
          : {}),
      },
    });
    const missingRequiredEnv = await this.computeMissingRequiredEnv(
      row.id,
      row.typeName,
    );
    return { ...row, missingRequiredEnv };
  }

  /**
   * Delete an agent row by id. Used as the provisioning-failure rollback path
   * on create(), and (out of scope here) internally by deleteAgentFully().
   */
  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } });
  }

  /**
   * List all agents (id + name + selfHosted + typeName), ordered by name asc.
   */
  async list(): Promise<AgentSummary[]> {
    return this.prisma.agent.findMany({
      select: SUMMARY_SELECT,
      orderBy: { name: "asc" },
    });
  }

  /**
   * Get {id, name, selfHosted, typeName} for a single agent. Returns null if
   * not found.
   */
  async getSummary(id: string): Promise<AgentSummary | null> {
    return this.prisma.agent.findUnique({
      where: { id },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * The env-contract gap: the type manifest's required env keys minus the
   * keys already present in this agent's AgentEnv rows (key names only,
   * never values — the AgentEnv query below selects only `key`, never
   * `value`, so decrypted secrets can never reach this computation).
   * Skips the AgentEnv query entirely when the manifest declares no required
   * keys. Purely informational: never blocks create or gates provisioning
   * (ATS-4.2).
   */
  private async computeMissingRequiredEnv(
    agentId: string,
    typeName: string,
  ): Promise<string[]> {
    const requiredKeys = this.agentTypeRegistry
      .getManifest(typeName)
      .env.required.map((entry) => entry.key);

    if (requiredKeys.length === 0) return [];

    // Key names only — never select/decrypt AgentEnv.value here.
    const presentEnvRows = await this.prisma.agentEnv.findMany({
      where: { agentId },
      select: { key: true },
    });
    const presentKeys = new Set(presentEnvRows.map((r) => r.key));
    return requiredKeys.filter((key) => !presentKeys.has(key));
  }

  /**
   * Get the full agent record (incl. repos/typeName/timestamps), plus
   * `missingRequiredEnv` (see computeMissingRequiredEnv). Returns null if not
   * found.
   */
  async getDetail(id: string): Promise<AgentDetail | null> {
    const row = await this.prisma.agent.findUnique({
      where: { id },
      select: DETAIL_SELECT,
    });
    if (!row) return null;

    const missingRequiredEnv = await this.computeMissingRequiredEnv(
      id,
      row.typeName,
    );
    return { ...row, missingRequiredEnv };
  }

  /**
   * Returns whether an agent with the given id exists.
   */
  async exists(id: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: { id: true },
    });
    return agent !== null;
  }

  /**
   * Update selfHosted (and optionally repos) for an agent. Returns the full
   * updated record.
   */
  async updateSelfHosted(
    id: string,
    input: UpdateSelfHostedInput,
  ): Promise<AgentDetail> {
    const row = await this.prisma.agent.update({
      where: { id },
      data: {
        selfHosted: input.selfHosted,
        ...(input.repos !== undefined ? { repos: input.repos } : {}),
        ...(input.reviewAuthorAllowlist !== undefined
          ? { reviewAuthorAllowlist: input.reviewAuthorAllowlist }
          : {}),
        ...(input.patchAuthorAllowlist !== undefined
          ? { patchAuthorAllowlist: input.patchAuthorAllowlist }
          : {}),
        ...(input.restrictSlackToMembers !== undefined
          ? { restrictSlackToMembers: input.restrictSlackToMembers }
          : {}),
        ...(input.slackId !== undefined ? { slackId: input.slackId } : {}),
      },
      select: DETAIL_SELECT,
    });
    const missingRequiredEnv = await this.computeMissingRequiredEnv(
      id,
      row.typeName,
    );
    return { ...row, missingRequiredEnv };
  }

  /**
   * Get {id, repos, reviewAuthorAllowlist, patchAuthorAllowlist,
   * restrictSlackToMembers, memberEmails} for a single agent — used by the
   * runtime config/crons routes. Returns null if not found.
   */
  async getById(id: string): Promise<AgentIdAndRepos | null> {
    const row = await this.prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        repos: true,
        reviewAuthorAllowlist: true,
        patchAuthorAllowlist: true,
        restrictSlackToMembers: true,
      },
    });
    if (!row) return null;

    const members = await this.agentMemberService.listByAgentId(id);
    const memberEmails = members.map((m) => m.email);
    return { ...row, memberEmails };
  }

  /**
   * List every agent, full record, no filtering — used by dashboard-style
   * pages (e.g. /admin/agents isAdmin branch, /admin/provision, /admin/tasks,
   * /admin/prs, /admin/chat) that want every field back in whatever default
   * order Prisma returns.
   */
  async listAll(): Promise<AgentRecord[]> {
    return this.prisma.agent.findMany();
  }

  /**
   * List agents matching a given set of ids — used for batch-resolving
   * agent ids to full records (e.g. the non-admin /admin/agents filter path
   * and agentNames-resolution on the tasks/PRs pages).
   */
  async listByIds(ids: string[]): Promise<AgentRecord[]> {
    return this.prisma.agent.findMany({ where: { id: { in: ids } } });
  }

  /**
   * Search agents by name, case-insensitive substring match — used by the
   * /admin/tasks agent-name filter.
   */
  async searchByName(query: string): Promise<AgentRecord[]> {
    return this.prisma.agent.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
    });
  }

  /**
   * List {id, name} for all agents, ordered by name asc. Backs both the
   * full-record-mapped-to-{id,name} call sites (chat page, provision pages)
   * and the name-only autocomplete call site (tasks page).
   */
  async listOptions(): Promise<AgentOption[]> {
    return this.prisma.agent.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Generic partial-field update for an agent's
   * name/repos/reviewAuthorAllowlist/patchAuthorAllowlist/
   * restrictSlackToMembers/selfHosted/slackId. Only fields present in the
   * input are touched. Returns the full updated detail record.
   */
  async updateFields(
    id: string,
    input: UpdateAgentFieldsInput,
  ): Promise<AgentDetail> {
    const row = await this.prisma.agent.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.repos !== undefined && { repos: input.repos }),
        ...(input.reviewAuthorAllowlist !== undefined && {
          reviewAuthorAllowlist: input.reviewAuthorAllowlist,
        }),
        ...(input.patchAuthorAllowlist !== undefined && {
          patchAuthorAllowlist: input.patchAuthorAllowlist,
        }),
        ...(input.restrictSlackToMembers !== undefined && {
          restrictSlackToMembers: input.restrictSlackToMembers,
        }),
        ...(input.selfHosted !== undefined && {
          selfHosted: input.selfHosted,
        }),
        ...(input.slackId !== undefined && { slackId: input.slackId }),
      },
      select: DETAIL_SELECT,
    });
    const missingRequiredEnv = await this.computeMissingRequiredEnv(
      id,
      row.typeName,
    );
    return { ...row, missingRequiredEnv };
  }
}
