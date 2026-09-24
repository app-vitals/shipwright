/**
 * agent/src/agents.integration.test.ts
 * Integration tests for createAgent() (admin/src/agents.ts) — the atomic
 * agent-creation orchestrator extracted from admin-ui.ts's POST /admin/agents
 * form handler (APA-1.1).
 *
 * Requires DATABASE_URL_ADMIN_TEST; skips otherwise (mirrors
 * agents-api.integration.test.ts's gating pattern).
 *
 * Runs against a REAL Postgres DB — not mocks — specifically to verify the
 * acceptance-criteria claim that can't be proven with injected test doubles:
 * that the DB-writing steps (create, tool/plugin seeding, repos/allowlists/
 * members) run inside a single real Prisma transaction, so a mid-sequence
 * failure leaves *zero* Agent row behind (not "delete() was called" — the
 * row is actually gone from the database), and that a Kubernetes
 * provisioning failure still deletes the row even though provisioning runs
 * after that transaction has already committed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner, ProvisionResult } from "./agent-provisioner.ts";
import { AgentToolService } from "./agent-tools.ts";
import type { AgentTypeManifestResolver } from "./agent-type-manifest-loader.ts";
import type { AgentTypeManifest } from "./agent-type-registry.ts";
import { AgentService, createAgent } from "./agents.ts";
import type { CreateAgentDeps } from "./agents.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

/** A minimal valid "coding" manifest, matching agents-api.integration.test.ts's fixture. */
const CODING_MANIFEST: AgentTypeManifest = {
  apiVersion: "shipwright.dev/v1alpha1",
  kind: "AgentType",
  metadata: {
    name: "coding",
    displayName: "Coding Agent",
    description: "test manifest",
    version: "1.0.0",
    skills: [],
  },
  identity: { templatesDir: "agent/workspace/" },
  crons: [],
  plugins: ["shipwright"],
  tools: ["Read", "Write", "Edit", "Bash"],
  env: { required: [], optional: [] },
  members: [],
  repos: [],
  chat: true,
  voice: true,
};

function fakeAgentTypeRegistry(
  byType: Record<string, AgentTypeManifest> = { coding: CODING_MANIFEST },
): AgentTypeManifestResolver {
  return {
    getManifest(typeName: string): AgentTypeManifest {
      return byType[typeName] ?? (byType.coding as AgentTypeManifest);
    },
    tryGetManifest(typeName: string): AgentTypeManifest | undefined {
      return byType[typeName];
    },
    listTypes() {
      return Object.keys(byType).map((name) => ({ name, displayName: name }));
    },
  };
}

