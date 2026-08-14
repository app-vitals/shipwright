/**
 * scripts/hitl.bootstrap.unit.test.ts
 * Unit tests for scripts/hitl.ts's bootstrap planners — the clone→seed→boot→poll
 * sequence (T-080).
 *
 * Mirrors the dev-tmux.unit.test.ts pattern: the orchestration is split into
 * pure builders (buildPreflightSteps / buildServiceSpecs) plus a thin executor
 * (runSteps), so we assert the exact ordered step sequence, argv, cwd, and env
 * through an INJECTED executor — without spawning gh, prisma, or the
 * long-running task-store/admin services. No mock.module(), no global.*
 * overrides, no real filesystem access (existence checks are injected).
 *
 * Why unit and not integration: the only behavior left below these builders is
 * I/O-bound (does the OS run this argv, does the service bind its port). That
 * seam is `execStep`, driven here by a recording fake. Booting the real
 * services would need Postgres and blow the integration speed budget for zero
 * added confidence over the sequence assertions. Recorded as a deliberate
 * layer decision in .claude/shipwright/test-readiness-decisions.md.
 *
 * Existing pure-helper coverage lives in scripts/hitl.unit.test.ts and is
 * untouched — this file adds the orchestration-sequence layer on top.
 */

import { describe, expect, test } from "bun:test";
import {
  ADMIN_PORT,
  type HitlConfig,
  type HitlStep,
  TASK_STORE_PORT,
  buildCloneSteps,
  buildHitlConfig,
  buildMigrationSteps,
  buildPrCommand,
  buildPreflightSteps,
  buildProvisionSteps,
  buildServiceSpecs,
  buildTokenSeedStep,
  runSteps,
} from "./hitl.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = "/repo";
const HOME = "/home/dev";

/** A config with no env overrides beyond the ones a test cares about. */
function cfg(env: Record<string, string | undefined> = {}): HitlConfig {
  return buildHitlConfig(env, HOME, REPO_ROOT);
}

