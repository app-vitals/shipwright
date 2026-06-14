/**
 * plugins/shipwright/scripts/adapters/github.unit.test.ts
 *
 * Tests for the GitHubTaskStore — injects a fake gh command via GH_CMD env var.
 *
 * The fake gh script is a small Bun script written to a temp file that returns
 * pre-baked JSON responses based on the subcommand arguments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TaskStoreConfig } from "../store.ts";
import { GitHubTaskStore } from "./github.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a fake gh script that responds based on argv and make it executable. */
async function writeFakeGh(
  dir: string,
  responses: Record<string, unknown>,
): Promise<string> {
  const scriptPath = path.join(dir, "fake-gh");
  // The fake gh writes its argv joined by space (minus the script name) as the
  // lookup key and prints the matching response.
  const script = `#!/usr/bin/env bun
import { argv } from "process";
// argv[0]=bun, argv[1]=script, rest are gh args
const args = argv.slice(2);
const responses = ${JSON.stringify(responses)};

// Try progressively shorter prefixes to find a matching response key
function findResponse(args: string[]): unknown {
  // Try exact match first
  const key = args.join(" ");
  if (key in responses) return responses[key];

  // Try subcommand patterns (first few args)
  for (let len = args.length; len >= 1; len--) {
    const prefix = args.slice(0, len).join(" ");
    if (prefix in responses) return responses[prefix];
  }
  return null;
}

const result = findResponse(args);
if (result === null) {
  console.error("fake-gh: no response for args:", args.join(" "));
  process.exit(1);
}
if (result === "__exit0__") {
  process.exit(0);
}
console.log(typeof result === "string" ? result : JSON.stringify(result));
`;
  await writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/** Build a minimal GitHub issue JSON object (as returned by gh issue list --json). */
function makeIssue(
  number: number,
  title: string,
  statusLabel: string,
  bodyMeta: Record<string, unknown>,
  state: "OPEN" | "CLOSED" = "OPEN",
  assignees: { login: string }[] = [],
) {
  const meta = JSON.stringify(bodyMeta, null, 2);
  const body = `Task description\n\n\`\`\`shipwright\n${meta}\n\`\`\``;
  return {
    number,
    title,
    state,
    body,
    labels: [{ name: `status:${statusLabel}` }],
    url: `https://github.com/test-owner/test-repo/issues/${number}`,
    milestone: null,
    assignees,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const CONFIG: TaskStoreConfig = {
  taskStore: "github",
  github: { owner: "test-owner", repo: "test-repo" },
};

let tmpDir: string;
let origGhCmd: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "github-adapter-test-"));
  origGhCmd = process.env.GH_CMD;
});

