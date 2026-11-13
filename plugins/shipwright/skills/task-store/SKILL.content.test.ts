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
  it("contains scripts/local-store.sh in the Setup section", () => {
    expect(skillContent).toContain("scripts/local-store.sh");
  });

  it("does not mention 'contact your administrator' for setup", () => {
    expect(skillContent).not.toMatch(/contact your administrator/i);
  });

  it("still mentions managed/deployed setups and admin token minting", () => {
    expect(skillContent).toMatch(/managed|deployed/i);
    expect(skillContent).toContain("SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN");
  });

  it("includes example usage: eval '$(./scripts/local-store.sh)'", () => {
    expect(skillContent).toContain('eval "$(./scripts/local-store.sh)"');
  });

  it("documents the --down flag for tearing down the local stack", () => {
    expect(skillContent).toContain("./scripts/local-store.sh --down");
  });

  it("clarifies that local setup via scripts/local-store.sh does not require admin token minting", () => {
    const setupSection = skillContent.match(
      /## Setup[\s\S]*?(?=## Authentication)/
    );
    expect(setupSection).not.toBeNull();
    const section = setupSection?.[0] ?? "";
    // Should mention local-store.sh doesn't require admin token
    expect(section).toContain("scripts/local-store.sh");
    // Admin token should only appear in the "Managed" subsection
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
    expect(readmeContent).toContain(
      'eval "$(./scripts/local-store.sh)"'
    );
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
