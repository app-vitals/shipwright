/**
 * plugins/shipwright/scripts/prompt-audit/frontmatter.ts
 *
 * Minimal YAML-frontmatter reader for prompt files (name, description, paths).
 */

export interface Frontmatter {
  name?: string;
  description?: string;
  paths: string[];
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { paths: [], body: text };
  const out: Frontmatter = { paths: [], body: m[2] };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const block: string[] = [];
    while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1])) {
      block.push(lines[++i].trim());
    }
    if (key === "name") out.name = unquote(raw);
    else if (key === "description") {
      const joined = /^[>|][+-]?$/.test(raw.trim()) ? block.join(" ") : raw;
      out.description = unquote(joined).trim();
    } else if (key === "paths") {
      out.paths = raw.startsWith("[")
        ? raw.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean)
        : block.map((b) => unquote(b.replace(/^-\s*/, ""))).filter(Boolean);
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.trim().replace(/^(["'])(.*)\1$/, "$2");
}
