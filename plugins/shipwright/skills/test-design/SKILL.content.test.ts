import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const SPEED_BUDGETS_SKILL_MD_PATH = join(
  import.meta.dir,
  "..",
  "speed-budgets",
  "SKILL.md",
);

let content: string;
let speedBudgetsContent: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
  speedBudgetsContent = existsSync(SPEED_BUDGETS_SKILL_MD_PATH)
    ? readFileSync(SPEED_BUDGETS_SKILL_MD_PATH, "utf-8")
    : "";
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: test-design", () => {
    expect(content).toContain("name: test-design");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — Step 6: default CI shape is one job per layer", () => {
  it("states the default shape is one job per layer, not per workspace", () => {
    const hasOneJobPerLayer =
      content.includes("one job per layer") ||
      content.includes("one job per layer, not one job per workspace") ||
      (content.includes("job per layer") && content.includes("job per workspace"));
    expect(hasOneJobPerLayer).toBe(true);
  });

  it("names the default layer jobs (unit-all, integration-all, smoke-all)", () => {
    const hasLayerJobNames =
      content.includes("unit-all") &&
      content.includes("integration-all") &&
      content.includes("smoke-all");
    expect(hasLayerJobNames).toBe(true);
  });

  it("frames per-workspace matrix sharding as an explicit override, not the default", () => {
    const hasOverrideLanguage =
      /override/i.test(content) &&
      (content.includes("per-workspace") || content.includes("per workspace"));
    expect(hasOverrideLanguage).toBe(true);
  });
});

describe("SKILL.md — Step 6: threshold conditions for per-workspace sharding", () => {
  it("condition (a): combined layer suite can't hit its speed budget in one job", () => {
    const hasBudgetCondition =
      /speed budget/i.test(content) &&
      (content.includes("can't hit") ||
        content.includes("cannot hit") ||
        content.includes("can't meet") ||
        content.includes("cannot meet") ||
        content.includes("in one job"));
    expect(hasBudgetCondition).toBe(true);
  });

  it("condition (b): a specific workspace has documented flake/slowness history worth isolating", () => {
    const hasFlakeCondition =
      /flak(e|y|iness)/i.test(content) &&
      /slow(ness)?/i.test(content) &&
      (content.includes("isolat") || content.includes("history"));
    expect(hasFlakeCondition).toBe(true);
  });

  it("condition (c): projected wall-clock savings exceed roughly 2x the added fixed per-job overhead", () => {
    const hasOverheadCondition =
      (content.includes("2x") || content.includes("2×") || content.includes("twice")) &&
      /overhead/i.test(content) &&
      (content.includes("wall-clock") || content.includes("wall clock") || content.includes("wall time"));
    expect(hasOverheadCondition).toBe(true);
  });

  it("mentions checkout+setup+install and container init as sources of fixed per-job overhead", () => {
    const hasOverheadSources =
      content.includes("checkout") &&
      content.includes("setup") &&
      content.includes("install") &&
      /container init/i.test(content);
    expect(hasOverheadSources).toBe(true);
  });
});

describe("SKILL.md — Step 6 subsection placement", () => {
  it("has a subsection heading for per-workspace matrix sharding near Step 6", () => {
    const step6Idx = content.indexOf("### Step 6");
    const step7Idx = content.indexOf("### Step 7");
    expect(step6Idx).toBeGreaterThan(-1);
    expect(step7Idx).toBeGreaterThan(step6Idx);
    const step6Section = content.slice(step6Idx, step7Idx);
    const hasSubsection =
      /per-workspace matrix sharding/i.test(step6Section) &&
      /override/i.test(step6Section);
    expect(hasSubsection).toBe(true);
  });
});

describe("SKILL.md — Failure modes: Phase 2 recommendations are estimates, not verified coverage facts", () => {
  let failureModesIdx: number;
  let section: string;

  beforeAll(() => {
    failureModesIdx = content.indexOf("## Failure modes to avoid");
    section = content.slice(failureModesIdx);
  });

  it("has a failure-mode bullet placed right after the 'Don't look at existing tests' bullet", () => {
    expect(failureModesIdx).toBeGreaterThan(-1);
    const dontLookIdx = content.indexOf(
      "Don't look at existing tests.",
      failureModesIdx,
    );
    expect(dontLookIdx).toBeGreaterThan(-1);
    const nextBulletIdx = content.indexOf("\n- **", dontLookIdx);
    expect(nextBulletIdx).toBeGreaterThan(-1);
    const bulletSection = content.slice(dontLookIdx, nextBulletIdx);
    expect(bulletSection.length).toBeGreaterThan(0);
  });

  it("warns that recommendations describe target state, not verified existing coverage, since this phase never reads existing tests", () => {
    const hasEstimateFramingLanguage =
      /\brecommend(ation)?s?\b/i.test(section) &&
      (/\bestimate\b/i.test(section) || /\btarget state\b/i.test(section)) &&
      /\bnot\b.*\b(a )?(verified|confirmed) fact\b/i.test(section);
    expect(hasEstimateFramingLanguage).toBe(true);
  });

  it("instructs downstream consumers to verify actual coverage against the working tree before trusting it", () => {
    const hasVerifyAgainstWorkingTree =
      /\bverify\b/i.test(section) && /\bworking tree\b/i.test(section);
    expect(hasVerifyAgainstWorkingTree).toBe(true);
  });

  it("names at least one downstream consumer phase/actor (Phase 3, Phase 4, or a task implementer) that must do the verification", () => {
    const namesDownstreamConsumer =
      /Phase 3/.test(section) ||
      /Phase 4/.test(section) ||
      /implement(ing|er)?/i.test(section);
    expect(namesDownstreamConsumer).toBe(true);
  });

  it("does not name a specific repo or use dated/cycle-specific framing", () => {
    expect(/this cycle/i.test(section)).toBe(false);
  });
});

describe("speed-budgets/SKILL.md — cross-references test-design Step 6 rule instead of duplicating it", () => {
  it("references test-design/SKILL.md", () => {
    expect(speedBudgetsContent).toContain("test-design");
  });

  it("points to Step 6 or the threshold rule specifically, not just the file name", () => {
    const hasSpecificPointer =
      speedBudgetsContent.includes("Step 6") ||
      /threshold/i.test(speedBudgetsContent);
    expect(hasSpecificPointer).toBe(true);
  });

  it("does not duplicate the three threshold conditions' prose (no '2x' overhead language here)", () => {
    const parallelSectionIdx = speedBudgetsContent.indexOf(
      "Why parallelization is prescribed, not assumed",
    );
    expect(parallelSectionIdx).toBeGreaterThan(-1);
    const nextSectionIdx = speedBudgetsContent.indexOf(
      "\n## ",
      parallelSectionIdx,
    );
    const section = speedBudgetsContent.slice(
      parallelSectionIdx,
      nextSectionIdx === -1 ? undefined : nextSectionIdx,
    );
    const hasDuplicatedOverheadProse =
      (section.includes("2x") || section.includes("2×")) &&
      /overhead/i.test(section);
    expect(hasDuplicatedOverheadProse).toBe(false);
  });
});
