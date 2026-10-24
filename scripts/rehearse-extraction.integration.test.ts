import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatFailure,
  parseArgs,
  planStages,
  type RehearsalOptions,
  rehearse,
} from "./rehearse-extraction";

// Each case extracts a tree and shells out to bun; cold runners are slow.
setDefaultTimeout(60_000);

const DRIVER = join(import.meta.dir, "rehearse-extraction.ts");

const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...IDENT },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!p.success) throw new Error(p.stderr.toString());
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Runs the driver as a subprocess, the way the workflow does. */
function runDriver(...args: string[]) {
  const p = Bun.spawnSync(["bun", DRIVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

let scratch: string;
let src: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rehearse-it-"));
  src = join(scratch, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  put(
    src,
    "platform-manifest.json",
    JSON.stringify({
      version: 1,
      description: "fixture",
      include: ["agent/src/runtime/**", "admin/**"],
      exclude: [],
      generated: [],
      compositionRoots: [],
      lib: [{ module: "util", tag: "platform-only", sharedWith: [] }],
      exemptions: [],
    }),
  );
  put(
    src,
    "agent/src/runtime/boot.ts",
    `import { util } from "../../../lib/util";\nexport const boot = util;\n`,
  );
  put(src, "bun.lock", "{}\n");
  put(src, "lib/util.ts", `export const util = 1;\n`);
  put(src, "lib/package.json", `{"name":"@app-vitals/agent-lib"}\n`);
  put(src, "agent/src/runtime/browser.ts", `export const browser = 1;\n`);
  put(src, "admin/src/a.ts", `export const a = 1;\n`);
  // The template's admin/src/main.ts imports these two.
  put(src, "admin/src/admin-boot.ts", `export const boot = 1;\n`);
  put(src, "admin/src/admin-extension.ts", `export const ext = 1;\n`);
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "fixture");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("rehearsal driver", () => {
  test("passes on a clean extraction", () => {
    const r = runDriver(
      "--source",
      src,
      "--mode",
      "no-history",
      "--scratch",
      join(scratch, "ok"),
      "--only",
      "boundary",
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ boundary");
    expect(r.out).toContain("REHEARSAL PASSED");
  });

  test("fails with a readable message on a planted boundary violation", () => {
    const r = runDriver(
      "--source",
      src,
      "--mode",
      "no-history",
      "--scratch",
      join(scratch, "bad"),
      "--only",
      "boundary",
      "--plant-violation",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("REHEARSAL FAILED [no-history] stage 'boundary'");
    expect(r.err).toContain("resolves outside the repository");
    expect(r.out).not.toContain("REHEARSAL PASSED");
  });

  test("reports an extraction failure as the extract stage", () => {
    const r = runDriver(
      "--source",
      src,
      "--ref",
      "no-such-ref",
      "--mode",
      "no-history",
      "--scratch",
      join(scratch, "noref"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("stage 'extract'");
  });

  test("rejects unknown arguments", () => {
    const r = runDriver("--bogus");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown argument: --bogus");
  });
});

describe("rehearse()", () => {
  const base = (): RehearsalOptions => parseArgs(["--source", src]);

  test("skips docker stages with --skip-docker", () => {
    const opts = {
      ...base(),
      modes: ["no-history" as const],
      scratch: join(scratch, "skip"),
      skipDocker: true,
      only: ["docker-admin", "docker-runtime", "contract-smoke"],
    };
    expect(rehearse(opts)).toBeNull();
  });

  test("returns the failing mode and stage", () => {
    const failure = rehearse({
      ...base(),
      modes: ["no-history"],
      scratch: join(scratch, "fail"),
      only: ["boundary"],
      plantViolation: true,
    });
    expect(failure?.stage).toBe("boundary");
    expect(formatFailure(failure as NonNullable<typeof failure>)).toContain(
      "not ready to cut",
    );
  });
});

describe("planStages", () => {
  test("covers every verification the cut depends on, in order", () => {
    expect(planStages().map((s) => s.name)).toEqual([
      "lock-prune",
      "install",
      "typecheck",
      "lint",
      "boundary",
      "db-sync",
      "test",
      "docker-admin",
      "docker-runtime",
      "contract-smoke",
    ]);
  });

  test("db-sync runs from admin/, where the extracted CI runs it", () => {
    const stage = planStages().find((s) => s.name === "db-sync");
    expect(stage?.cwd).toBe("admin");
    expect(stage?.cmd).toContain("--schema=prisma/schema");
    // The schema the command points at is relative to that directory.
    expect(
      existsSync(join(import.meta.dir, "..", "admin", "prisma", "schema")),
    ).toBe(true);
  });

  test("installs with a frozen lockfile", () => {
    expect(planStages()[1]?.cmd).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
    ]);
  });
});

describe("parseArgs", () => {
  test("defaults to both modes", () => {
    expect(parseArgs([]).modes).toEqual(["no-history", "history"]);
  });
  test("rejects a bad --mode", () => {
    expect(() => parseArgs(["--mode", "x"])).toThrow("--mode must be");
  });
});
