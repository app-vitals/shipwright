/**
 * agent/src/agents.ts
 * AgentService — CRUD/read access to the Agent model.
 *
 * Mirrors the sibling *Service modules (AgentEnvService, AgentTokenService,
 * etc.) so route handlers never call prisma.agent.* directly.
 */

import { isGithubLogin } from "@shipwright/lib/github-login";
import { isOrgRepo } from "@shipwright/lib/org-repo";
import { SECRET_ENV_VARS } from "@shipwright/lib/secret-env-vars";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import { AgentMemberService } from "./agent-members.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentToolService } from "./agent-tools.ts";
import {
  type AgentTypeManifestResolver,
  AgentTypeRegistry,
} from "./agent-type-manifest-loader.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

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
   *
   * @param client - defaults to `this.prisma`; pass the `tx` argument from a
   *   caller's `prisma.$transaction(async (tx) => ...)` to make this write
   *   participate in that transaction (see createAgent() below).
   */
  async create(
    input: CreateAgentInput,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentDetail> {
    const row = await client.agent.create({
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
      client,
    );
    return { ...row, missingRequiredEnv };
  }

  /**
   * Delete an agent row by id. Used as the provisioning-failure rollback path
   * on create(), and (out of scope here) internally by deleteAgentFully().
   *
   * @param client - defaults to `this.prisma`; pass the `tx` argument from a
   *   caller's `prisma.$transaction(async (tx) => ...)` to make this write
   *   participate in that transaction (see createAgent() below).
   */
  async delete(
    id: string,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<void> {
    await client.agent.delete({ where: { id } });
  }

  /**
   * Run a function inside a single interactive Prisma transaction — a thin
   * wrapper over `this.prisma.$transaction()` so callers outside this class
   * (e.g. createAgent() below, driven from admin-ui.ts with injected service
   * doubles in tests) never need direct access to the raw PrismaClient.
   */
  async runTransaction<T>(
    fn: (tx: PrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(fn);
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
    client: PrismaTransactionClient = this.prisma,
  ): Promise<string[]> {
    const requiredKeys = this.agentTypeRegistry
      .getManifest(typeName)
      .env.required.map((entry) => entry.key);

    if (requiredKeys.length === 0) return [];

    // Key names only — never select/decrypt AgentEnv.value here.
    const presentEnvRows = await client.agentEnv.findMany({
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
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentDetail> {
    const row = await client.agent.update({
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
      client,
    );
    return { ...row, missingRequiredEnv };
  }
}

// ─── createAgent() ────────────────────────────────────────────────────────────

/**
 * Raw form-shaped input for createAgent() — mirrors exactly what
 * admin-ui.ts's POST /admin/agents handler extracts from the submitted
 * FormData, before any parsing/validation. createAgent() owns all of the
 * parsing (multi-line repo/allowlist/member lists, dedup, format validation)
 * that the old inline handler used to do itself, so there is exactly one
 * implementation of agent creation (APA-1.1).
 */
export interface CreateAgentFormInput {
  name: string | undefined;
  typeName: string | undefined;
  /**
   * "in-cluster" means K8s-provisioned; anything else (including absent)
   * means self-hosted — matches the pre-APA-1.1 handler's fallback rule.
   */
  runtime: string | undefined;
  reposRaw: string | undefined;
  authorAllowlistRaw: string | undefined;
  patchAuthorAllowlistRaw: string | undefined;
  memberEmailsRaw: string | undefined;
  /** Raw "true"/"false" form value — only the literal string "true" enables it. */
  restrictSlackToMembersRaw: string | undefined;
  claudeCodeOauthToken: string | undefined;
  anthropicApiKey: string | undefined;
}

/**
 * Error codes matching the `?error=` query-param values the pre-APA-1.1
 * inline handler redirected with — preserved 1:1 so createAgent() is a
 * drop-in replacement: admin-ui.ts maps `errorCode` straight into the
 * redirect URL (`/admin/agents/new?error=${errorCode}`).
 */
export type CreateAgentErrorCode =
  | "missing_fields"
  | "invalid_type"
  | "provisioning_disabled"
  | "seed_failed"
  | "invalid_repo_format"
  | "invalid_author_allowlist_format"
  | "provision_failed";

export type CreateAgentResult =
  | { ok: true; agent: AgentDetail; restrictSlackToMembers: boolean }
  | { ok: false; errorCode: CreateAgentErrorCode };

/**
 * Injected service dependencies for createAgent() — the same instances
 * admin-ui.ts already constructs/receives via AdminUIDeps, narrowed to just
 * the methods this function calls.
 */
export interface CreateAgentDeps {
  agentService: Pick<
    AgentService,
    "create" | "delete" | "updateFields" | "runTransaction"
  >;
  agentToolService: Pick<AgentToolService, "add">;
  agentPluginService: Pick<AgentPluginService, "add">;
  agentMemberService: Pick<AgentMemberService, "add">;
  agentEnvService: Pick<AgentEnvService, "patch">;
  agentCronJobService: Pick<AgentCronJobService, "reconcileSystemCrons">;
  provisioner: Pick<AgentProvisioner, "canProvision" | "provision">;
  agentTypeRegistry: Pick<AgentTypeManifestResolver, "tryGetManifest">;
}

/**
 * Parses a textarea's newline-separated lines into a trimmed, non-empty
 * list — optionally lower-cased and/or deduped. Mirrors the ad-hoc parsing
 * the pre-APA-1.1 inline handler did separately for each of
 * repos/authorAllowlist/patchAuthorAllowlist/memberEmails (repos was never
 * deduped; the other three were).
 */
function parseLines(
  raw: string,
  opts: { lower?: boolean; dedup?: boolean } = {},
): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => (opts.lower ? l.trim().toLowerCase() : l.trim()))
    .filter((l) => l.length > 0);
  return opts.dedup ? [...new Set(lines)] : lines;
}

/** Discriminated outcome of the transactional portion of createAgent(). */
type CreateAgentTxOutcome =
  | { ok: true; agent: AgentDetail }
  | { ok: false; errorCode: CreateAgentErrorCode };

/**
 * Atomically create an agent: validate name/typeName, create the Agent row,
 * seed AgentTool/AgentPlugin from the resolved type manifest, attach
 * repos/allowlists/members, patch Claude credentials, provision Kubernetes
 * resources when requested, and best-effort reconcile system crons.
 *
 * Extracted from admin-ui.ts's POST /admin/agents form handler (APA-1.1) so
 * there is exactly one implementation of agent creation.
 *
 * All DB-writing steps — create, tool/plugin seeding, and attaching
 * repos/allowlists/members — run inside a single interactive Prisma
 * transaction via `agentService.runTransaction()`. A mid-sequence failure
 * (seeding throws, or a repo/allowlist fails format validation) is handled
 * by an explicit compensating `agentService.delete()` call *inside that same
 * transaction*, followed by a normal (non-throwing) return — the delete
 * commits atomically alongside everything that preceded it, so external
 * readers never observe the agent in a half-seeded state and zero rows
 * persist once the transaction commits. This preserves the pre-APA-1.1
 * behavior of explicitly calling delete() on failure (observable by
 * callers/tests that inject their own AgentService) while still giving the
 * whole sequence true single-transaction atomicity.
 *
 * Kubernetes provisioning is an external side effect that cannot join that
 * transaction: it runs after the transaction has already committed, and on
 * failure the just-created Agent row is explicitly deleted as a separate
 * statement — matching the pre-APA-1.1 delete-on-failure behavior exactly.
 *
 * reconcileSystemCrons() runs last and is best-effort/non-blocking —
 * failures are logged, never surfaced as an error (mirrors the same call at
 * agent boot, agent/src/index.ts).
 */
export async function createAgent(
  deps: CreateAgentDeps,
  input: CreateAgentFormInput,
): Promise<CreateAgentResult> {
  const name = input.name;
  if (!name) {
    return { ok: false, errorCode: "missing_fields" };
  }

  // Resolve the requested type BEFORE creating any row — an unknown/missing
  // type must fail with zero rows created. The resolved manifest is
  // captured (not discarded) so its tools/plugins can be seeded below.
  const typeName = input.typeName;
  const manifest = typeName
    ? deps.agentTypeRegistry.tryGetManifest(typeName)
    : undefined;
  if (!typeName || !manifest) {
    return { ok: false, errorCode: "invalid_type" };
  }

  // Absent/unrecognized runtime means self-hosted — the historical behavior
  // of this form.
  const inCluster = input.runtime === "in-cluster";
  // Same "validate before creating any row" rule as the type check above: a
  // no-op provisioner would let provision() succeed while creating nothing,
  // leaving an agent row with no workload behind it.
  if (inCluster && !deps.provisioner.canProvision) {
    return { ok: false, errorCode: "provisioning_disabled" };
  }

  const restrictSlackToMembers = input.restrictSlackToMembersRaw === "true";

  const txResult = await deps.agentService.runTransaction<CreateAgentTxOutcome>(
    async (tx) => {
      const agent = await deps.agentService.create(
        { name, selfHosted: !inCluster, typeName, restrictSlackToMembers },
        tx,
      );

      // Seed AgentTool/AgentPlugin rows from the resolved manifest. Roll the
      // agent row back on any seeding failure so a retry with the same name
      // doesn't collide with a half-seeded agent. Members/repos are NOT
      // seeded from the manifest here — they have their own dedicated
      // handling below, and the manifest's members/repos arrays are empty
      // for every agent type that exists today.
      try {
        for (const pattern of manifest.tools) {
          await deps.agentToolService.add(agent.id, pattern, tx);
        }
        for (const pluginName of manifest.plugins) {
          await deps.agentPluginService.add(
            agent.id,
            pluginName,
            undefined,
            tx,
          );
        }
      } catch (err) {
        console.error(
          "[agents] createAgent: tool/plugin seeding failed, rolling back:",
          err,
        );
        await deps.agentService.delete(agent.id, tx).catch((cleanupErr) => {
          console.error(
            "[agents] createAgent: failed to roll back agent after seeding error:",
            cleanupErr,
          );
        });
        return { ok: false, errorCode: "seed_failed" };
      }

      // Attach repos if provided.
      if (input.reposRaw) {
        const repos = parseLines(input.reposRaw);
        const invalid = repos.filter((r) => !isOrgRepo(r));
        if (invalid.length > 0) {
          await deps.agentService.delete(agent.id, tx);
          return { ok: false, errorCode: "invalid_repo_format" };
        }
        if (repos.length > 0) {
          await deps.agentService.updateFields(agent.id, { repos }, tx);
        }
      }

      // Attach authorAllowlist if provided.
      if (input.authorAllowlistRaw) {
        const authorAllowlist = parseLines(input.authorAllowlistRaw, {
          dedup: true,
        });
        const invalid = authorAllowlist.filter((l) => !isGithubLogin(l));
        if (invalid.length > 0) {
          await deps.agentService.delete(agent.id, tx);
          return { ok: false, errorCode: "invalid_author_allowlist_format" };
        }
        if (authorAllowlist.length > 0) {
          await deps.agentService.updateFields(
            agent.id,
            { reviewAuthorAllowlist: authorAllowlist },
            tx,
          );
        }
      }

      // Attach patchAuthorAllowlist if provided.
      if (input.patchAuthorAllowlistRaw) {
        const patchAuthorAllowlist = parseLines(input.patchAuthorAllowlistRaw, {
          dedup: true,
        });
        const invalid = patchAuthorAllowlist.filter((l) => !isGithubLogin(l));
        if (invalid.length > 0) {
          await deps.agentService.delete(agent.id, tx);
          return { ok: false, errorCode: "invalid_author_allowlist_format" };
        }
        if (patchAuthorAllowlist.length > 0) {
          await deps.agentService.updateFields(
            agent.id,
            { patchAuthorAllowlist },
            tx,
          );
        }
      }

      // Attach member emails if provided — best-effort, mirrors the
      // single-add POST /admin/agents/:id/members route: no format
      // validation, and a failed/duplicate add is silently ignored rather
      // than rolling back the agent.
      if (input.memberEmailsRaw) {
        const memberEmails = parseLines(input.memberEmailsRaw, {
          lower: true,
          dedup: true,
        });
        for (const email of memberEmails) {
          try {
            await deps.agentMemberService.add(agent.id, email, tx);
          } catch {
            // unique constraint violation — already a member, ignore
          }
        }
      }

      return { ok: true, agent };
    },
  );

  if (!txResult.ok) {
    return { ok: false, errorCode: txResult.errorCode };
  }
  const agent = txResult.agent;

  // Store the Claude credentials before provisioning so the pod comes up
  // with them already in its env bundle rather than failing its first turn.
  // Deliberately outside the transaction above (AgentEnvService.patch runs
  // its own internal transaction) and not rolled back on failure, matching
  // pre-APA-1.1 behavior: an uncaught error here propagates to the caller,
  // leaving the already-committed agent row in place.
  const claudeEnv: Record<string, string> = {};
  if (input.claudeCodeOauthToken) {
    claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = input.claudeCodeOauthToken;
  }
  if (input.anthropicApiKey) {
    claudeEnv.ANTHROPIC_API_KEY = input.anthropicApiKey;
  }
  if (Object.keys(claudeEnv).length > 0) {
    await deps.agentEnvService.patch(
      agent.id,
      claudeEnv,
      new Set(SECRET_ENV_VARS),
    );
  }

  if (inCluster) {
    // Kubernetes provisioning is an external side effect that cannot join
    // the DB transaction above — it runs after that transaction has already
    // committed. Roll the row back explicitly on failure so a retry with the
    // same name doesn't collide with a half-created agent.
    try {
      await deps.provisioner.provision(agent.id, { slug: agent.name });
    } catch (err) {
      console.error(
        "[agents] createAgent: provisioning failed, rolling back:",
        err,
      );
      await deps.agentService.delete(agent.id).catch((cleanupErr) => {
        console.error(
          "[agents] createAgent: failed to roll back agent after provision error:",
          cleanupErr,
        );
      });
      return { ok: false, errorCode: "provision_failed" };
    }
  }

  // Best-effort, mirroring the same call at agent boot (agent/src/index.ts).
  // reconcileSystemCrons is a full three-pass reconcile, so a second run is a
  // no-op — and failing here would strand the operator next to a live agent.
  try {
    await deps.agentCronJobService.reconcileSystemCrons(agent.id);
  } catch (err) {
    console.error(
      "[agents] createAgent: failed to seed system crons (non-fatal):",
      err,
    );
  }

  return { ok: true, agent, restrictSlackToMembers };
}