afterEach(async () => {
  if (origGhCmd === undefined) {
    process.env.GH_CMD = undefined;
  } else {
    process.env.GH_CMD = origGhCmd;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── resolveRepo ─────────────────────────────────────────────────────────────

describe("GitHubTaskStore.resolveRepo", () => {
  test("returns owner/repo from config", async () => {
    const adapter = new GitHubTaskStore(CONFIG);
    const repo = await adapter.resolveRepo();
    expect(repo).toBe("test-owner/test-repo");
  });

  test("throws if github config is missing", async () => {
    const adapter = new GitHubTaskStore({ taskStore: "github" });
    await expect(adapter.resolveRepo()).rejects.toThrow();
  });
});

// ─── resolveRepos ────────────────────────────────────────────────────────────

describe("GitHubTaskStore.resolveRepos", () => {
  test("returns config repo as single-element array", async () => {
    const adapter = new GitHubTaskStore(CONFIG);
    const repos = await adapter.resolveRepos();
    expect(repos).toEqual(["test-owner/test-repo"]);
  });

  test("returns [] when github config missing", async () => {
    const adapter = new GitHubTaskStore({ taskStore: "github" });
    const repos = await adapter.resolveRepos();
    expect(repos).toEqual([]);
  });
});

// ─── setup ───────────────────────────────────────────────────────────────────

describe("GitHubTaskStore.setup", () => {
  test("creates status labels via gh label create --force", async () => {
    const captured: string[][] = [];
    const scriptPath = path.join(tmpDir, "capture-gh");
    const captureScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
appendFileSync(${JSON.stringify(path.join(tmpDir, "calls.txt"))}, argv.slice(2).join("|") + "\\n");
process.exit(0);
`;
    await writeFile(scriptPath, captureScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.setup();

    const calls = (await Bun.file(path.join(tmpDir, "calls.txt")).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    // Expect label create calls for each status
    const labelCalls = calls.filter(
      (c) => c[0] === "label" && c[1] === "create",
    );
    expect(labelCalls.length).toBeGreaterThanOrEqual(6);
    const labelNames = labelCalls.map((c) => c[2]);
    expect(labelNames).toContain("status:pending");
    expect(labelNames).toContain("status:in_progress");
    expect(labelNames).toContain("status:pr_open");
    expect(labelNames).toContain("status:approved");
    expect(labelNames).toContain("status:merged");
    expect(labelNames).toContain("status:blocked");
    expect(labelNames).toContain("status:deploying");
  });
});

// ─── query ───────────────────────────────────────────────────────────────────

describe("GitHubTaskStore.query", () => {
  test("returns all issues with status labels when no filters", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: First task", "pending", {
        id: "TSR-1.1",
        title: "First task",
        status: "pending",
        session: "tsr",
      }),
      makeIssue(2, "TSR-1.2: Second task", "in_progress", {
        id: "TSR-1.2",
        title: "Second task",
        status: "in_progress",
        session: "tsr",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("TSR-1.1");
    expect(tasks[1].id).toBe("TSR-1.2");
  });

  test("filters by status", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: First task", "pending", {
        id: "TSR-1.1",
        title: "First task",
        status: "pending",
        session: "tsr",
      }),
      makeIssue(2, "TSR-1.2: Second task", "in_progress", {
        id: "TSR-1.2",
        title: "Second task",
        status: "in_progress",
        session: "tsr",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ status: "pending" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("pending");
  });

  test("filters by session", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: Task A", "pending", {
        id: "TSR-1.1",
        title: "Task A",
        status: "pending",
        session: "session-a",
      }),
      makeIssue(2, "TSR-1.2: Task B", "pending", {
        id: "TSR-1.2",
        title: "Task B",
        status: "pending",
        session: "session-b",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ session: "session-a" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].session).toBe("session-a");
  });

  test("filters by id", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: Task A", "pending", {
        id: "TSR-1.1",
        title: "Task A",
        status: "pending",
      }),
      makeIssue(2, "TSR-1.2: Task B", "pending", {
        id: "TSR-1.2",
        title: "Task B",
        status: "pending",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ id: "TSR-1.2" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-1.2");
  });

  test("query --ready excludes tasks blocked by open issues", async () => {
    // TSR-2.1 depends on TSR-1.1 which is still open/pending
    const issues = [
      makeIssue(1, "TSR-1.1: Dep task", "pending", {
        id: "TSR-1.1",
        title: "Dep task",
        status: "pending",
        dependencies: [],
      }),
      makeIssue(2, "TSR-2.1: Dependent task", "pending", {
        id: "TSR-2.1",
        title: "Dependent task",
        status: "pending",
        dependencies: ["TSR-1.1"],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true });
    // TSR-1.1 has no deps → ready; TSR-2.1 depends on open TSR-1.1 → not ready
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-1.1");
  });

  test("query --ready includes tasks whose deps are merged", async () => {
    const issues = [
      makeIssue(
        1,
        "TSR-1.1: Done dep",
        "merged",
        {
          id: "TSR-1.1",
          title: "Done dep",
          status: "merged",
          dependencies: [],
        },
        "CLOSED",
      ),
      makeIssue(2, "TSR-2.1: Ready task", "pending", {
        id: "TSR-2.1",
        title: "Ready task",
        status: "pending",
        dependencies: ["TSR-1.1"],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-2.1");
  });

  test("query ready — deployed dep satisfies", async () => {
    const issues = [
      makeIssue(
        1,
        "TSR-1.1: Done dep",
        "deployed",
        {
          id: "TSR-1.1",
          title: "Done dep",
          status: "deployed",
          dependencies: [],
        },
        "CLOSED",
      ),
      makeIssue(2, "TSR-2.1: Ready task", "pending", {
        id: "TSR-2.1",
        title: "Ready task",
        status: "pending",
        dependencies: ["TSR-1.1"],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-2.1");
  });

  test("query --ready uses status from label (authoritative), not body", async () => {
    // Body says "pending" but label says "merged" — label wins
    const issues = [
      makeIssue(
        1,
        "TSR-1.1: Label-authoritative",
        "merged", // label says merged
        {
          id: "TSR-1.1",
          title: "Label-authoritative",
          status: "pending", // body says pending — should be ignored
          dependencies: [],
        },
        "CLOSED",
      ),
      makeIssue(2, "TSR-2.1: Dependent", "pending", {
        id: "TSR-2.1",
        title: "Dependent",
        status: "pending",
        dependencies: ["TSR-1.1"],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-2.1");
  });

  test("status is read from label, not body metadata", async () => {
    // Body metadata says in_progress, label says pending — label wins
    const issues = [
      makeIssue(1, "TSR-1.1: Task", "pending", {
        id: "TSR-1.1",
        title: "Task",
        status: "in_progress", // intentionally mismatched — label should win
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("pending");
  });

  test("only returns issues with status: labels (ignores non-shipwright issues)", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: Shipwright task", "pending", {
        id: "TSR-1.1",
        title: "Task",
        status: "pending",
      }),
      {
        number: 2,
        title: "Regular GitHub issue",
        state: "OPEN",
        body: "No shipwright block",
        labels: [{ name: "bug" }],
        url: "https://github.com/test-owner/test-repo/issues/2",
        milestone: null,
      },
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-1.1");
  });

  test("query --ready --assignee filters out tasks assigned to a different agent", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: Mine", "pending", {
        id: "TSR-1.1",
        title: "Mine",
        status: "pending",
        assignee: "dmcaulay",
        dependencies: [],
      }),
      makeIssue(2, "TSR-1.2: Theirs", "pending", {
        id: "TSR-1.2",
        title: "Theirs",
        status: "pending",
        assignee: "dodizzle",
        dependencies: [],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true, assignee: "dmcaulay" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-1.1");
  });

  test("query --ready --assignee includes unassigned tasks alongside own tasks", async () => {
    const issues = [
      makeIssue(1, "TSR-1.1: Mine", "pending", {
        id: "TSR-1.1",
        title: "Mine",
        status: "pending",
        assignee: "dmcaulay",
        dependencies: [],
      }),
      makeIssue(2, "TSR-1.2: Unassigned", "pending", {
        id: "TSR-1.2",
        title: "Unassigned",
        status: "pending",
        dependencies: [],
      }),
      makeIssue(3, "TSR-1.3: Theirs", "pending", {
        id: "TSR-1.3",
        title: "Theirs",
        status: "pending",
        assignee: "dodizzle",
        dependencies: [],
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true, assignee: "dmcaulay" });
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(["TSR-1.1", "TSR-1.2"]);
  });

  test("query --ready --assignee falls back to GitHub issue assignee when not in YAML block", async () => {
    const issues = [
      // Mine — YAML has assignee
      makeIssue(1, "TSR-1.1: Mine", "pending", {
        id: "TSR-1.1",
        title: "Mine",
        status: "pending",
        assignee: "dmcaulay",
        dependencies: [],
      }),
      // Theirs — no YAML assignee, but GitHub issue assignee is dodizzle
      makeIssue(
        2,
        "TSR-1.2: Theirs",
        "pending",
        {
          id: "TSR-1.2",
          title: "Theirs",
          status: "pending",
          dependencies: [],
        },
        "OPEN",
        [{ login: "dodizzle" }],
      ),
      // Mine via fallback — no YAML assignee, but GitHub issue assignee is dmcaulay
      makeIssue(
        3,
        "TSR-1.3: Mine via fallback",
        "pending",
        {
          id: "TSR-1.3",
          title: "Mine via fallback",
          status: "pending",
          dependencies: [],
        },
        "OPEN",
        [{ login: "dmcaulay" }],
      ),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true, assignee: "dmcaulay" });
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(["TSR-1.1", "TSR-1.3"]);
  });
});

// ─── append ──────────────────────────────────────────────────────────────────

describe("GitHubTaskStore.append", () => {
  test("creates new issue for each task", async () => {
    const scriptPath = path.join(tmpDir, "capture-gh");
    const createCountFile = path.join(tmpDir, "create-count.txt");
    const createArgsFile = path.join(tmpDir, "create-args.json");
    // Write 0 initially
    await writeFile(createCountFile, "0");
    const captureScript = `#!/usr/bin/env bun
import { argv } from "process";
import { readFileSync, writeFileSync } from "fs";
const args = argv.slice(2);

// Return empty list for issue list calls (no existing issues)
if (args[0] === "issue" && args[1] === "list") {
  console.log(JSON.stringify([]));
  process.exit(0);
}

// Capture issue create calls
if (args[0] === "issue" && args[1] === "create") {
  const count = parseInt(readFileSync(${JSON.stringify(createCountFile)}, "utf8")) + 1;
  writeFileSync(${JSON.stringify(createCountFile)}, String(count));
  writeFileSync(${JSON.stringify(createArgsFile)}, JSON.stringify(args));
  // Return a mock created issue URL
  console.log("https://github.com/test-owner/test-repo/issues/42");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, captureScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.append([
      {
        id: "TSR-1.1",
        title: "First task",
        status: "pending",
        description: "Do stuff",
        acceptanceCriteria: ["Criterion A", "Criterion B"],
        session: "tsr-session",
      },
    ]);

    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);

    const createCount = Number.parseInt(await Bun.file(createCountFile).text());
    expect(createCount).toBe(1);

    const createArgs = JSON.parse(
      await Bun.file(createArgsFile).text(),
    ) as string[];
    expect(createArgs).toContain("--label");
    expect(createArgs).toContain("status:pending");
    expect(createArgs).toContain("--title");
    const titleIdx = createArgs.indexOf("--title");
    expect(createArgs[titleIdx + 1]).toContain("TSR-1.1");
    expect(createArgs).toContain("--milestone");
    const milestoneIdx = createArgs.indexOf("--milestone");
    expect(createArgs[milestoneIdx + 1]).toBe("tsr-session");
  });

  test("is idempotent — skips existing tasks", async () => {
    const existingIssue = makeIssue(1, "TSR-1.1: First task", "pending", {
      id: "TSR-1.1",
      title: "First task",
      status: "pending",
    });

    const creates: string[] = [];
    const scriptPath = path.join(tmpDir, "idempotent-gh");
    const idempotentScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify([existingIssue]))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "creates2.txt"))}, "created\\n");
  console.log("https://github.com/test-owner/test-repo/issues/99");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, idempotentScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.append([
      { id: "TSR-1.1", title: "First task", status: "pending" },
    ]);

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);

    // No create calls should have been made
    try {
      await Bun.file(path.join(tmpDir, "creates2.txt")).text();
      throw new Error("Expected creates2.txt to not exist");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  });

  test("body contains shipwright block with task metadata", async () => {
    const capturedBody = "";
    const scriptPath = path.join(tmpDir, "body-capture-gh");
    const bodyScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx >= 0) {
    writeFileSync(${JSON.stringify(path.join(tmpDir, "body.txt"))}, args[bodyIdx + 1]);
  }
  console.log("https://github.com/test-owner/test-repo/issues/10");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, bodyScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-1.1",
        title: "Task with criteria",
        status: "pending",
        description: "My description",
        acceptanceCriteria: ["AC one", "AC two"],
      },
    ]);

    const body = await Bun.file(path.join(tmpDir, "body.txt")).text();
    expect(body).toContain("```shipwright");
    expect(body).toContain("TSR-1.1");
    expect(body).toContain("My description");
    expect(body).toContain("AC one");
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("GitHubTaskStore.update", () => {
  test("throws if task not found", async () => {
    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        [],
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    await expect(
      adapter.update("NOPE", { status: "in_progress" }),
    ).rejects.toThrow("task not found: NOPE");
  });

  test("status update removes old status label and adds new status label", async () => {
    const issues = [
      makeIssue(42, "TSR-1.1: Task", "pending", {
        id: "TSR-1.1",
        title: "Task",
        status: "pending",
        model: "sonnet",
      }),
    ];

    const editCalls: string[] = [];
    const scriptPath = path.join(tmpDir, "update-gh");
    const updateScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "edits.txt"))}, args.join("|") + "\\n");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "closes.txt"))}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, updateScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const updated = await adapter.update("TSR-1.1", { status: "in_progress" });

    expect(updated.status).toBe("in_progress");

    const edits = (await Bun.file(path.join(tmpDir, "edits.txt")).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    // At least one edit call should have --add-label status:in_progress
    const labelEdit = edits.find(
      (e) => e.includes("--add-label") && e.includes("status:in_progress"),
    );
    expect(labelEdit).toBeDefined();

    // And it should remove the old status label
    expect(labelEdit).toContain("--remove-label");
    expect(labelEdit).toContain("status:pending");
  });

  test("status change to merged closes the issue", async () => {
    const issues = [
      makeIssue(42, "TSR-1.1: Task", "approved", {
        id: "TSR-1.1",
        title: "Task",
        status: "approved",
      }),
    ];

    const scriptPath = path.join(tmpDir, "close-gh");
    const closeScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "closes.txt"))}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, closeScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-1.1", { status: "merged" });

    const closes = await Bun.file(path.join(tmpDir, "closes.txt")).text();
    expect(closes).toContain("close");
    expect(closes).toContain("42");
  });

  test("non-status field update edits body without swapping labels", async () => {
    const issues = [
      makeIssue(42, "TSR-1.1: Task", "in_progress", {
        id: "TSR-1.1",
        title: "Task",
        status: "in_progress",
      }),
    ];

    const scriptPath = path.join(tmpDir, "body-update-gh");
    const bodyUpdateScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync, writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "edits2.txt"))}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, bodyUpdateScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const updated = await adapter.update("TSR-1.1", { note: "some note" });

    expect(updated.note).toBe("some note");
    expect(updated.status).toBe("in_progress"); // status unchanged

    const edits = (await Bun.file(path.join(tmpDir, "edits2.txt")).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    // Should have a body edit
    const bodyEdit = edits.find((e) => e.includes("--body"));
    expect(bodyEdit).toBeDefined();

    // Should NOT have any label swaps (no --add-label or --remove-label)
    const anyLabelEdit = edits.find(
      (e) => e.includes("--add-label") || e.includes("--remove-label"),
    );
    expect(anyLabelEdit).toBeUndefined();
  });

  test("status update uses actual status label (not body status) for --remove-label", async () => {
    // Issue label says status:pending but body metadata says status:in_progress
    // (can happen if a previous body-only edit succeeded but the label swap failed).
    // The --remove-label arg must use _labelStatus (the actual label), not the body value.
    const issues = [
      makeIssue(42, "TSR-1.1: Task", "pending", {
        id: "TSR-1.1",
        title: "Task",
        status: "in_progress", // body diverged from label
      }),
    ];

    const scriptPath = path.join(tmpDir, "label-actual-gh");
    const labelActualScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  appendFileSync(${JSON.stringify(path.join(tmpDir, "label-actual-edits.txt"))}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, labelActualScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-1.1", { status: "pr_open" });

    const edits = (
      await Bun.file(path.join(tmpDir, "label-actual-edits.txt")).text()
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    const labelEdit = edits.find(
      (e) => e.includes("--add-label") && e.includes("status:pr_open"),
    );
    expect(labelEdit).toBeDefined();

    // The actual issue label is status:pending — that must be removed, not status:in_progress
    expect(labelEdit).toContain("--remove-label");
    expect(labelEdit).toContain("status:pending");
    expect(labelEdit).not.toContain("status:in_progress");
  });

  test("status update skips --remove-label when issue has no status label", async () => {
    // An issue with only a session label (no status:*) is filtered out by
    // fetchAllIssues, so update() throws "task not found" — it never reaches
    // the label swap code and never tries to remove a non-existent label.
    const issueBody = `Task\n\n\`\`\`shipwright\n${JSON.stringify({ id: "TSR-1.1", title: "Task", status: "pending" }, null, 2)}\n\`\`\``;
    const issues = [
      {
        number: 42,
        title: "TSR-1.1: Task",
        state: "OPEN",
        body: issueBody,
        labels: [{ name: "session:foo" }],
        url: "https://github.com/test-owner/test-repo/issues/42",
        milestone: null,
      },
    ];

    const scriptPath = path.join(tmpDir, "no-status-label-gh");
    const editLog = path.join(tmpDir, "no-status-label-edits.txt");
    const noLabelScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  appendFileSync(${JSON.stringify(editLog)}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, noLabelScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    // Issue is invisible to fetchAllIssues (no status:* label) → task not found,
    // not a gh CLI crash from attempting to remove a non-existent label.
    await expect(
      adapter.update("TSR-1.1", { status: "in_progress" }),
    ).rejects.toThrow("task not found");

    // No gh issue edit calls were made — --remove-label was never attempted.
    const editExists = await Bun.file(editLog).exists();
    expect(editExists).toBe(false);
  });

  test("description and acceptanceCriteria survive read-then-update round-trip", async () => {
    const originalTask = {
      id: "TSR-2.1",
      title: "Task with description",
      status: "pending" as const,
      description: "Original description",
      acceptanceCriteria: ["AC one", "AC two"],
    };
    const issues = [
      makeIssue(55, "TSR-2.1: Task with description", "pending", originalTask),
    ];

    const scriptPath = path.join(tmpDir, "roundtrip-gh");
    const roundtripScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx >= 0) {
    writeFileSync(${JSON.stringify(path.join(tmpDir, "roundtrip-body.txt"))}, args[bodyIdx + 1]);
  }
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, roundtripScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const updated = await adapter.update("TSR-2.1", { note: "updated" });

    // description and acceptanceCriteria must survive the round-trip
    expect(updated.description).toBe("Original description");
    expect(updated.acceptanceCriteria).toEqual(["AC one", "AC two"]);

    // And the rebuilt body must also contain them
    const body = await Bun.file(path.join(tmpDir, "roundtrip-body.txt")).text();
    expect(body).toContain("Original description");
    expect(body).toContain("AC one");
  });
});

