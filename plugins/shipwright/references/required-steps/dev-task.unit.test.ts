import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_STEPS_PATH = join(import.meta.dir, "dev-task.json");
const DEV_TASK_MD_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "commands",
  "dev-task.md",
);

interface RequiredStep {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  proofOfRunning: string;
  measurable: boolean;
}

interface RequiredStepsFile {
  steps: RequiredStep[];
}

let requiredStepsContent: RequiredStepsFile | null = null;
let devTaskMdContent: string = "";

function loadRequiredSteps(): RequiredStepsFile | null {
  if (!existsSync(REQUIRED_STEPS_PATH)) {
    return null;
  }
  const content = readFileSync(REQUIRED_STEPS_PATH, "utf-8");
  return JSON.parse(content) as RequiredStepsFile;
}

function loadDevTaskMd(): string {
  return readFileSync(DEV_TASK_MD_PATH, "utf-8");
}

describe("dev-task.json — file structure and schema", () => {
  it("file exists", () => {
    expect(existsSync(REQUIRED_STEPS_PATH)).toBe(true);
  });

  it("parses as valid JSON", () => {
    requiredStepsContent = loadRequiredSteps();
    expect(requiredStepsContent).not.toBeNull();
  });

  it("has a top-level 'steps' array", () => {
    requiredStepsContent = loadRequiredSteps();
    expect(requiredStepsContent?.steps).toBeDefined();
    expect(Array.isArray(requiredStepsContent?.steps)).toBe(true);
  });

  it("contains exactly 9 steps (5, 6, 6.5, 7, 8, 8.5, 9, 9b, 10)", () => {
    requiredStepsContent = loadRequiredSteps();
    expect(requiredStepsContent?.steps?.length).toBe(9);
  });

  it("each step has required fields: stepNumber, title, mandatory, proofOfRunning, measurable", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      expect(step.stepNumber).toBeDefined();
      expect(step.title).toBeDefined();
      expect(typeof step.mandatory).toBe("boolean");
      expect(step.proofOfRunning).toBeDefined();
      expect(typeof step.measurable).toBe("boolean");
    });
  });

  it("stepNumber is a string (e.g., '5', '6.5', '9b')", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.stepNumber).toBe("string");
    });
  });

  it("title is a non-empty string", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.title).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);
    });
  });

  it("proofOfRunning is a non-empty string", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      expect(typeof step.proofOfRunning).toBe("string");
      expect(step.proofOfRunning.length).toBeGreaterThan(0);
    });
  });
});

describe("dev-task.json — step sequence and content", () => {
  it("contains steps in the correct order: 5, 6, 6.5, 7, 8, 8.5, 9, 9b, 10", () => {
    requiredStepsContent = loadRequiredSteps();
    const stepNumbers = requiredStepsContent?.steps?.map((s) => s.stepNumber);
    expect(stepNumbers).toEqual([
      "5",
      "6",
      "6.5",
      "7",
      "8",
      "8.5",
      "9",
      "9b",
      "10",
    ]);
  });

  it("all steps except 9b have mandatory: true", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      if (step.stepNumber === "9b") {
        expect(step.mandatory).toBe(false);
      } else {
        expect(step.mandatory).toBe(true);
      }
    });
  });

  it("steps 5, 6.5, and 8.5 have agent dispatch in proofOfRunning", () => {
    requiredStepsContent = loadRequiredSteps();
    const agentSteps = ["5", "6.5", "8.5"];
    requiredStepsContent?.steps?.forEach((step) => {
      if (agentSteps.includes(step.stepNumber)) {
        expect(step.proofOfRunning.toLowerCase()).toContain("agent");
      }
    });
  });

  it("steps 6 and 7 have 'marker needed' or 'unmeasured' in proofOfRunning", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      if (step.stepNumber === "6" || step.stepNumber === "7") {
        const proof = step.proofOfRunning.toLowerCase();
        expect(proof.includes("marker") || proof.includes("unmeasured")).toBe(
          true,
        );
      }
    });
  });

  it("steps 6 and 7 have measurable: false", () => {
    requiredStepsContent = loadRequiredSteps();
    requiredStepsContent?.steps?.forEach((step) => {
      if (step.stepNumber === "6" || step.stepNumber === "7") {
        expect(step.measurable).toBe(false);
      }
    });
  });

  it("step 8.5 mentions docs-refresher dispatch", () => {
    requiredStepsContent = loadRequiredSteps();
    const step85 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "8.5",
    );
    expect(step85?.proofOfRunning.toLowerCase()).toContain("docs-refresher");
  });
});

