import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH_REQUIRED_STEPS_PATH = join(import.meta.dir, "patch.json");
const DEV_TASK_REQUIRED_STEPS_PATH = join(import.meta.dir, "dev-task.json");
const PATCH_MD_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "commands",
  "patch.md",
);

interface RequiredStep {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  proofOfRunning: string;
  measurable: boolean;
  lane?: "any" | "review" | "conflict" | "ci";
}

interface RequiredStepsFile {
  steps: RequiredStep[];
}

let patchRequiredStepsContent: RequiredStepsFile | null = null;
let devTaskRequiredStepsContent: RequiredStepsFile | null = null;
let patchMdContent: string = "";

function loadPatchRequiredSteps(): RequiredStepsFile | null {
  if (!existsSync(PATCH_REQUIRED_STEPS_PATH)) {
    return null;
  }
  const content = readFileSync(PATCH_REQUIRED_STEPS_PATH, "utf-8");
  return JSON.parse(content) as RequiredStepsFile;
}

function loadDevTaskRequiredSteps(): RequiredStepsFile | null {
  if (!existsSync(DEV_TASK_REQUIRED_STEPS_PATH)) {
    return null;
  }
  const content = readFileSync(DEV_TASK_REQUIRED_STEPS_PATH, "utf-8");
  return JSON.parse(content) as RequiredStepsFile;
}

function loadPatchMd(): string {
  return readFileSync(PATCH_MD_PATH, "utf-8");
}

describe("patch.json — file structure and schema", () => {
  it("file exists", () => {
    expect(existsSync(PATCH_REQUIRED_STEPS_PATH)).toBe(true);
  });

  it("parses as valid JSON", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    expect(patchRequiredStepsContent).not.toBeNull();
  });

  it("has a top-level 'steps' array", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    expect(patchRequiredStepsContent?.steps).toBeDefined();
    expect(Array.isArray(patchRequiredStepsContent?.steps)).toBe(true);
  });

  it("contains at least one step", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    expect(patchRequiredStepsContent?.steps?.length).toBeGreaterThan(0);
  });

  it("each step has required fields: stepNumber, title, mandatory, proofOfRunning, measurable, lane", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    patchRequiredStepsContent?.steps?.forEach((step) => {
      expect(step.stepNumber).toBeDefined();
      expect(step.title).toBeDefined();
      expect(typeof step.mandatory).toBe("boolean");
      expect(step.proofOfRunning).toBeDefined();
      expect(typeof step.measurable).toBe("boolean");
      expect(step.lane).toBeDefined();
    });
  });

  it("lane field is in the allowed set: any, review, conflict, or ci", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const allowedLanes = ["any", "review", "conflict", "ci"];
    patchRequiredStepsContent?.steps?.forEach((step) => {
      expect(allowedLanes).toContain(step.lane);
    });
  });

  it("stepNumber is a string", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    patchRequiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.stepNumber).toBe("string");
    });
  });

  it("title is a non-empty string", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    patchRequiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.title).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);
    });
  });

  it("proofOfRunning is a non-empty string", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    patchRequiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.proofOfRunning).toBe("string");
      expect(step.proofOfRunning.length).toBeGreaterThan(0);
    });
  });
});

describe("patch.json — fix-subagent dispatch steps", () => {
  it("steps 4b, 5b, 6c are present", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const stepNumbers = patchRequiredStepsContent?.steps?.map((s) => s.stepNumber);
    expect(stepNumbers).toContain("4b");
    expect(stepNumbers).toContain("5b");
    expect(stepNumbers).toContain("6c");
  });

  it("step 4b has lane: conflict, measurable: true, and 'agent' in proofOfRunning", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step4b = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "4b",
    );
    expect(step4b?.lane).toBe("conflict");
    expect(step4b?.measurable).toBe(true);
    expect(step4b?.proofOfRunning.toLowerCase()).toContain("agent");
  });

  it("step 5b has lane: review, measurable: true, and 'agent' in proofOfRunning", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step5b = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5b",
    );
    expect(step5b?.lane).toBe("review");
    expect(step5b?.measurable).toBe(true);
    expect(step5b?.proofOfRunning.toLowerCase()).toContain("agent");
  });

  it("step 6c has lane: ci, measurable: true, and 'agent' in proofOfRunning", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step6c = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6c",
    );
    expect(step6c?.lane).toBe("ci");
    expect(step6c?.measurable).toBe(true);
    expect(step6c?.proofOfRunning.toLowerCase()).toContain("agent");
  });

  it("steps 4b, 5b, 6c note that sed-style or inline fixes count as skipping the subagent", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const dispatchSteps = ["4b", "5b", "6c"];
    patchRequiredStepsContent?.steps?.forEach((step) => {
      if (dispatchSteps.includes(step.stepNumber)) {
        expect(
          step.proofOfRunning.toLowerCase().includes("sed-style") ||
            step.proofOfRunning.toLowerCase().includes("inline"),
        ).toBe(true);
      }
    });
  });
});

