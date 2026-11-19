/**
 * Content guard for .github/workflows/preview.yml: the label-triggered preview
 * runs under `pull_request_target` with a secret, so the trust boundary (code
 * executed comes only from the default-branch checkout `trusted/`; the PR
 * checkout `pr/` is a build context) is enforced here.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  "working-directory"?: string;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  steps: Step[];
};
type Workflow = {
  on: Record<string, { types?: string[]; inputs?: Record<string, unknown> }>;
  jobs: Record<string, Job>;
};

const text = readFileSync(join(ROOT, ".github/workflows/preview.yml"), "utf8");
const wf = Bun.YAML.parse(text) as Workflow;
const request = wf.jobs.request as Job;
const preview = wf.jobs.preview as Job;
const steps = preview.steps;

const stepText = (s: Step) => JSON.stringify(s);
const idx = (pred: (s: Step) => boolean, what: string): number => {
  const i = steps.findIndex(pred);
  if (i < 0) throw new Error(`no step found: ${what}`);
  return i;
};
const named = (re: RegExp) => (s: Step) => re.test(s.name ?? "");

const checkoutTrusted = () =>
  idx(
    (s) =>
      !!s.uses?.startsWith("actions/checkout@") && s.with?.path === "trusted",
    "trusted checkout",
  );
const checkoutPr = () =>
  idx(
    (s) => !!s.uses?.startsWith("actions/checkout@") && s.with?.path === "pr",
    "pr checkout",
  );
const tunnel = () => idx(named(/start .*tunnel/i), "tunnel start");
const bringUp = () =>
  idx((s) => s.uses === "./trusted/.github/actions/preview-env", "bring-up");
const verify = () =>
  idx((s) => /preview-gate\.ts verify/.test(s.run ?? ""), "gate verify");
const comment = () => idx(named(/post .*comment/i), "live comment");
const hold = () =>
  idx((s) => /preview-hold\.ts --repo/.test(s.run ?? ""), "hold");
const stopTunnel = () => idx(named(/stop .*tunnel/i), "stop tunnel");
const expire = () => idx(named(/expired/i), "expire comment");

describe("preview.yml triggers", () => {
  it("triggers on pull_request_target labeled and workflow_dispatch only", () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      "pull_request_target",
      "workflow_dispatch",
    ]);
    expect(wf.on.pull_request_target?.types).toEqual(["labeled"]);
    expect(Object.keys(wf.on.workflow_dispatch?.inputs ?? {}).sort()).toEqual([
      "pr_number",
      "window_minutes",
    ]);
  });
});

describe("request job", () => {
  it("has no environment and runs before the preview job", () => {
    expect(request.environment).toBeUndefined();
    expect(Object.keys(wf.jobs)[0]).toBe("request");
    expect(preview.needs).toBe("request");
  });

  it("only proceeds for the preview label or a manual run", () => {
    expect(request.if).toContain("workflow_dispatch");
    expect(request.if).toContain("github.event.label.name == 'preview'");
  });

  it("rejects a PR whose head repo differs from the base repo", () => {
    const run = request.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("head.repo.full_name");
    expect(run).toContain("base.repo.full_name");
    expect(run).toMatch(/fork/i);
    expect(run).toMatch(/exit 1/);
  });

  it("never interpolates dispatch inputs into a script", () => {
    for (const s of request.steps) {
      expect(s.run ?? "").not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
    }
  });
});

describe("preview job", () => {
  it("is environment-gated with a 355-minute timeout", () => {
    expect(preview.environment).toBe("preview");
    expect(preview["timeout-minutes"]).toBe(355);
  });

  it("has exactly contents: read and pull-requests: write", () => {
    expect(preview.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
  });

  it("allows one preview per PR: group has the PR number, no cancel", () => {
    expect(preview.concurrency?.group).toContain("pr_number");
    expect(preview.concurrency?.["cancel-in-progress"] ?? false).toBe(false);
  });

  it("SHA-pins every third-party action", () => {
    for (const s of [...request.steps, ...steps]) {
      if (!s.uses || s.uses.startsWith("./")) continue;
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe("secret handling", () => {
  it("references secrets.PREVIEW_PASSWORD in exactly one step, before the PR checkout", () => {
    const withSecret = steps
      .map((s, i) => [s, i] as const)
      .filter(([s]) => stepText(s).includes("secrets.PREVIEW_PASSWORD"));
    expect(withSecret.length).toBe(1);
    expect(withSecret[0]?.[1]).toBeLessThan(checkoutPr());
    expect(text.match(/secrets\.PREVIEW_PASSWORD/g)?.length).toBe(1);
  });

  it("fails closed with a clear message when the password is empty", () => {
    const s = steps.find((x) =>
      stepText(x).includes("secrets.PREVIEW_PASSWORD"),
    );
    expect(s?.run).toMatch(/-z/);
    expect(s?.run).toMatch(/not configured/);
    expect(s?.run).toMatch(/exit 1/);
  });

  it("passes the password on stdin, never argv", () => {
    const s = steps.find((x) =>
      stepText(x).includes("secrets.PREVIEW_PASSWORD"),
    );
    expect(s?.run).toMatch(/printf '%s' "\$PREVIEW_PASSWORD" \| bun/);
  });

  it("references the job token only in the comment and hold steps", () => {
    const allowed = new Set([comment(), hold(), expire()]);
    steps.forEach((s, i) => {
      if (/GITHUB_TOKEN|github\.token/.test(stepText(s))) {
        expect(allowed.has(i)).toBe(true);
      }
    });
    expect(allowed.size).toBe(3);
  });
});

describe("trust boundary", () => {
  it("checks out the default branch to trusted/ and the PR head to pr/ without credentials", () => {
    const t = steps[checkoutTrusted()] as Step;
    const p = steps[checkoutPr()] as Step;
    expect(String(t.with?.ref)).toContain("default_branch");
    expect(String(p.with?.ref)).toContain("head_sha");
    expect(p.with?.["persist-credentials"]).toBe(false);
    expect(t.with?.["persist-credentials"]).toBe(false);
  });

  it("only the pr/ checkout fetches PR code", () => {
    for (const s of steps) {
      if (!s.uses?.startsWith("actions/checkout@")) continue;
      if (s.with?.path === "pr") continue;
      expect(String(s.with?.ref)).toContain("default_branch");
    }
  });

  it("every local action comes from trusted/", () => {
    const locals = steps.filter((s) => s.uses?.startsWith("./"));
    expect(locals.length).toBeGreaterThan(0);
    for (const s of locals) expect(s.uses).toStartWith("./trusted/");
  });

  it("no run step executes a file under pr/", () => {
    const bad =
      /(bun run|bun|bash|sh|source|\.|task -d|task --dir)\s+\.?\/?pr\/|(^|[\s;&|(])\.\/pr\/|task\s+(-d|--dir)[ =]pr\b|working-directory:\s*pr/;
    for (const s of steps) {
      expect(s.run ?? "").not.toMatch(bad);
      expect(s["working-directory"] ?? "").not.toMatch(/^\.?\/?pr(\/|$)/);
    }
  });
});

describe("step order", () => {
  it("hashes the password after trusted checkout and before the PR checkout", () => {
    const hash = idx(
      (s) => /preview-gate\.ts hash/.test(s.run ?? ""),
      "hash step",
    );
    expect(hash).toBeGreaterThan(checkoutTrusted());
    expect(hash).toBeLessThan(checkoutPr());
  });

  it("starts the tunnel before the bring-up and passes its host to the action", () => {
    expect(tunnel()).toBeGreaterThan(checkoutPr());
    expect(tunnel()).toBeLessThan(bringUp());
    const w = (steps[bringUp()] as Step).with ?? {};
    expect(w["source-path"]).toBe("pr");
    expect(w["trusted-path"]).toBe("trusted");
    expect(String(w.host)).toContain("steps.tunnel.outputs.host");
    expect(String(w["htpasswd-file"])).toContain("htpasswd");
  });

  it("runs helm test, canary and e2e from trusted/ after bring-up and before verify", () => {
    for (const re of [/helm test/, /task preview:canary/, /task preview:e2e/]) {
      const i = idx((s) => re.test(s.run ?? ""), String(re));
      expect(i).toBeGreaterThan(bringUp());
      expect(i).toBeLessThan(verify());
    }
    for (const re of [/task preview:canary/, /task preview:e2e/]) {
      const s = steps.find((x) => re.test(x.run ?? "")) as Step;
      expect(s["working-directory"]).toBe("trusted");
    }
  });

  it("posts the comment after gate verification, then holds", () => {
    expect(comment()).toBeGreaterThan(verify());
    expect(hold()).toBeGreaterThan(comment());
  });

  it("warns (does not fail) when the token cannot read environment rules", () => {
    const s = steps.find(named(/precondition/i)) as Step;
    expect(s.run).toMatch(/::warning::/);
    expect(s.run).toMatch(/required reviewers/i);
  });
});

describe("cleanup", () => {
  it("stops the tunnel, always, before marking the comment expired", () => {
    expect((steps[stopTunnel()] as Step).if).toContain("always()");
    expect((steps[expire()] as Step).if).toContain("always()");
    expect(stopTunnel()).toBeLessThan(expire());
    expect(stopTunnel()).toBeGreaterThan(hold());
    expect((steps[stopTunnel()] as Step).run).toContain("kill");
  });
});

describe("pinned cloudflared", () => {
  it("verifies a SHA-256 before running the binary", () => {
    const s = steps[tunnel()] as Step;
    expect(s.run).toMatch(/sha256sum -c/);
    expect(s.run).toMatch(/[0-9a-f]{64}/);
    expect(s.run).toMatch(/VERSION=\d{4}\.\d+\.\d+/);
    expect(s.run).toContain("cloudflare/cloudflared/releases/download/");
    expect(s.run).toContain("http://127.0.0.1:18080");
    expect(s.run).toMatch(/60/);
  });
});

describe("hygiene", () => {
  it("contains no org-specific name", () => {
    expect(text).not.toMatch(/app-vitals/i);
  });
});
