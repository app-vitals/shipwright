import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyTemplate,
  extractPlatform,
  TEMPLATE_DIR,
} from "./extract-platform";

const hasFilterRepo = Bun.spawnSync(["git", "filter-repo", "--version"], {
  stdout: "ignore",
  stderr: "ignore",
}).success;

const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...IDENT },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!p.success) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

let scratch: string;
let src: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "extract-it-"));
  src = join(scratch, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  put(
    src,
    "platform-manifest.json",
    JSON.stringify({
      version: 1,
      description: "fixture",
      include: ["agent/src/runtime/**", "agent/src/fixtures/**", "admin/**"],
      exclude: ["admin/src/coding/**", "admin/prisma/client/**"],
      generated: ["admin/prisma/client/**"],
      compositionRoots: [],
      lib: [{ module: "util", tag: "platform-only", sharedWith: [] }],
      exemptions: [],
    }),
  );
  put(src, "agent/src/runtime/boot.ts", `export const boot = 1;\n`);
  put(src, "agent/src/fixtures/f.ts", `export const f = 1;\n`);
  put(src, "lib/util.ts", `export const util = 1;\n`);
  put(src, "admin/src/a.ts", `export const a = 1;\n`);
  put(src, "admin/src/coding/c.ts", `export const c = 1;\n`);
  put(src, "admin/prisma/client/gen.ts", `export const gen = 1;\n`);
  put(src, "task-store/index.ts", `export const ts = 1;\n`);
  git(src, "add", "-A", "-f");
  git(src, "commit", "-q", "-m", "first");
  put(
    src,
    "agent/src/runtime/boot.ts",
    `import { f } from "../fixtures/f";\nexport const boot = f;\n`,
  );
  git(src, "commit", "-q", "-am", "second");
  // Untracked noise must never leak into the output.
  put(src, "worktrees/x/agent/src/runtime/leak.ts", `export {};\n`);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Paths the standalone-repo template adds to every extraction. */
const TEMPLATE_PATHS = applyTemplate(
  mkdtempSync(join(tmpdir(), "extract-it-template-")),
).map((p) => `./${p}`);

/** Everything in `root` except the template's files. */
function extracted(root: string): string[] {
  return listed(root).filter((p) => !TEMPLATE_PATHS.includes(p));
}

function listed(root: string): string[] {
  return Bun.spawnSync(
    ["find", ".", "-type", "f", "-not", "-path", "./.git/*"],
    {
      cwd: root,
      stdout: "pipe",
    },
  )
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .sort();
}

describe("extractPlatform", () => {
  test("--no-history copies the mapped set only", () => {
    const out = join(scratch, "nohist");
    const r = extractPlatform({
      source: src,
      ref: "HEAD",
      out,
      history: false,
      clean: false,
    });
    expect(r.head).toBeNull();
    expect(existsSync(join(out, ".git"))).toBe(false);
    expect(extracted(out)).toEqual([
      "./admin/src/a.ts",
      "./lib/util.ts",
      "./runtime/boot.ts",
      "./runtime/fixtures/f.ts",
    ]);
    expect(readFileSync(join(out, "runtime/boot.ts"), "utf8")).toContain(
      `from "./fixtures/f"`,
    );
  });

  test("--no-history copies the template, and it wins over a renamed file", () => {
    const out = join(scratch, "nohist");
    for (const path of TEMPLATE_PATHS)
      expect(existsSync(join(out, path))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(out, "package.json"), "utf8")).workspaces,
    ).toEqual(["runtime", "admin"]);
    expect(readFileSync(join(out, "runtime/Dockerfile"), "utf8")).toBe(
      readFileSync(join(TEMPLATE_DIR, "runtime/Dockerfile"), "utf8"),
    );
  });

  test("refuses a non-empty output unless --clean", () => {
    const out = join(scratch, "nohist");
    const opts = { source: src, ref: "HEAD", out, history: false };
    expect(() => extractPlatform({ ...opts, clean: false })).toThrow(
      "not empty",
    );
    expect(() => extractPlatform({ ...opts, clean: true })).not.toThrow();
  });

  test.skipIf(!hasFilterRepo)(
    "history mode preserves history, applies renames and is deterministic",
    () => {
      const a = join(scratch, "hist-a");
      const b = join(scratch, "hist-b");
      const base = { source: src, ref: "HEAD", history: true, clean: false };
      const ra = extractPlatform({ ...base, out: a });
      const rb = extractPlatform({ ...base, out: b });

      expect(ra.head).toBe(rb.head);
      expect(git(a, "rev-parse", "HEAD^{tree}")).toBe(
        git(b, "rev-parse", "HEAD^{tree}"),
      );
      expect(listed(a)).toEqual(listed(b));
      expect(extracted(a)).toEqual([
        "./admin/src/a.ts",
        "./lib/util.ts",
        "./runtime/boot.ts",
        "./runtime/fixtures/f.ts",
      ]);

      // Both source commits survive under the renamed path, plus the rewrite commit.
      const subjects = git(
        a,
        "log",
        "--follow",
        "--format=%s",
        "--",
        "runtime/boot.ts",
      );
      expect(subjects).toContain("first");
      expect(subjects).toContain("second");
      expect(git(a, "rev-list", "--count", "HEAD")).toBe("3");
      for (const path of TEMPLATE_PATHS) {
        expect(existsSync(join(a, path))).toBe(true);
      }
      expect(git(a, "remote")).toBe("");
      expect(git(a, "status", "--porcelain")).toBe("");
    },
  );
});