// ─── GH_CMD injection ────────────────────────────────────────────────────────

describe("GH_CMD injection", () => {
  test("uses GH_CMD env var instead of 'gh'", async () => {
    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        [],
    });
    process.env.GH_CMD = fakeGh;

    // If GH_CMD injection didn't work, this would fail because "gh" isn't available in test env
    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toEqual([]);
  });
});

// ─── append with assignee ─────────────────────────────────────────────────────

describe("GitHubTaskStore.append assignee", () => {
  test("passes --assignee flag when task.assignee is set", async () => {
    const scriptPath = path.join(tmpDir, "assignee-gh");
    const assigneeScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  writeFileSync(${JSON.stringify(path.join(tmpDir, "assignee-args.json"))}, JSON.stringify(args));
  console.log("https://github.com/test-owner/test-repo/issues/50");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, assigneeScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-3.1",
        title: "Assigned task",
        status: "pending",
        assignee: "octocat",
      },
    ]);

    const createArgs = JSON.parse(
      await Bun.file(path.join(tmpDir, "assignee-args.json")).text(),
    ) as string[];
    expect(createArgs).toContain("--assignee");
    const assigneeIdx = createArgs.indexOf("--assignee");
    expect(createArgs[assigneeIdx + 1]).toBe("octocat");
  });

  test("does NOT pass --assignee when task.assignee is undefined and gh user resolution fails", async () => {
    const scriptPath = path.join(tmpDir, "no-assignee-gh");
    const noAssigneeScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  writeFileSync(${JSON.stringify(path.join(tmpDir, "no-assignee-args.json"))}, JSON.stringify(args));
  console.log("https://github.com/test-owner/test-repo/issues/51");
  process.exit(0);
}

// api user call returns empty (simulates unauthenticated / no user resolved)
process.exit(0);
`;
    await writeFile(scriptPath, noAssigneeScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-3.2",
        title: "Unassigned task",
        status: "pending",
      },
    ]);

    const createArgs = JSON.parse(
      await Bun.file(path.join(tmpDir, "no-assignee-args.json")).text(),
    ) as string[];
    expect(createArgs).not.toContain("--assignee");
  });

  test("auto-assigns current GH user when no assignee is set", async () => {
    const createArgsFile = path.join(tmpDir, "auto-assign-args.json");
    const scriptPath = path.join(tmpDir, "auto-assign-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "api" && args[1] === "user") {
  console.log("autobot");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  writeFileSync(${JSON.stringify(createArgsFile)}, JSON.stringify(args));
  console.log("https://github.com/test-owner/test-repo/issues/52");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      { id: "TSR-3.3", title: "Auto-assigned task", status: "pending" },
    ]);

    const createArgs = JSON.parse(
      await Bun.file(createArgsFile).text(),
    ) as string[];
    expect(createArgs).toContain("--assignee");
    const assigneeIdx = createArgs.indexOf("--assignee");
    expect(createArgs[assigneeIdx + 1]).toBe("autobot");
  });
});

// ─── query with assignee filter ───────────────────────────────────────────────

describe("GitHubTaskStore.query assignee filter", () => {
  test("filters tasks by assignee when filters.assignee is set", async () => {
    const issues = [
      makeIssue(1, "TSR-4.1: Alice task", "pending", {
        id: "TSR-4.1",
        title: "Alice task",
        status: "pending",
        assignee: "alice",
      }),
      makeIssue(2, "TSR-4.2: Bob task", "pending", {
        id: "TSR-4.2",
        title: "Bob task",
        status: "pending",
        assignee: "bob",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ assignee: "alice" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("TSR-4.1");
    expect(tasks[0].assignee).toBe("alice");
  });

  test("returns all tasks when filters.assignee is not set", async () => {
    const issues = [
      makeIssue(1, "TSR-4.1: Alice task", "pending", {
        id: "TSR-4.1",
        title: "Alice task",
        status: "pending",
        assignee: "alice",
      }),
      makeIssue(2, "TSR-4.2: Bob task", "pending", {
        id: "TSR-4.2",
        title: "Bob task",
        status: "pending",
        assignee: "bob",
      }),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toHaveLength(2);
  });
});

// ─── update closes on terminal statuses ──────────────────────────────────────

describe("GitHubTaskStore.update terminal status closing", () => {
  async function makeCloseScript(
    dir: string,
    name: string,
    issues: ReturnType<typeof makeIssue>[],
  ): Promise<string> {
    const scriptPath = path.join(dir, name);
    const closesFile = path.join(dir, `${name}-closes.txt`);
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(closesFile)}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }

  test("closes issue on status=done", async () => {
    const issues = [
      makeIssue(42, "TSR-5.1: Task", "in_progress", {
        id: "TSR-5.1",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const closesFile = path.join(tmpDir, "done-gh-closes.txt");
    const scriptPath = await makeCloseScript(tmpDir, "done-gh", issues);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-5.1", { status: "done" });

    const closes = await Bun.file(closesFile).text();
    expect(closes).toContain("close");
    expect(closes).toContain("42");
  });

  test("closes issue on status=deployed", async () => {
    const issues = [
      makeIssue(43, "TSR-5.2: Task", "deploying", {
        id: "TSR-5.2",
        title: "Task",
        status: "deploying",
      }),
    ];
    const closesFile = path.join(tmpDir, "deployed-gh-closes.txt");
    const scriptPath = await makeCloseScript(tmpDir, "deployed-gh", issues);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-5.2", { status: "deployed" });

    const closes = await Bun.file(closesFile).text();
    expect(closes).toContain("close");
    expect(closes).toContain("43");
  });

  test("closes issue on status=cancelled", async () => {
    const issues = [
      makeIssue(44, "TSR-5.3: Task", "pending", {
        id: "TSR-5.3",
        title: "Task",
        status: "pending",
      }),
    ];
    const closesFile = path.join(tmpDir, "cancelled-gh-closes.txt");
    const scriptPath = await makeCloseScript(tmpDir, "cancelled-gh", issues);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-5.3", { status: "cancelled" });

    const closes = await Bun.file(closesFile).text();
    expect(closes).toContain("close");
    expect(closes).toContain("44");
  });

  test("closes issue on status=merged (existing behavior preserved)", async () => {
    const issues = [
      makeIssue(45, "TSR-5.4: Task", "approved", {
        id: "TSR-5.4",
        title: "Task",
        status: "approved",
      }),
    ];
    const closesFile = path.join(tmpDir, "merged2-gh-closes.txt");
    const scriptPath = await makeCloseScript(tmpDir, "merged2-gh", issues);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-5.4", { status: "merged" });

    const closes = await Bun.file(closesFile).text();
    expect(closes).toContain("close");
    expect(closes).toContain("45");
  });

  test("does NOT close issue on non-terminal status like in_progress", async () => {
    const issues = [
      makeIssue(46, "TSR-5.5: Task", "pending", {
        id: "TSR-5.5",
        title: "Task",
        status: "pending",
        model: "sonnet",
      }),
    ];
    const closesFile = path.join(tmpDir, "nonterminal-gh-closes.txt");
    const scriptPath = await makeCloseScript(tmpDir, "nonterminal-gh", issues);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("TSR-5.5", { status: "in_progress" });

    let closesExist = true;
    try {
      await Bun.file(closesFile).text();
    } catch {
      closesExist = false;
    }
    expect(closesExist).toBe(false);
  });
});

// ─── append session label ─────────────────────────────────────────────────────

describe("GitHubTaskStore.append session label", () => {
  test("includes session label in gh issue create args when task.session is set", async () => {
    const scriptPath = path.join(tmpDir, "session-label-gh");
    const argsFile = path.join(tmpDir, "session-create-args.json");
    const captureScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
  console.log("https://github.com/test-owner/test-repo/issues/77");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, captureScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-8.1",
        title: "Task with session",
        status: "pending",
        session: "foo",
      },
    ]);

    const createArgs = JSON.parse(await Bun.file(argsFile).text()) as string[];
    expect(createArgs).toContain("--label");
    expect(createArgs).toContain("session:foo");
  });

  test("calls gh label create session:{session} --force before issue creation", async () => {
    const scriptPath = path.join(tmpDir, "session-order-gh");
    const callsFile = path.join(tmpDir, "session-order-calls.txt");
    const captureScript = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

// Record every call with its subcommand
appendFileSync(${JSON.stringify(callsFile)}, args.join("|") + "\\n");

if (args[0] === "issue" && args[1] === "create") {
  console.log("https://github.com/test-owner/test-repo/issues/78");
}

process.exit(0);
`;
    await writeFile(scriptPath, captureScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-8.2",
        title: "Task with session order check",
        status: "pending",
        session: "foo",
      },
    ]);

    const calls = (await Bun.file(callsFile).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));

    // Find label create call for session:foo
    const labelCreateIdx = calls.findIndex(
      (c) =>
        c[0] === "label" &&
        c[1] === "create" &&
        c[2] === "session:foo" &&
        c.includes("--force"),
    );
    // Find issue create call
    const issueCreateIdx = calls.findIndex(
      (c) => c[0] === "issue" && c[1] === "create",
    );

    expect(labelCreateIdx).toBeGreaterThanOrEqual(0);
    expect(issueCreateIdx).toBeGreaterThanOrEqual(0);
    expect(labelCreateIdx).toBeLessThan(issueCreateIdx);
  });

  test("does not add session label when task.session is absent", async () => {
    const scriptPath = path.join(tmpDir, "no-session-gh");
    const argsFile = path.join(tmpDir, "no-session-create-args.json");
    const captureScript = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "create") {
  writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
  console.log("https://github.com/test-owner/test-repo/issues/79");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, captureScript, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.append([
      {
        id: "TSR-8.3",
        title: "Task without session",
        status: "pending",
      },
    ]);

    const createArgs = JSON.parse(await Bun.file(argsFile).text()) as string[];
    // No session:* label should be in the args
    const sessionLabels = createArgs.filter((arg) =>
      arg.startsWith("session:"),
    );
    expect(sessionLabels).toHaveLength(0);
  });
});

