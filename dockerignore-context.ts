/** Minimal .dockerignore matcher shared by the image build-context content tests. */
export interface Rule {
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

export function parseDockerignore(text: string): Rule[] {
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
export function isExcluded(rules: Rule[], path: string): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((c) => rule.re.test(c))) excluded = !rule.negated;
  }
  return excluded;
}