function makeProvisioner(
  overrides: Partial<AgentProvisioner> = {},
): AgentProvisioner {
  return {
    canProvision: false,
    provision: async (): Promise<ProvisionResult> => ({
      resourceName: "r",
      secretName: "s",
      deploymentName: "d",
    }),
    deprovision: async () => {},
    reconcile: async () => ({
      recreated: [],
      updated: [],
      orphans: [],
      failed: [],
    }),
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof createAgent>[1]> = {}) {
  return {
    name: "Test Agent",
    typeName: "coding",
    runtime: undefined,
    reposRaw: undefined,
    authorAllowlistRaw: undefined,
    patchAuthorAllowlistRaw: undefined,
    memberEmailsRaw: undefined,
    restrictSlackToMembersRaw: undefined,
    claudeCodeOauthToken: undefined,
    anthropicApiKey: undefined,
    ...overrides,
  };
}

describeOrSkip("createAgent() — integration (real Postgres)", () => {
  let prisma: PrismaClient;
  let agentService: AgentService;
  let agentToolService: AgentToolService;
  let agentPluginService: AgentPluginService;
  let agentMemberService: AgentMemberService;
  let agentEnvService: AgentEnvService;
  let agentCronJobService: AgentCronJobService;

  beforeEach(async () => {
    prisma = makePrisma();
    agentService = new AgentService(prisma, fakeAgentTypeRegistry());
    agentToolService = new AgentToolService(prisma);
    agentPluginService = new AgentPluginService(prisma);
    agentMemberService = new AgentMemberService(prisma);
    agentEnvService = new AgentEnvService(prisma, makeTokenCrypto());
    // No crons in the fixture manifest, so reconcileSystemCrons() is a
    // deliberate no-op here — its own atomicity is covered by
    // agent-cron-jobs.unit.test.ts; this suite only needs it not to throw.
    agentCronJobService = new AgentCronJobService(
      prisma,
      undefined,
      fakeAgentTypeRegistry(),
    );

    // Truncate between tests — this suite shares a DB with every other
    // admin/src/*.integration.test.ts file (see docs/test-readiness/
    // test-system.md's "real per-run DB with truncate-between-tests"
    // convention, needed because several services already open their own
    // interactive $transaction internally).
    await prisma.agentTool.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function deps(overrides: Partial<CreateAgentDeps> = {}): CreateAgentDeps {
    return {
      agentService,
      agentToolService,
      agentPluginService,
      agentMemberService,
      agentEnvService,
      agentCronJobService,
      provisioner: makeProvisioner(),
      agentTypeRegistry: fakeAgentTypeRegistry(),
      ...overrides,
    };
  }

  it("happy path: creates the Agent row, seeds manifest tools/plugins, and attaches repos/allowlists/members — matching today's form-handler end state", async () => {
    const result = await createAgent(
      deps(),
      baseInput({
        reposRaw: "org/repo1\norg/repo2",
        authorAllowlistRaw: "octocat\nhubot",
        patchAuthorAllowlistRaw: "patcher1",
        memberEmailsRaw: "dev@example.com",
        restrictSlackToMembersRaw: "true",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.restrictSlackToMembers).toBe(true);

    const dbAgent = await prisma.agent.findUnique({
      where: { id: result.agent.id },
    });
    expect(dbAgent).not.toBeNull();
    expect(dbAgent?.repos).toEqual(["org/repo1", "org/repo2"]);
    expect(dbAgent?.reviewAuthorAllowlist).toEqual(["octocat", "hubot"]);
    expect(dbAgent?.patchAuthorAllowlist).toEqual(["patcher1"]);
    expect(dbAgent?.restrictSlackToMembers).toBe(true);

    const tools = await prisma.agentTool.findMany({
      where: { agentId: result.agent.id },
    });
    expect(tools.map((t) => t.pattern).sort()).toEqual(
      [...CODING_MANIFEST.tools].sort(),
    );

    const plugins = await prisma.agentPlugin.findMany({
      where: { agentId: result.agent.id },
    });
    expect(plugins.map((p) => p.name)).toEqual(["shipwright"]);

    const members = await prisma.agentMember.findMany({
      where: { agentId: result.agent.id },
    });
    expect(members.map((m) => m.email)).toEqual(["dev@example.com"]);
  });

  it("a failure at the tool-seeding step leaves ZERO Agent row behind in the real database (single-transaction rollback)", async () => {
    const failingAgentToolService = {
      add: async (): Promise<never> => {
        throw new Error("boom: tool seeding failed");
      },
    };

    const result = await createAgent(
      deps({ agentToolService: failingAgentToolService }),
      baseInput(),
    );

    expect(result).toEqual({ ok: false, errorCode: "seed_failed" });
    expect(await prisma.agent.findMany()).toEqual([]);
    expect(await prisma.agentTool.findMany()).toEqual([]);
    expect(await prisma.agentPlugin.findMany()).toEqual([]);
  });

  it("a failure at the plugin-seeding step leaves ZERO Agent row behind, including any tools already seeded in the same transaction", async () => {
    const failingAgentPluginService = {
      add: async (): Promise<never> => {
        throw new Error("boom: plugin seeding failed");
      },
    };

    const result = await createAgent(
      deps({ agentPluginService: failingAgentPluginService }),
      baseInput(),
    );

    expect(result).toEqual({ ok: false, errorCode: "seed_failed" });
    // Tools were seeded before the plugin step failed — proving the whole
    // sequence (not just the agent row) rolls back atomically.
    expect(await prisma.agent.findMany()).toEqual([]);
    expect(await prisma.agentTool.findMany()).toEqual([]);
  });

  it("invalid repo format leaves ZERO Agent row behind, including manifest-seeded tools/plugins", async () => {
    const result = await createAgent(
      deps(),
      baseInput({ reposRaw: "not a valid repo!!" }),
    );

    expect(result).toEqual({ ok: false, errorCode: "invalid_repo_format" });
    expect(await prisma.agent.findMany()).toEqual([]);
    expect(await prisma.agentTool.findMany()).toEqual([]);
    expect(await prisma.agentPlugin.findMany()).toEqual([]);
  });

  it("invalid author allowlist format leaves ZERO Agent row behind", async () => {
    const result = await createAgent(
      deps(),
      baseInput({ authorAllowlistRaw: "octocat\nnot a valid login!" }),
    );

    expect(result).toEqual({
      ok: false,
      errorCode: "invalid_author_allowlist_format",
    });
    expect(await prisma.agent.findMany()).toEqual([]);
  });

  it("a Kubernetes provisioning failure still deletes the Agent row, even though provisioning runs after the DB transaction already committed", async () => {
    const result = await createAgent(
      deps({
        provisioner: makeProvisioner({
          canProvision: true,
          provision: async () => {
            throw new Error("boom: no cluster reachable");
          },
        }),
      }),
      baseInput({ runtime: "in-cluster" }),
    );

    expect(result).toEqual({ ok: false, errorCode: "provision_failed" });
    expect(await prisma.agent.findMany()).toEqual([]);
    // Tools/plugins were seeded (and committed) before provisioning ran —
    // deleting the Agent row cascades and removes them too.
    expect(await prisma.agentTool.findMany()).toEqual([]);
    expect(await prisma.agentPlugin.findMany()).toEqual([]);
  });

  it("provisioning_disabled: requesting runtime=in-cluster with a provisioner that can't provision creates zero rows", async () => {
    const result = await createAgent(
      deps({ provisioner: makeProvisioner({ canProvision: false }) }),
      baseInput({ runtime: "in-cluster" }),
    );

    expect(result).toEqual({ ok: false, errorCode: "provisioning_disabled" });
    expect(await prisma.agent.findMany()).toEqual([]);
  });

  it("a reconcileSystemCrons() failure is non-fatal — the agent row survives and creation still succeeds", async () => {
    const failingAgentCronJobService = {
      reconcileSystemCrons: async (): Promise<never> => {
        throw new Error("boom: cron reconcile failed");
      },
    };

    const result = await createAgent(
      deps({ agentCronJobService: failingAgentCronJobService }),
      baseInput(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(await prisma.agent.findUnique({ where: { id: result.agent.id } })).not.toBeNull();
  });
});