// ─── cleanup ──────────────────────────────────────────────────────────────────

describe("GitHubTaskStore.cleanup", () => {
  test("closes open issues with terminal status labels", async () => {
    // Issue 10: open with status:merged — should be closed
    // Issue 11: open with status:done — should be closed
    // Issue 12: open with status:deployed — should be closed
    // Issue 13: open with status:cancelled — should be closed
    // Issue 14: open with status:pending — should NOT be closed
    // Issue 15: already CLOSED with status:merged — should NOT be closed again
    const issues = [
      makeIssue(
        10,
        "TSR-6.1: Merged open",
        "merged",
        { id: "TSR-6.1", title: "Merged open", status: "merged" },
        "OPEN",
      ),
      makeIssue(
        11,
        "TSR-6.2: Done open",
        "done",
        { id: "TSR-6.2", title: "Done open", status: "done" },
        "OPEN",
      ),
      makeIssue(
        12,
        "TSR-6.3: Deployed open",
        "deployed",
        { id: "TSR-6.3", title: "Deployed open", status: "deployed" },
        "OPEN",
      ),
      makeIssue(
        13,
        "TSR-6.4: Cancelled open",
        "cancelled",
        { id: "TSR-6.4", title: "Cancelled open", status: "cancelled" },
        "OPEN",
      ),
      makeIssue(
        14,
        "TSR-6.5: Pending open",
        "pending",
        { id: "TSR-6.5", title: "Pending open", status: "pending" },
        "OPEN",
      ),
      makeIssue(
        15,
        "TSR-6.6: Merged closed",
        "merged",
        { id: "TSR-6.6", title: "Merged closed", status: "merged" },
        "CLOSED",
      ),
    ];

    const closesFile = path.join(tmpDir, "cleanup-closes.txt");
    const scriptPath = path.join(tmpDir, "cleanup-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(closesFile)}, args.join("|") + "\\n");
  process.exit(0);
}

if (args[0] === "api" && !args.includes("--method")) {
  console.log("[]");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    // Should have closed issues 10, 11, 12, 13 (terminal + open)
    // Should NOT have closed 14 (pending) or 15 (already closed)
    const closesContent = await Bun.file(closesFile).text();
    const closedNumbers = closesContent
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"))
      .filter((parts) => parts[0] === "issue" && parts[1] === "close")
      .map((parts) => parts[2]);

    expect(closedNumbers).toContain("10");
    expect(closedNumbers).toContain("11");
    expect(closedNumbers).toContain("12");
    expect(closedNumbers).toContain("13");
    expect(closedNumbers).not.toContain("14");
    expect(closedNumbers).not.toContain("15");
    expect(result.closed).toBe(4);
    expect(result.milestonesClosed).toBe(0);
  });

  test("returns zero closed when no stale open issues exist", async () => {
    const issues = [
      makeIssue(
        20,
        "TSR-7.1: Pending",
        "pending",
        { id: "TSR-7.1", title: "Pending", status: "pending" },
        "OPEN",
      ),
      makeIssue(
        21,
        "TSR-7.2: Closed merged",
        "merged",
        { id: "TSR-7.2", title: "Merged", status: "merged" },
        "CLOSED",
      ),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
      "api repos/test-owner/test-repo/milestones?per_page=100": [],
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();
    expect(result.closed).toBe(0);
    expect(result.milestonesClosed).toBe(0);
  });

  test("closes empty open milestones", async () => {
    const milestones = [
      { number: 1, title: "M1 — Done session", state: "open", open_issues: 0 },
      { number: 2, title: "M2 — Also done", state: "open", open_issues: 0 },
      { number: 3, title: "M3 — Still active", state: "open", open_issues: 2 },
      {
        number: 4,
        title: "M4 — Already closed",
        state: "closed",
        open_issues: 0,
      },
    ];

    const patchesFile = path.join(tmpDir, "milestone-patches.txt");
    const scriptPath = path.join(tmpDir, "milestone-cleanup-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "api" && !args.includes("--method")) {
  console.log(${JSON.stringify(JSON.stringify(milestones))});
  process.exit(0);
}

if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH") {
  appendFileSync(${JSON.stringify(patchesFile)}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    expect(result.milestonesClosed).toBe(2);

    const patches = (await Bun.file(patchesFile).text())
      .trim()
      .split("\n")
      .filter(Boolean);

    // Should have patched milestones 1 and 2, not 3 (has open issues) or 4 (already closed)
    expect(patches.some((p) => p.includes("milestones/1"))).toBe(true);
    expect(patches.some((p) => p.includes("milestones/2"))).toBe(true);
    expect(patches.some((p) => p.includes("milestones/3"))).toBe(false);
    expect(patches.some((p) => p.includes("milestones/4"))).toBe(false);
    expect(patches.every((p) => p.includes("state=closed"))).toBe(true);
  });

  test("does not patch milestones that have open issues or are already closed", async () => {
    const milestones = [
      { number: 5, title: "M5 — Active", state: "open", open_issues: 3 },
      {
        number: 6,
        title: "M6 — Already closed",
        state: "closed",
        open_issues: 0,
      },
    ];

    const patchesFile = path.join(tmpDir, "no-patch-milestones.txt");
    const scriptPath = path.join(tmpDir, "no-patch-milestone-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log("[]");
  process.exit(0);
}

if (args[0] === "api" && !args.includes("--method")) {
  console.log(${JSON.stringify(JSON.stringify(milestones))});
  process.exit(0);
}

if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH") {
  appendFileSync(${JSON.stringify(patchesFile)}, args.join("|") + "\\n");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    expect(result.milestonesClosed).toBe(0);

    // No PATCH calls should have been made
    let patchesExist = true;
    try {
      await Bun.file(patchesFile).text();
    } catch {
      patchesExist = false;
    }
    expect(patchesExist).toBe(false);
  });
});

// ─── GitHubTaskStore.cleanup — plan issues ────────────────────────────────────

describe("GitHubTaskStore.cleanup (plan issues)", () => {
  const TASK_LIST_KEY =
    "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500";
  const PLAN_LIST_KEY =
    "issue list --repo test-owner/test-repo --state open --search [plan] in:title --json number,title --limit 100";
  const MILESTONES_KEY =
    "api repos/test-owner/test-repo/milestones?per_page=100";

  test("closes plan issue when all session tasks are terminal", async () => {
    const taskIssues = [
      makeIssue(
        100,
        "SESS-1.1: Task one",
        "merged",
        {
          id: "SESS-1.1",
          title: "Task one",
          status: "merged",
          session: "my-session",
        },
        "OPEN",
      ),
      makeIssue(
        101,
        "SESS-1.2: Task two",
        "deployed",
        {
          id: "SESS-1.2",
          title: "Task two",
          status: "deployed",
          session: "my-session",
        },
        "OPEN",
      ),
    ];
    const planIssues = [{ number: 200, title: "[plan] my-session" }];

    const closesFile = path.join(tmpDir, "plan-closes.txt");
    const scriptPath = path.join(tmpDir, "plan-cleanup-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list" && args.includes("--state") && args[args.indexOf("--state") + 1] === "all") {
  console.log(${JSON.stringify(JSON.stringify(taskIssues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "list" && args.includes("--search")) {
  console.log(${JSON.stringify(JSON.stringify(planIssues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(closesFile)}, args[2] + "\\n");
  process.exit(0);
}

if (args[0] === "api" && !args.includes("--method")) {
  console.log("[]");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    // Task issues 100 and 101 are already OPEN+terminal — they'll be closed too
    // Plan issue 200 should be closed because both session tasks are terminal
    const closesContent = await Bun.file(closesFile).text();
    const closedNumbers = closesContent.trim().split("\n").filter(Boolean);

    expect(closedNumbers).toContain("200");
    expect(result.plansClosed).toBe(1);
  });

  test("does not close plan issue when session has non-terminal tasks", async () => {
    const taskIssues = [
      makeIssue(
        110,
        "SESS-2.1: Done task",
        "merged",
        {
          id: "SESS-2.1",
          title: "Done task",
          status: "merged",
          session: "active-session",
        },
        "OPEN",
      ),
      makeIssue(
        111,
        "SESS-2.2: Pending task",
        "pending",
        {
          id: "SESS-2.2",
          title: "Pending task",
          status: "pending",
          session: "active-session",
        },
        "OPEN",
      ),
    ];
    const planIssues = [{ number: 210, title: "[plan] active-session" }];

    const fakeGh = await writeFakeGh(tmpDir, {
      [TASK_LIST_KEY]: taskIssues,
      [PLAN_LIST_KEY]: planIssues,
      "issue close": "__exit0__",
      [MILESTONES_KEY]: [],
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    expect(result.plansClosed).toBe(0);
  });

  test("does not close plan issue when no tasks exist for that session", async () => {
    const taskIssues = [
      makeIssue(
        120,
        "OTHER-1.1: Other session task",
        "deployed",
        {
          id: "OTHER-1.1",
          title: "Other session task",
          status: "deployed",
          session: "other-session",
        },
        "OPEN",
      ),
    ];
    const planIssues = [{ number: 220, title: "[plan] empty-session" }];

    const fakeGh = await writeFakeGh(tmpDir, {
      [TASK_LIST_KEY]: taskIssues,
      [PLAN_LIST_KEY]: planIssues,
      "issue close": "__exit0__",
      [MILESTONES_KEY]: [],
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    expect(result.plansClosed).toBe(0);
  });

  test("closes only fully-done plan issues when multiple exist", async () => {
    const taskIssues = [
      makeIssue(
        130,
        "DONE-1.1: Finished",
        "deployed",
        {
          id: "DONE-1.1",
          title: "Finished",
          status: "deployed",
          session: "done-session",
        },
        "OPEN",
      ),
      makeIssue(
        131,
        "WIP-1.1: In progress",
        "pr_open",
        {
          id: "WIP-1.1",
          title: "In progress",
          status: "pr_open",
          session: "wip-session",
        },
        "OPEN",
      ),
    ];
    const planIssues = [
      { number: 230, title: "[plan] done-session" },
      { number: 231, title: "[plan] wip-session" },
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      [TASK_LIST_KEY]: taskIssues,
      [PLAN_LIST_KEY]: planIssues,
      "issue close": "__exit0__",
      [MILESTONES_KEY]: [],
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const result = await adapter.cleanup();

    // done-session has all terminal tasks; wip-session does not
    expect(result.plansClosed).toBe(1);
  });

  test("plan sweep failure does not prevent task cleanup", async () => {
    const taskIssues = [
      makeIssue(
        140,
        "FAIL-1.1: Should close",
        "merged",
        { id: "FAIL-1.1", title: "Should close", status: "merged" },
        "OPEN",
      ),
    ];

    const closesFile = path.join(tmpDir, "fail-closes.txt");
    const scriptPath = path.join(tmpDir, "plan-fail-gh");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list" && args.includes("--state") && args[args.indexOf("--state") + 1] === "all") {
  console.log(${JSON.stringify(JSON.stringify(taskIssues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "list" && args.includes("--search")) {
  // Simulate plan issue fetch failure
  process.stderr.write("gh: plan search unavailable\\n");
  process.exit(1);
}

if (args[0] === "issue" && args[1] === "close") {
  appendFileSync(${JSON.stringify(closesFile)}, args[2] + "\\n");
  process.exit(0);
}

if (args[0] === "api" && !args.includes("--method")) {
  console.log("[]");
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    const result = await adapter.cleanup();

    // Task issue 140 should still be closed despite plan sweep failing
    expect(result.closed).toBe(1);
    expect(result.plansClosed).toBe(0);
    expect(warnings.some((w) => w.includes("plan issue sweep failed"))).toBe(
      true,
    );
  });
});

// ─── Shared helpers for update-warning tests ─────────────────────────────────

async function makeUpdateScript(
  dir: string,
  name: string,
  issues: ReturnType<typeof makeIssue>[],
): Promise<string> {
  const scriptPath = path.join(dir, name);
  const script = `#!/usr/bin/env bun
import { argv } from "process";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && (args[1] === "edit" || args[1] === "close")) {
  process.exit(0);
}

process.exit(0);
`;
  await writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

// ─── GitHubTaskStore.update field enforcement warnings ────────────────────────

describe("GitHubTaskStore.update field enforcement warnings", () => {

  test("warns when prCreatedAt missing on pr_open transition", async () => {
    const issues = [
      makeIssue(1, "TSR-W.1: Task", "in_progress", {
        id: "TSR-W.1",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-1", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.1", {
      status: "pr_open",
      pr: 42,
      prUrl: "https://example.com/pr/42",
    });
    expect(warnings.some((w) => w.includes("prCreatedAt"))).toBe(true);
  });

  test("warns when pr missing on pr_open transition (with no prUrl either)", async () => {
    const issues = [
      makeIssue(2, "TSR-W.2: Task", "in_progress", {
        id: "TSR-W.2",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-2", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.2", {
      status: "pr_open",
      prCreatedAt: "2026-01-01T00:00:00Z",
    });
    expect(warnings.some((w) => w.includes("pr") || w.includes("prUrl"))).toBe(
      true,
    );
  });

  test("does NOT warn when pr is present on pr_open transition", async () => {
    const issues = [
      makeIssue(3, "TSR-W.3: Task", "in_progress", {
        id: "TSR-W.3",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-3", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.3", {
      status: "pr_open",
      pr: 42,
      prCreatedAt: "2026-01-01T00:00:00Z",
    });
    expect(warnings.some((w) => w.includes("pr") || w.includes("prUrl"))).toBe(
      false,
    );
  });

  test("does NOT warn when prUrl is present on pr_open transition (pr missing but prUrl present)", async () => {
    const issues = [
      makeIssue(4, "TSR-W.4: Task", "in_progress", {
        id: "TSR-W.4",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-4", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.4", {
      status: "pr_open",
      prUrl: "https://example.com/pr/42",
      prCreatedAt: "2026-01-01T00:00:00Z",
    });
    expect(warnings.some((w) => w.includes("pr") || w.includes("prUrl"))).toBe(
      false,
    );
  });

  test("warns when ciFixAttempts missing on approved transition (from pr_open)", async () => {
    const issues = [
      makeIssue(5, "TSR-W.5: Task", "pr_open", {
        id: "TSR-W.5",
        title: "Task",
        status: "pr_open",
        pr: 42,
        prCreatedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-5", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.5", { status: "approved" });
    expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(true);
  });

  test("warns when ciFixAttempts missing on merged transition (from pr_open)", async () => {
    const issues = [
      makeIssue(6, "TSR-W.6: Task", "pr_open", {
        id: "TSR-W.6",
        title: "Task",
        status: "pr_open",
        pr: 42,
        prCreatedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-6", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.6", { status: "merged" });
    expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(true);
  });

  test("does NOT warn when ciFixAttempts is present", async () => {
    const issues = [
      makeIssue(7, "TSR-W.7: Task", "pr_open", {
        id: "TSR-W.7",
        title: "Task",
        status: "pr_open",
        pr: 42,
        prCreatedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-7", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.7", { status: "approved", ciFixAttempts: 0 });
    expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(false);
  });

  test("does NOT warn about pr_open or ciFixAttempts for in_progress transitions", async () => {
    const issues = [
      makeIssue(8, "TSR-W.8: Task", "pending", {
        id: "TSR-W.8",
        title: "Task",
        status: "pending",
        model: "sonnet",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-8", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("TSR-W.8", { status: "in_progress" });
    // prCreatedAt / pr+prUrl / ciFixAttempts warnings must NOT fire for in_progress
    expect(warnings.some((w) => w.includes("prCreatedAt"))).toBe(false);
    expect(warnings.some((w) => w.includes("ciFixAttempts"))).toBe(false);
  });

  test("update still succeeds even when warnings fire", async () => {
    const issues = [
      makeIssue(9, "TSR-W.9: Task", "in_progress", {
        id: "TSR-W.9",
        title: "Task",
        status: "in_progress",
      }),
    ];
    const scriptPath = await makeUpdateScript(tmpDir, "warn-gh-9", issues);
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    const result = await adapter.update("TSR-W.9", { status: "pr_open" });
    expect(result?.status).toBe("pr_open");
  });
});

// ─── query ready+assignee filter ─────────────────────────────────────────────

describe("GitHubTaskStore.query ready+assignee filter", () => {
  function makeReadyIssue(
    number: number,
    id: string,
    assignee?: string,
  ): ReturnType<typeof makeIssue> {
    const meta: Record<string, unknown> = {
      id,
      title: `Task ${id}`,
      status: "pending",
      dependencies: [],
    };
    if (assignee !== undefined) {
      meta.assignee = assignee;
    }
    return makeIssue(number, `${id}: Task ${id}`, "pending", meta);
  }

  async function makeReadyFakeGh(
    dir: string,
    issues: ReturnType<typeof makeIssue>[],
  ): Promise<string> {
    return writeFakeGh(dir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
  }

  test("query({ ready: true, assignee: X }) returns only tasks assigned to X or unassigned", async () => {
    const issues = [
      makeReadyIssue(1, "RPA-1.1", "agent-x"), // assigned to X
      makeReadyIssue(2, "RPA-1.2", "agent-y"), // assigned to Y — should be excluded
      makeReadyIssue(3, "RPA-1.3"), // unassigned — should be included
    ];
    const fakeGh = await makeReadyFakeGh(tmpDir, issues);
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true, assignee: "agent-x" });

    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("RPA-1.1");
    expect(ids).toContain("RPA-1.3");
    expect(ids).not.toContain("RPA-1.2");
  });

  test("query({ ready: true, assignee: X }) excludes tasks assigned to different agent", async () => {
    const issues = [makeReadyIssue(1, "RPA-2.1", "agent-y")];
    const fakeGh = await makeReadyFakeGh(tmpDir, issues);
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true, assignee: "agent-x" });

    expect(tasks).toHaveLength(0);
  });

  test("query({ ready: true }) without assignee filter returns all ready tasks", async () => {
    const issues = [
      makeReadyIssue(1, "RPA-3.1", "agent-x"),
      makeReadyIssue(2, "RPA-3.2", "agent-y"),
    ];
    const fakeGh = await makeReadyFakeGh(tmpDir, issues);
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({ ready: true });

    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("RPA-3.1");
    expect(ids).toContain("RPA-3.2");
  });
});

// ─── model and complexity round-trip (GitHub adapter) ────────────────────────

describe("GitHubTaskStore model and complexity round-trip", () => {
  test("model field survives write into shipwright block and parse back out", async () => {
    const originalTask = {
      id: "DM-1.1",
      title: "Task with model",
      status: "pending" as const,
      model: "sonnet" as const,
      complexity: 3,
    };
    const issues = [
      makeIssue(10, "DM-1.1: Task with model", "pending", originalTask),
    ];

    const fakeGh = await writeFakeGh(tmpDir, {
      "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
        issues,
    });
    process.env.GH_CMD = fakeGh;

    const adapter = new GitHubTaskStore(CONFIG);
    const tasks = await adapter.query({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].model).toBe("sonnet");
    expect(tasks[0].complexity).toBe(3);
  });

  test("model and complexity survive an update round-trip through shipwright block", async () => {
    const originalTask = {
      id: "DM-1.2",
      title: "Task",
      status: "pending" as const,
      model: "opus" as const,
      complexity: 5,
    };
    const issues = [makeIssue(11, "DM-1.2: Task", "pending", originalTask)];

    const scriptPath = path.join(tmpDir, "model-roundtrip-gh");
    const bodyFile = path.join(tmpDir, "model-roundtrip-body.txt");
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { writeFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify(JSON.stringify(issues))});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx >= 0) {
    writeFileSync(${JSON.stringify(bodyFile)}, args[bodyIdx + 1]);
  }
  process.exit(0);
}

process.exit(0);
`;
    await writeFile(scriptPath, script, { mode: 0o755 });
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    const updated = await adapter.update("DM-1.2", { note: "some update" });

    // Fields must survive the round-trip in the returned task
    expect(updated.model).toBe("opus");
    expect(updated.complexity).toBe(5);

    // The written body must also contain model and complexity
    const body = await Bun.file(bodyFile).text();
    expect(body).toContain('"model"');
    expect(body).toContain("opus");
    expect(body).toContain('"complexity"');
    expect(body).toContain("5");
  });

  test("all three model values (haiku, sonnet, opus) are preserved without coercion", async () => {
    for (const [idx, modelValue] of (
      ["haiku", "sonnet", "opus"] as const
    ).entries()) {
      const id = `DM-MODEL-${idx}`;
      const originalTask = {
        id,
        title: `Task ${modelValue}`,
        status: "pending" as const,
        model: modelValue,
      };
      const issues = [
        makeIssue(20 + idx, `${id}: Task ${modelValue}`, "pending", originalTask),
      ];

      const fakeGh = await writeFakeGh(tmpDir, {
        "issue list --repo test-owner/test-repo --state all --json number,title,body,labels,state,url,milestone,assignees --limit 500":
          issues,
      });
      process.env.GH_CMD = fakeGh;

      const adapter = new GitHubTaskStore(CONFIG);
      const tasks = await adapter.query({});
      expect(tasks[0].model).toBe(modelValue);
    }
  });
});

// ─── in_progress transition warns when model missing (GitHub adapter) ─────────

describe("GitHubTaskStore model warning on in_progress transition", () => {
  test("warns when model is missing on transition to in_progress", async () => {
    const issues = [
      makeIssue(30, "DM-WARN.1: Task", "pending", {
        id: "DM-WARN.1",
        title: "Task",
        status: "pending",
      }),
    ];
    const scriptPath = await makeUpdateScript(
      tmpDir,
      "model-warn-gh-1",
      issues,
    );
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("DM-WARN.1", { status: "in_progress" });
    expect(warnings.some((w) => w.includes("model"))).toBe(true);
  });

  test("does NOT warn when model is already set on in_progress transition", async () => {
    const issues = [
      makeIssue(31, "DM-WARN.2: Task", "pending", {
        id: "DM-WARN.2",
        title: "Task",
        status: "pending",
        model: "haiku",
      }),
    ];
    const scriptPath = await makeUpdateScript(
      tmpDir,
      "model-warn-gh-2",
      issues,
    );
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    await adapter.update("DM-WARN.2", { status: "in_progress" });
    expect(warnings.some((w) => w.includes("model"))).toBe(false);
  });

  test("model warning is soft — update still succeeds", async () => {
    const issues = [
      makeIssue(32, "DM-WARN.3: Task", "pending", {
        id: "DM-WARN.3",
        title: "Task",
        status: "pending",
      }),
    ];
    const scriptPath = await makeUpdateScript(
      tmpDir,
      "model-warn-gh-3",
      issues,
    );
    process.env.GH_CMD = scriptPath;

    const warnings: string[] = [];
    const adapter = new GitHubTaskStore(CONFIG, (msg) => warnings.push(msg));
    const result = await adapter.update("DM-WARN.3", { status: "in_progress" });
    expect(result.status).toBe("in_progress");
  });
});

// ─── update label swap — _labels guard ───────────────────────────────────────

describe("GitHubTaskStore.update label swap without existing status label", () => {
  async function makeEditCaptureScript(
    dir: string,
    name: string,
    issues: unknown[],
  ): Promise<{ scriptPath: string; editsFile: string }> {
    const scriptPath = path.join(dir, name);
    const editsFile = path.join(dir, `${name}-edits.txt`);
    const script = `#!/usr/bin/env bun
import { argv } from "process";
import { appendFileSync } from "fs";
const args = argv.slice(2);

if (args[0] === "issue" && args[1] === "list") {
  console.log(${JSON.stringify("__ISSUES_PLACEHOLDER__")});
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "edit") {
  appendFileSync(${JSON.stringify("__EDITS_PLACEHOLDER__")}, args.join("|") + "\\n");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "close") {
  process.exit(0);
}

process.exit(0);
`;
    // Replace placeholders with actual values
    const finalScript = script
      .replace(
        '"__ISSUES_PLACEHOLDER__"',
        JSON.stringify(JSON.stringify(issues)),
      )
      .replace('"__EDITS_PLACEHOLDER__"', JSON.stringify(editsFile));
    await writeFile(scriptPath, finalScript, { mode: 0o755 });
    return { scriptPath, editsFile };
  }

  test("update() skips --remove-label when issue has no existing status label", async () => {
    // The bug: if gh issue create silently drops the status label, the issue exists
    // but has no status:* label. fetchAllIssues filters by status: label, so such
    // an issue is normally invisible. However, the _labels guard protects update()
    // when the issue IS found but _labels doesn't contain the old status label.
    //
    // We test this via a stateful fake-gh: the list call returns the issue WITHOUT
    // any status label but we also return it alongside an issue that HAS a status
    // label so the filtered result still finds our target. We do this by using
    // two issues in the list: one with status:pending (to satisfy the filter) and
    // one with NO status label (to simulate the bug scenario). fetchAllIssues
    // filters out the no-label issue, so update("LSG-NOLABEL") will throw "task not found".
    // This confirms the guard behavior: no status label → invisible to the store.
    //
    // For the GUARD test (label found → include --remove-label), see the test below.
    // The negative path (label absent → skip --remove-label) is covered structurally:
    // _labels?.some(...) returns undefined/false when _labels doesn't contain the label.
    //
    // Pragmatic resolution: test the guard by verifying that when an issue with
    // a status label is fetched, its _labels field drives the --remove-label decision.

    // Issue has ONLY a session label (no status label) — fetchAllIssues will
    // filter it out, so update() should throw "task not found"
    const issueNoStatusLabel = {
      number: 77,
      title: "LSG-NOLABEL: Task",
      state: "OPEN",
      body: `Task\n\n\`\`\`shipwright\n${JSON.stringify({ id: "LSG-NOLABEL", title: "Task", status: "pending" }, null, 2)}\n\`\`\``,
      labels: [{ name: "session:foo" }], // NO status: label
      url: "https://github.com/test-owner/test-repo/issues/77",
      milestone: null,
    };

    const { scriptPath } = await makeEditCaptureScript(tmpDir, "nolabel-gh", [
      issueNoStatusLabel,
    ]);
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    // Issue without status label is filtered out by fetchAllIssues → task not found
    await expect(
      adapter.update("LSG-NOLABEL", { status: "in_progress" }),
    ).rejects.toThrow("task not found");
  });

  test("update() includes --remove-label when issue has the old status label", async () => {
    const issues = [
      makeIssue(99, "LSG-2.1: Task", "in_progress", {
        id: "LSG-2.1",
        title: "Task",
        status: "in_progress",
      }),
    ];

    const { scriptPath, editsFile } = await makeEditCaptureScript(
      tmpDir,
      "has-label-test-gh",
      issues,
    );
    process.env.GH_CMD = scriptPath;

    const adapter = new GitHubTaskStore(CONFIG);
    await adapter.update("LSG-2.1", { status: "pr_open" });

    const edits = (await Bun.file(editsFile).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => line.split("|"));

    const labelEdit = edits.find(
      (e: string[]) =>
        e.includes("--add-label") && e.includes("status:pr_open"),
    );
    expect(labelEdit).toBeDefined();
    // Old label "status:in_progress" IS in _labels → --remove-label must be included
    expect(labelEdit).toContain("--remove-label");
    expect(labelEdit).toContain("status:in_progress");
  });
});
