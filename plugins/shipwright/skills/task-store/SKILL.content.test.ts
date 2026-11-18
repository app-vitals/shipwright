import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const README_MD_PATH = join(import.meta.dir, "../../README.md");

let skillContent: string;
let readmeContent: string;

beforeAll(() => {
  skillContent = readFileSync(SKILL_MD_PATH, "utf-8");
  readmeContent = readFileSync(README_MD_PATH, "utf-8");
});

describe("SKILL.md — local task store setup (CRQ-1.2)", () => {
  it("points at scripts/doctor.sh and docs/task-store.md instead of inlining local setup", () => {
    expect(skillContent).toContain("scripts/doctor.sh");
    expect(skillContent).toContain("docs/task-store.md");
    expect(skillContent).not.toContain("### Local / HITL Setup");
  });

  it("does not mention 'contact your administrator' for setup", () => {
    expect(skillContent).not.toMatch(/contact your administrator/i);
  });

  it("still mentions managed/deployed setups and admin token minting", () => {
    expect(skillContent).toMatch(/managed|deployed/i);
    expect(skillContent).toContain("SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN");
  });

  it("keeps the Setup env check and the Managed section", () => {
    const setupSection = skillContent.match(
      /## Setup[\s\S]*?(?=## Authentication)/,
    );
    expect(setupSection).not.toBeNull();
    const section = setupSection?.[0] ?? "";
    expect(section).toContain("SHIPWRIGHT_TASK_STORE_URL:-(missing)");
    expect(section).toContain("Managed");
  });
});

describe("SKILL.md — Authentication section updates (CRQ-1.2)", () => {
  it("updates the Authentication section to cover both local and managed setups", () => {
    expect(skillContent).toMatch(/locally.*scripts\/local-store\.sh/i) ||
      expect(skillContent).toContain("Locally") ||
      expect(skillContent).toContain("managed agents");
  });

  it("mentions provisioning by agent harness for managed setups", () => {
    expect(skillContent).toContain("agent harness");
  });
});

describe("README.md — Task Store section updates (CRQ-1.2)", () => {
  it("contains scripts/local-store.sh in the Task Store section", () => {
    const taskStoreStart = readmeContent.indexOf("## Task Store");
    const nextSection = readmeContent.indexOf("\n## ", taskStoreStart + 1);
    const section = readmeContent.substring(taskStoreStart, nextSection);
    expect(section).toContain("scripts/local-store.sh");
  });

  it("includes a Quickstart (Local) section", () => {
    expect(readmeContent).toMatch(/### Quickstart \(Local\)/);
  });

  it("includes the eval command for local setup", () => {
    expect(readmeContent).toContain('eval "$(./scripts/local-store.sh)"');
  });

  it("mentions --down for tearing down the local stack", () => {
    const taskStoreStart = readmeContent.indexOf("## Task Store");
    const nextSection = readmeContent.indexOf("\n## ", taskStoreStart + 1);
    const section = readmeContent.substring(taskStoreStart, nextSection);
    expect(section).toContain("./scripts/local-store.sh --down");
  });

  it("includes a Managed / Deployed section", () => {
    const taskStoreStart = readmeContent.indexOf("## Task Store");
    const nextSection = readmeContent.indexOf("\n## ", taskStoreStart + 1);
    const section = readmeContent.substring(taskStoreStart, nextSection);
    expect(section).toMatch(/Managed|Deployed/);
  });
});

describe("SKILL.md — cron origin convention (SCM-8.2)", () => {
  it("documents originKind cron + originRef = system-cron definition id for cron follow-on tasks", () => {
    const section = skillContent.slice(
      skillContent.indexOf("### Append new tasks"),
    );
    expect(section).toContain('originKind: "cron"');
    expect(section).toContain("system-cron definition id");
    expect(section).toContain("test-readiness");
    expect(section).toContain("docs-freshness");
    expect(section).toContain("--origin-cron");
  });
});