describe("dev-task.json — step titles match dev-task.md headings", () => {
  it("reads dev-task.md successfully", () => {
    devTaskMdContent = loadDevTaskMd();
    expect(devTaskMdContent.length).toBeGreaterThan(0);
  });

  it("step 5 title matches '## Step 5: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    devTaskMdContent = loadDevTaskMd();
    const step5 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "5",
    );
    const step5Heading = devTaskMdContent.match(/## Step 5: (.+)/);
    expect(step5Heading).not.toBeNull();
    expect(step5?.title).toContain(step5Heading?.[1].split(":")[0] || "");
  });

  it("step 6 title matches '## Step 6: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step6 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6",
    );
    const step6Heading = devTaskMdContent.match(/## Step 6: (.+)/);
    expect(step6Heading).not.toBeNull();
    expect(step6?.title).toContain(step6Heading?.[1].split(":")[0] || "");
  });

  it("step 6.5 title matches '## Step 6.5: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step65 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "6.5",
    );
    const step65Heading = devTaskMdContent.match(/## Step 6\.5: (.+)/);
    expect(step65Heading).not.toBeNull();
    expect(step65?.title).toContain(step65Heading?.[1].split(":")[0] || "");
  });

  it("step 7 title matches '## Step 7: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step7 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "7",
    );
    const step7Heading = devTaskMdContent.match(/## Step 7: (.+)/);
    expect(step7Heading).not.toBeNull();
    expect(step7?.title).toContain(step7Heading?.[1].split(":")[0] || "");
  });

  it("step 8 title matches '## Step 8: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step8 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "8",
    );
    const step8Heading = devTaskMdContent.match(/## Step 8: (.+)/);
    expect(step8Heading).not.toBeNull();
    expect(step8?.title).toContain(step8Heading?.[1].split(":")[0] || "");
  });

  it("step 8.5 title matches '## Step 8.5: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step85 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "8.5",
    );
    const step85Heading = devTaskMdContent.match(/## Step 8\.5: (.+)/);
    expect(step85Heading).not.toBeNull();
    expect(step85?.title).toContain(step85Heading?.[1].split(":")[0] || "");
  });

  it("step 9 title matches '## Step 9: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step9 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "9",
    );
    const step9Heading = devTaskMdContent.match(/## Step 9: (.+)/);
    expect(step9Heading).not.toBeNull();
    expect(step9?.title).toContain(step9Heading?.[1].split(":")[0] || "");
  });

  it("step 9b title matches '## Step 9b: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step9b = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "9b",
    );
    const step9bHeading = devTaskMdContent.match(/## Step 9b: (.+)/);
    expect(step9bHeading).not.toBeNull();
    expect(step9b?.title).toContain(step9bHeading?.[1].split(":")[0] || "");
  });

  it("step 10 title matches '## Step 10: ...' heading", () => {
    requiredStepsContent = loadRequiredSteps();
    const step10 = requiredStepsContent?.steps?.find(
      (s) => s.stepNumber === "10",
    );
    const step10Heading = devTaskMdContent.match(/## Step 10: (.+)/);
    expect(step10Heading).not.toBeNull();
    expect(step10?.title).toContain(step10Heading?.[1].split(":")[0] || "");
  });
});
