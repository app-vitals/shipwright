import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE_PATH = join(import.meta.dir, "product-spec-template.md");

let content: string;

beforeAll(() => {
  content = readFileSync(TEMPLATE_PATH, "utf-8");
});

describe("product-spec-template.md — numbered specs and repos (PLU-3.2)", () => {
  it("has a required Repos line in the spec skeleton", () => {
    expect(content).toMatch(/^\*\*Repos\*\*: \{org\/repo, org\/other\}$/m);
    expect(content).toMatch(/\*\*Repos\*\* \(required\)/);
  });

  it("starts the generated file with a header line naming session, repos and spec number", () => {
    expect(content).toContain(
      "<!-- shipwright: session={session} repos={org/repo,org/other} spec={NNNN} -->",
    );
  });

  it("gives every Source Map entry a repo", () => {
    const map = content.slice(
      content.indexOf("**Source Map**"),
      content.indexOf("**Testing Strategy**"),
    );
    const entries = map.split("\n").filter((l) => l.startsWith("- "));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^- `[\w.-]+\/[\w.-]+`: `/);
  });

  it("documents numbered file names with the legacy PRODUCT-SPEC.md as spec 1", () => {
    expect(content).toContain("SPEC-{NNNN}.md");
    expect(content).toMatch(/legacy `PRODUCT-SPEC\.md` is spec 1/);
  });

  it("states the owner is never written into the file", () => {
    expect(content).toMatch(/owner is never written into the file/);
  });
});

describe("committed spec/plan templates contain no email address", () => {
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const files = [
    TEMPLATE_PATH,
    join(import.meta.dir, "planning-doc-template.md"),
    join(import.meta.dir, "..", "commands", "prd.md"),
    join(import.meta.dir, "methodology-contracts", "prd.md"),
  ];
  for (const f of files) {
    it(`${f.slice(f.indexOf("plugins/"))} has no email address`, () => {
      expect(readFileSync(f, "utf-8")).not.toMatch(EMAIL);
    });
  }
});