describe("patch.json — escalation guard steps", () => {
  it("escalation guard steps 5a.6b, 5a.7, 6b.6 are present", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const stepNumbers = patchRequiredStepsContent?.steps?.map((s) => s.stepNumber);
    expect(stepNumbers).toContain("5a.6b");
    expect(stepNumbers).toContain("5a.7");
    expect(stepNumbers).toContain("6b.6");
  });

  it("escalation guard steps have measurable: false and 'marker needed' or 'unmeasured' in proofOfRunning", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const escalationSteps = ["5a.6b", "5a.7", "6b.6"];
    patchRequiredStepsContent?.steps?.forEach((step) => {
      if (escalationSteps.includes(step.stepNumber)) {
        expect(step.measurable).toBe(false);
        const proof = step.proofOfRunning.toLowerCase();
        expect(proof.includes("marker") || proof.includes("unmeasured")).toBe(
          true,
        );
      }
    });
  });
});

describe("patch.json — step titles match patch.md headings", () => {
  it("reads patch.md successfully", () => {
    patchMdContent = loadPatchMd();
    expect(patchMdContent.length).toBeGreaterThan(0);
  });

  it("step 4a.6 title matches '### Step 4a.6: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "4a.6",
    );
    const heading = patchMdContent.match(/### Step 4a\.6: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(
      headingText.split("(")[0].trim().split(":")[0],
    );
  });

  it("step 4b title matches '### Step 4b: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "4b",
    );
    const heading = patchMdContent.match(/### Step 4b: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 4c.5 title matches '### Step 4c.5: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "4c.5",
    );
    const heading = patchMdContent.match(/### Step 4c\.5: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 5a.6 title matches '### Step 5a.6: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5a.6",
    );
    const heading = patchMdContent.match(/### Step 5a\.6: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(
      headingText.split("(")[0].trim().split(":")[0],
    );
  });

  it("step 5a.6b title matches '### Step 5a.6b: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5a.6b",
    );
    const heading = patchMdContent.match(/### Step 5a\.6b: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split("(")[0].trim());
  });

  it("step 5a.7 title matches '### Step 5a.7: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5a.7",
    );
    const heading = patchMdContent.match(/### Step 5a\.7: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split("(")[0].trim());
  });

  it("step 5b title matches '### Step 5b: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5b",
    );
    const heading = patchMdContent.match(/### Step 5b: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 5c.5 title matches '### Step 5c.5: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5c.5",
    );
    const heading = patchMdContent.match(/### Step 5c\.5: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 6b.5 title matches '### Step 6b.5: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6b.5",
    );
    const heading = patchMdContent.match(/### Step 6b\.5: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(
      headingText.split("(")[0].trim().split(":")[0],
    );
  });

  it("step 6b.6 title matches '### Step 6b.6: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6b.6",
    );
    const heading = patchMdContent.match(/### Step 6b\.6: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split("(")[0].trim());
  });

  it("step 6c title matches '### Step 6c: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6c",
    );
    const heading = patchMdContent.match(/### Step 6c: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 6d.5 title matches '### Step 6d.5: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6d.5",
    );
    const heading = patchMdContent.match(/### Step 6d\.5: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });

  it("step 6.5 title matches '## Step 6.5: ...' heading", () => {
    patchRequiredStepsContent = loadPatchRequiredSteps();
    const step = patchRequiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6.5",
    );
    const heading = patchMdContent.match(/## Step 6\.5: (.+)/);
    expect(heading).not.toBeNull();
    const headingText = heading?.[1] || "";
    expect(step?.title).toContain(headingText.split(":")[0]);
  });
});

describe("patch.json — dev-task.json has no lane field", () => {
  it("dev-task.json exists and parses", () => {
    devTaskRequiredStepsContent = loadDevTaskRequiredSteps();
    expect(devTaskRequiredStepsContent).not.toBeNull();
  });

  it("dev-task.json steps do not have a lane field", () => {
    devTaskRequiredStepsContent = loadDevTaskRequiredSteps();
    devTaskRequiredStepsContent?.steps?.forEach((step) => {
      expect("lane" in step).toBe(false);
    });
  });
});