/** Existence predicate over an explicit set — no filesystem access. */
function existsIn(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const nothingExists = () => false;
const everythingExists = () => true;

/** Records steps instead of performing them. */
function recorder() {
  const seen: HitlStep[] = [];
  return { seen, exec: (step: HitlStep) => void seen.push(step) };
}

// ---------------------------------------------------------------------------
// buildHitlConfig — the env→config mapping
// ---------------------------------------------------------------------------

describe("buildHitlConfig", () => {
  test("defaults hitlHome under the home dir and derives the workspace tree", () => {
    const c = cfg();
    expect(c.hitlHome).toBe("/home/dev/.shipwright");
    expect(c.workspace).toBe("/home/dev/.shipwright/workspace");
    expect(c.reposDir).toBe("/home/dev/.shipwright/workspace/repos");
    expect(c.worktreesDir).toBe("/home/dev/.shipwright/workspace/worktrees");
  });

  test("SHIPWRIGHT_HITL_HOME overrides the root and every derived path", () => {
    const c = cfg({ SHIPWRIGHT_HITL_HOME: "/custom/root" });
    expect(c.hitlHome).toBe("/custom/root");
    expect(c.workspace).toBe("/custom/root/workspace");
    expect(c.reposDir).toBe("/custom/root/workspace/repos");
  });

  test("defaults the host to localhost and builds service URLs from the ports", () => {
    const c = cfg();
    expect(c.host).toBe("localhost");
    expect(c.taskStoreUrl).toBe(`http://localhost:${TASK_STORE_PORT}`);
    expect(c.adminUrl).toBe(`http://localhost:${ADMIN_PORT}`);
  });

  test("SHIPWRIGHT_HITL_HOST rewrites both service URLs", () => {
    const c = cfg({ SHIPWRIGHT_HITL_HOST: "host.docker.internal" });
    expect(c.taskStoreUrl).toBe(
      `http://host.docker.internal:${TASK_STORE_PORT}`,
    );
    expect(c.adminUrl).toBe(`http://host.docker.internal:${ADMIN_PORT}`);
  });

  test("prefixes the Postgres URLs with USER when set", () => {
    const c = cfg({ USER: "alice" });
    expect(c.adminDatabaseUrl).toBe(
      "postgresql://alice@localhost:5432/shipwright_dev",
    );
    expect(c.taskStoreDatabaseUrl).toBe(
      "postgresql://alice@localhost:5432/shipwright_task_store_dev",
    );
  });

  test("omits the USER prefix entirely when USER is unset", () => {
    const c = cfg({});
    expect(c.adminDatabaseUrl).toBe(
      "postgresql://localhost:5432/shipwright_dev",
    );
    expect(c.taskStoreDatabaseUrl).toBe(
      "postgresql://localhost:5432/shipwright_task_store_dev",
    );
  });

  test("parses the repo and author allowlists, and the poll interval", () => {
    const c = cfg({
      SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright, app-vitals/other",
      SHIPWRIGHT_HITL_AUTHORS: "alice,bob",
      SHIPWRIGHT_HITL_POLL_INTERVAL: "15",
    });
    expect(c.repos).toEqual(["app-vitals/shipwright", "app-vitals/other"]);
    expect(c.authors).toEqual(["alice", "bob"]);
    expect(c.pollIntervalS).toBe(15);
  });

  test("defaults the poll interval to 60s", () => {
    expect(cfg().pollIntervalS).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Provision — the "seed" half of clone→seed
// ---------------------------------------------------------------------------

describe("buildProvisionSteps", () => {
  test("plans every dir plus both template seeds on a fresh workspace", () => {
    const steps = buildProvisionSteps(cfg(), nothingExists);
    expect(steps.filter((s) => s.kind === "mkdir").map((s) => s.path)).toEqual([
      "/home/dev/.shipwright/workspace",
      "/home/dev/.shipwright/workspace/repos",
      "/home/dev/.shipwright/workspace/worktrees",
      "/home/dev/.shipwright/workspace/state/reviews",
      "/home/dev/.shipwright/workspace/.claude",
    ]);

    const seeds = steps.filter((s) => s.kind === "seed-file");
    expect(seeds.map((s) => s.path)).toEqual([
      "/home/dev/.shipwright/workspace/CLAUDE.md",
      "/home/dev/.shipwright/workspace/state/agent-policy.md",
    ]);
    expect(seeds.map((s) => s.templatePath)).toEqual([
      "/repo/agent/workspace/CLAUDE-HITL.md.template",
      "/repo/agent/workspace/state/agent-policy.md.template",
    ]);
  });

  test("plans nothing when the workspace is already fully provisioned", () => {
    expect(buildProvisionSteps(cfg(), everythingExists)).toEqual([]);
  });

  test("plans only the dirs that are actually missing", () => {
    const c = cfg();
    const steps = buildProvisionSteps(
      c,
      existsIn([
        c.workspace,
        c.reposDir,
        `${c.workspace}/CLAUDE.md`,
        `${c.workspace}/state/agent-policy.md`,
      ]),
    );
    expect(steps.map((s) => s.path)).toEqual([
      "/home/dev/.shipwright/workspace/worktrees",
      "/home/dev/.shipwright/workspace/state/reviews",
      "/home/dev/.shipwright/workspace/.claude",
    ]);
  });

  test("seeds CLAUDE.md alone when only agent-policy.md already exists", () => {
    const c = cfg();
    const seeds = buildProvisionSteps(
      c,
      existsIn([`${c.workspace}/state/agent-policy.md`]),
    ).filter((s) => s.kind === "seed-file");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.path).toBe("/home/dev/.shipwright/workspace/CLAUDE.md");
  });

  test("mkdir steps always precede seed-file steps", () => {
    const kinds = buildProvisionSteps(cfg(), nothingExists).map((s) => s.kind);
    expect(kinds.lastIndexOf("mkdir")).toBeLessThan(kinds.indexOf("seed-file"));
  });
});

// ---------------------------------------------------------------------------
// Clone — missing-clone detection triggering `gh repo clone`
// ---------------------------------------------------------------------------

describe("buildCloneSteps", () => {
  test("plans a gh repo clone for each configured repo not yet present", () => {
    const c = cfg({
      SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright,app-vitals/other",
    });
    const steps = buildCloneSteps(c, nothingExists);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.argv).toEqual([
      "gh",
      "repo",
      "clone",
      "app-vitals/shipwright",
      "/home/dev/.shipwright/workspace/repos/shipwright",
    ]);
    expect(steps[0]?.cwd).toBe(REPO_ROOT);
    expect(steps[0]?.kind).toBe("clone");
  });

  test("skips repos already cloned under reposDir", () => {
    const c = cfg({
      SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright,app-vitals/other",
    });
    const steps = buildCloneSteps(
      c,
      existsIn(["/home/dev/.shipwright/workspace/repos/shipwright"]),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.argv?.[3]).toBe("app-vitals/other");
  });

  test("plans no clones when no repos are configured", () => {
    expect(buildCloneSteps(cfg(), nothingExists)).toEqual([]);
  });

  test("names the repo in the failure label so a failed clone is attributable", () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    expect(buildCloneSteps(c, nothingExists)[0]?.label).toBe(
      "gh repo clone failed for app-vitals/shipwright",
    );
  });

  test("carries a start-of-step progress message distinct from the failure label", () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    const step = buildCloneSteps(c, nothingExists)[0];
    expect(step?.startLabel).toBe(
      "cloning app-vitals/shipwright into /home/dev/.shipwright/workspace/repos/shipwright...",
    );
    expect(step?.startLabel).not.toBe(step?.label);
  });
});

// ---------------------------------------------------------------------------
// Migrations + token seed — the schema half of "seed"
// ---------------------------------------------------------------------------

describe("buildMigrationSteps", () => {
  test("orders task-store generate → migrate → token seed → admin generate → migrate", () => {
    const steps = buildMigrationSteps(cfg());
    expect(steps.map((s) => [s.cwd, s.argv?.slice(1, 4).join(" ")])).toEqual([
      ["/repo/task-store", "prisma generate --schema=prisma/schema.prisma"],
      ["/repo/task-store", "prisma migrate deploy"],
      [REPO_ROOT, "run /repo/scripts/seed-task-store-token.ts --db-url"],
      ["/repo/admin", "prisma generate --schema=prisma/schema.prisma"],
      ["/repo/admin", "prisma migrate deploy"],
    ]);
  });

  test("scopes each migrate step to its own service's DATABASE_URL", () => {
    const c = cfg({ USER: "alice" });
    const steps = buildMigrationSteps(c);
    expect(steps[1]?.env).toEqual({
      DATABASE_URL_SHIPWRIGHT_TASK_STORE:
        "postgresql://alice@localhost:5432/shipwright_task_store_dev",
    });
    expect(steps[4]?.env).toEqual({
      DATABASE_URL_SHIPWRIGHT_ADMIN:
        "postgresql://alice@localhost:5432/shipwright_dev",
    });
  });

  test("leaves generate steps env-free — they touch no database", () => {
    const steps = buildMigrationSteps(cfg());
    expect(steps[0]?.env).toBeUndefined();
    expect(steps[3]?.env).toBeUndefined();
  });

  test("seeds the admin token against an already-migrated task-store DB", () => {
    const steps = buildMigrationSteps(cfg());
    // The seed must come after the task-store migrate, or the table is absent.
    const migrateIdx = steps.findIndex((s) =>
      s.label.startsWith("task-store migrate"),
    );
    const seedIdx = steps.findIndex((s) => s.label === "admin token seed failed");
    expect(seedIdx).toBeGreaterThan(migrateIdx);
  });

  test("gives every step a start-of-step progress message distinct from its failure label", () => {
    const steps = buildMigrationSteps(cfg());
    for (const step of steps) {
      expect(step.startLabel).toBeTruthy();
      expect(step.startLabel).not.toBe(step.label);
    }
    expect(steps.map((s) => s.startLabel)).toEqual([
      "running task-store prisma generate...",
      "running task-store prisma migrate...",
      "seeding task-store admin token...",
      "running admin prisma generate...",
      "running admin prisma migrate...",
    ]);
  });
});

describe("buildTokenSeedStep", () => {
  test("omits --agent-id for the admin token", () => {
    const step = buildTokenSeedStep(cfg(), "admin-tok");
    expect(step.argv).toEqual([
      "bun",
      "run",
      "/repo/scripts/seed-task-store-token.ts",
      "--db-url",
      "postgresql://localhost:5432/shipwright_task_store_dev",
      "--token",
      "admin-tok",
    ]);
    expect(step.label).toBe("admin token seed failed");
    expect(step.startLabel).toBe("seeding task-store admin token...");
  });

  test("appends --agent-id for the repo-scoped agent token", () => {
    const step = buildTokenSeedStep(cfg(), "agent-tok", "agent-123");
    expect(step.argv?.slice(-2)).toEqual(["--agent-id", "agent-123"]);
    expect(step.label).toBe("agent token seed failed");
    expect(step.startLabel).toBe(
      "seeding task-store agent token (agentId: agent-123)...",
    );
  });
});

// ---------------------------------------------------------------------------
// The full preflight sequence — clone→seed, end to end
// ---------------------------------------------------------------------------

describe("buildPreflightSteps", () => {
  test("orders provision → clone → install-plugins → migrate on a fresh machine", () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    const kinds = buildPreflightSteps(c, nothingExists).map((s) => s.kind);
    expect(kinds).toEqual([
      "mkdir",
      "mkdir",
      "mkdir",
      "mkdir",
      "mkdir",
      "seed-file",
      "seed-file",
      "clone",
      "install-plugins",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
  });

  test("clones before installing plugins and migrating", () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    const kinds = buildPreflightSteps(c, nothingExists).map((s) => s.kind);
    expect(kinds.indexOf("clone")).toBeLessThan(kinds.indexOf("install-plugins"));
    expect(kinds.indexOf("install-plugins")).toBeLessThan(kinds.indexOf("exec"));
  });

  test("still runs plugins + migrations when nothing needs provisioning", () => {
    const kinds = buildPreflightSteps(cfg(), everythingExists).map(
      (s) => s.kind,
    );
    expect(kinds).toEqual([
      "install-plugins",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
  });
});

// ---------------------------------------------------------------------------
// runSteps — the executor seam
// ---------------------------------------------------------------------------

describe("runSteps", () => {
  test("drives every planned step through the injected executor, in order", async () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    const steps = buildPreflightSteps(c, nothingExists);
    const rec = recorder();

    await runSteps(steps, rec.exec);

    expect(rec.seen).toHaveLength(steps.length);
    expect(rec.seen.map((s) => s.kind)).toEqual(steps.map((s) => s.kind));
  });

  test("awaits an async executor before moving to the next step", async () => {
    const order: string[] = [];
    const steps: HitlStep[] = [
      { kind: "mkdir", label: "a", path: "/a" },
      { kind: "mkdir", label: "b", path: "/b" },
    ];

    await runSteps(steps, async (step) => {
      order.push(`start:${step.label}`);
      await Promise.resolve();
      order.push(`end:${step.label}`);
    });

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("propagates an executor failure and stops the sequence", async () => {
    const seen: string[] = [];
    const steps: HitlStep[] = [
      { kind: "exec", label: "first", argv: ["true"] },
      { kind: "exec", label: "boom", argv: ["false"] },
      { kind: "exec", label: "never", argv: ["true"] },
    ];

    await expect(
      runSteps(steps, (step) => {
        seen.push(step.label);
        if (step.label === "boom") throw new Error(step.label);
      }),
    ).rejects.toThrow("boom");

    expect(seen).toEqual(["first", "boom"]);
  });

  test("returns the steps it ran", async () => {
    const steps = buildMigrationSteps(cfg());
    expect(await runSteps(steps, () => {})).toEqual(steps);
  });

  test("exposes each exec/clone step's startLabel to the executor for progress logging", async () => {
    const c = cfg({ SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" });
    const steps = [...buildCloneSteps(c, nothingExists), ...buildMigrationSteps(c)];
    const startLabels: (string | undefined)[] = [];

    await runSteps(steps, (step) => {
      startLabels.push(step.startLabel);
    });

    // Every clone/exec step in the preflight sequence carries a distinct
    // start-of-step message a real executor can log before spawning.
    expect(startLabels).toHaveLength(steps.length);
    expect(startLabels.every((s) => typeof s === "string" && s.length > 0)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Boot — service specs, without booting anything
// ---------------------------------------------------------------------------

describe("buildServiceSpecs", () => {
  test("plans task-store first, then admin", () => {
    expect(buildServiceSpecs(cfg(), {}).map((s) => s.label)).toEqual([
      "task-store",
      "admin",
    ]);
  });

  test("points each service at its own entrypoint from the repo root", () => {
    const [taskStore, admin] = buildServiceSpecs(cfg(), {});
    expect(taskStore?.argv).toEqual([
      "bun",
      "run",
      "/repo/task-store/src/main.ts",
    ]);
    expect(admin?.argv).toEqual(["bun", "/repo/admin/src/main.ts"]);
    expect(taskStore?.cwd).toBe(REPO_ROOT);
    expect(admin?.cwd).toBe(REPO_ROOT);
  });

  test("gives each service its own port and database", () => {
    const [taskStore, admin] = buildServiceSpecs(cfg({ USER: "alice" }), {});
    expect(taskStore?.env.PORT).toBe(String(TASK_STORE_PORT));
    expect(taskStore?.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE).toBe(
      "postgresql://alice@localhost:5432/shipwright_task_store_dev",
    );
    expect(admin?.env.PORT).toBe(String(ADMIN_PORT));
    expect(admin?.env.DATABASE_URL_SHIPWRIGHT_ADMIN).toBe(
      "postgresql://alice@localhost:5432/shipwright_dev",
    );
    expect(admin?.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE).toBeUndefined();
  });

  test("cross-wires the two services' URLs and shared dev credentials", () => {
    const c = cfg();
    const [taskStore, admin] = buildServiceSpecs(c, {});
    // task-store calls admin for agent lookups; admin calls task-store for tasks.
    expect(taskStore?.env.SHIPWRIGHT_TASK_STORE_AGENTS_URL).toBe(c.adminUrl);
    expect(admin?.env.SHIPWRIGHT_TASK_STORE_URL).toBe(c.taskStoreUrl);
    // Both ends of the admin API key must agree.
    expect(admin?.env.SHIPWRIGHT_ADMIN_API_KEYS).toContain(
      taskStore?.env.SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY as string,
    );
    // The token task-store seeds is the one admin authenticates with.
    expect(admin?.env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN).toBe(
      taskStore?.env.TASK_STORE_SEED_ADMIN_TOKEN,
    );
  });

  test("honors SHIPWRIGHT_HITL_HOST in the cross-wired URLs", () => {
    const c = cfg({ SHIPWRIGHT_HITL_HOST: "host.docker.internal" });
    const [taskStore, admin] = buildServiceSpecs(c, {});
    expect(taskStore?.env.SHIPWRIGHT_TASK_STORE_AGENTS_URL).toBe(
      `http://host.docker.internal:${ADMIN_PORT}`,
    );
    expect(admin?.env.SHIPWRIGHT_TASK_STORE_URL).toBe(
      `http://host.docker.internal:${TASK_STORE_PORT}`,
    );
  });

  test("runs admin in dev-auth mode with dummy crypto material", () => {
    const [, admin] = buildServiceSpecs(cfg(), {});
    expect(admin?.env.ADMIN_DEV_AUTH).toBe("true");
    expect(admin?.env.SHIPWRIGHT_ENCRYPTION_KEY).toMatch(/^0{64}$/);
    expect(admin?.env.SHIPWRIGHT_SESSION_SECRET).toContain("not-for-production");
  });

  test("overlays onto the base env rather than replacing it", () => {
    const [taskStore] = buildServiceSpecs(cfg(), {
      PATH: "/usr/bin",
      HOME: "/home/dev",
    });
    expect(taskStore?.env.PATH).toBe("/usr/bin");
    expect(taskStore?.env.HOME).toBe("/home/dev");
  });

  test("service-specific values win over a conflicting base env", () => {
    const [taskStore] = buildServiceSpecs(cfg(), { PORT: "9999" });
    expect(taskStore?.env.PORT).toBe(String(TASK_STORE_PORT));
  });

  test("drops undefined base-env entries instead of passing them through", () => {
    const [taskStore] = buildServiceSpecs(cfg(), { UNSET: undefined });
    expect(Object.keys(taskStore?.env ?? {})).not.toContain("UNSET");
  });

  test("does not mutate the base env object", () => {
    const base = { PATH: "/usr/bin" };
    buildServiceSpecs(cfg(), base);
    expect(base).toEqual({ PATH: "/usr/bin" });
  });
});

// ---------------------------------------------------------------------------
// Poll → dispatch
// ---------------------------------------------------------------------------

describe("buildPrCommand", () => {
  test("routes a review-phase candidate to /shipwright:review", () => {
    expect(
      buildPrCommand("app-vitals/shipwright#42", "review", {
        id: "pr-1",
        commitSha: "abc123",
      }),
    ).toBe("/shipwright:review app-vitals/shipwright#42 [preclaim:pr-1:abc123]");
  });

  test("routes a patch-phase candidate to /shipwright:patch", () => {
    expect(
      buildPrCommand("app-vitals/shipwright#42", "patch", {
        id: "pr-1",
        commitSha: "abc123",
      }),
    ).toBe("/shipwright:patch app-vitals/shipwright#42 [preclaim:pr-1:abc123]");
  });

  test("stamps the pre-claim marker so the command skips its own self-claim", () => {
    const cmd = buildPrCommand("app-vitals/shipwright#7", "review", {
      id: "claim-9",
      commitSha: "deadbee",
    });
    expect(cmd).toContain("[preclaim:claim-9:deadbee]");
  });
});
