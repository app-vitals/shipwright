/**
 * dockerignore-plugin-context.content.test.ts
 *
 * `.dockerignore` excludes `coverage` / `**\/coverage` (build output). That
 * must not drop tracked source under plugins/ (notably
 * plugins/shipwright/scripts/coverage/) from the agent image build context.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;

interface Rule {
  re: RegExp;
  negated: boolean;
}

/** Convert a Docker (Go filepath.Match + `**`) glob to an anchored regex. */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function parseDockerignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1).trim();
    // Docker cleans the pattern and treats it as rooted at the context root.
    line = line.replace(/^\/+/, "").replace(/\/+$/, "");
    rules.push({ re: globToRegex(line), negated });
  }
  return rules;
}

/** Last matching rule wins; a rule matching the path or any ancestor dir applies. */
function isExcluded(rules: Rule[], path: string): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((c) => rule.re.test(c))) excluded = !rule.negated;
  }
  return excluded;
}

const rules = parseDockerignore(
  readFileSync(join(ROOT, ".dockerignore"), "utf8"),
);

describe(".dockerignore vs plugin build context", () => {
  it("excludes no tracked file under plugins/", () => {
    const res = Bun.spawnSync(["git", "ls-files", "plugins/"], { cwd: ROOT });
    const files = res.stdout.toString().split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => isExcluded(rules, f))).toEqual([]);
  });

  it("keeps plugins/shipwright/scripts/coverage/ in the context", () => {
    expect(
      isExcluded(rules, "plugins/shipwright/scripts/coverage/lcov.ts"),
    ).toBe(false);
  });

  it("still excludes coverage output dirs elsewhere", () => {
    expect(isExcluded(rules, "admin/coverage/x.html")).toBe(true);
    expect(isExcluded(rules, "coverage/lcov.info")).toBe(true);
    expect(isExcluded(rules, "node_modules/foo/index.js")).toBe(true);
  });
});
