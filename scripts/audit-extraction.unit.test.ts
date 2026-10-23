import { describe, expect, test } from "bun:test";
import {
  BANNED_ALLOWLIST,
  BANNED_RULES,
  checkLicense,
  createPatchScanner,
  type Finding,
  findSecrets,
  makeExcerpt,
  matchArtifactPath,
  matchBannedStrings,
  parseArgs,
  parseGitleaksReport,
  redactSecrets,
  secretLineChecker,
} from "./audit-extraction";

// Fixtures are assembled at runtime so this file never holds a banned
// identifier or a token-shaped literal verbatim (check-strings, gitleaks).
const PRODUCT = ["vitals", "os"].join("-");
const PRIVATE_REPO = `app-vitals/${["market", "place"].join("")}`;
const ghToken = () =>
  `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6".slice(0, 36)}`;
const awsKey = () => `AKIA${"IOSFODNN7EXAMPLQ".slice(0, 16)}`;

const ids = (text: string) => matchBannedStrings(text).map((m) => m.rule);

describe("matchBannedStrings", () => {
  test("denies the internal product name in any casing", () => {
    expect(ids(`deploy to ${PRODUCT} now`)).toContain(
      "banned/internal-product",
    );
    expect(ids(`Sentry ${PRODUCT.toUpperCase()}-5T`)).toContain(
      "banned/internal-product",
    );
  });

  test("denies private app-vitals repositories, allows public ones", () => {
    expect(ids(`git clone ${PRIVATE_REPO}`)).toEqual(["banned/private-repo"]);
    expect(
      ids("see app-vitals/shipwright and app-vitals/agent-runtime"),
    ).toEqual([]);
  });

  test("denies internal hostnames and cloud identifiers", () => {
    expect(ids("curl http://db.prod.internal:5432")).toEqual([
      "banned/internal-hostname",
    ]);
    expect(ids("svc.ns.svc.cluster.local")).toContain(
      "banned/internal-hostname",
    );
    expect(ids("gke_acme-prod_us-central1_main")).toEqual([
      "banned/gcp-identifier",
    ]);
    expect(ids("runner@acme-prod-1234.iam.gserviceaccount.com")).toEqual([
      "banned/gcp-identifier",
    ]);
    expect(ids("image: gcr.io/acme-prod-1234/agent")).toEqual([
      "banned/gcp-identifier",
    ]);
  });

  test("denies the internal env-var prefix", () => {
    expect(ids(`${["VITALS", "OS"].join("_")}_API_KEY=`)).toContain(
      "banned/internal-env",
    );
  });

  test("allows placeholder hosts", () => {
    expect(ids("https://chat.example.com/x")).toEqual([]);
    expect(ids("http://api.internal.example.com")).toEqual([]);
    expect(ids("postgres://u:p@db.example.test/x")).toEqual([]);
  });

  test("an allowed token does not shield a banned one on the same line", () => {
    const line = `see app-vitals/shipwright and ${PRIVATE_REPO}`;
    expect(ids(line)).toEqual(["banned/private-repo"]);
  });

  test("reports 1-based line numbers and the matched text", () => {
    const [m] = matchBannedStrings(`ok\nok\nhost.corp here`);
    expect(m?.line).toBe(3);
    expect(m?.match).toBe("host.corp");
  });

  test("honours a custom rule list and allowlist", () => {
    const rules = [{ id: "t/x", description: "x", pattern: /acme-\w+/g }];
    const allow = [{ id: "a/x", description: "x", pattern: /acme-public/g }];
    expect(matchBannedStrings("acme-secret", rules, allow)).toHaveLength(1);
    expect(matchBannedStrings("acme-public", rules, allow)).toHaveLength(0);
    expect(matchBannedStrings("acme-secret", rules, [])).toHaveLength(1);
  });

  test("rule lists are typed and have unique ids", () => {
    const all = BANNED_RULES.map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    for (const r of [...BANNED_RULES, ...BANNED_ALLOWLIST]) {
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("secret detection and redaction", () => {
  test("detects common token shapes", () => {
    expect(findSecrets(`k=${awsKey()}`).map((h) => h.rule)).toEqual([
      "secret/aws-access-key",
    ]);
    expect(findSecrets(ghToken())[0]?.rule).toBe("secret/github-token");
    expect(
      findSecrets(
        `xox${"b"}-1234567890-1234567890123-abcdefghijABCDEFGHIJ12`,
      )[0]?.rule,
    ).toBe("secret/slack-token");
    expect(findSecrets(`-----BEGIN ${"RSA "}PRIVATE KEY-----`)[0]?.rule).toBe(
      "secret/private-key",
    );
    expect(
      findSecrets(`sk-ant-${"api03-Zx9Qw8Er7Ty6Ui5Op4As3Df"}`)[0]?.rule,
    ).toBe("secret/anthropic-key");
  });

  test("generic assignment needs a high-entropy value; placeholders pass", () => {
    expect(
      findSecrets(`const apiKey = "${"Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm"}"`)[0]
        ?.rule,
    ).toBe("secret/generic-api-key");
    expect(
      findSecrets(`apiKey: "your-api-key-goes-here-example-1234"`),
    ).toEqual([]);
    expect(findSecrets(`password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"`)).toEqual(
      [],
    );
  });

  test("generic assignment matches prefixed keyword names", () => {
    const v = "Zq8vLm3Np7Xr2Tk9Wb4Hc6Jd";
    for (const line of [
      `DB_PASSWORD="${v}"`,
      `OPENAI_API_KEY: "${v}"`,
      `CLIENT_SECRET='${v}'`,
      `STRIPE_SECRET_KEY="${v}"`,
    ])
      expect(findSecrets(line).map((h) => h.rule)).toEqual([
        "secret/generic-api-key",
      ]);
    // Test-fixture values are placeholders.
    expect(
      findSecrets(`webhook_secret: "test-webhook-secret-never-real"`),
    ).toEqual([]);
    // A letter/digit before the keyword is a different word.
    expect(findSecrets(`nopassword="${v}"`)).toEqual([]);
  });

  test("generic assignment matches unquoted values, not identifiers", () => {
    const v = "Zq8vLm3Np7Xr2Tk9Wb4Hc6Jd";
    expect(findSecrets(`password: ${v}`)[0]?.rule).toBe(
      "secret/generic-api-key",
    );
    expect(findSecrets(`DB_PASSWORD=${v}`)[0]?.rule).toBe(
      "secret/generic-api-key",
    );
    expect(makeExcerpt(`password: ${v}`)).not.toContain(v);
    // Code, not a credential: no digit, or continues as an expression.
    expect(findSecrets("apiKey: resolvedAnthropicApiKeyFromEnv,")).toEqual([]);
    expect(findSecrets("apiKey = configFromEnvironment2Value.key")).toEqual([]);
    expect(findSecrets("secret: buildSecretFromParts123Now(a)")).toEqual([]);
  });

  test("redaction never leaves the full value", () => {
    const tok = ghToken();
    const out = makeExcerpt(`GH_TOKEN=${tok} # note`);
    expect(out).not.toContain(tok);
    expect(out).toContain("ghp_[REDACTED:");
    expect(redactSecrets("nothing here")).toBe("nothing here");
  });
});

describe("matchArtifactPath", () => {
  test.each([
    ["node_modules/x/index.js", "artifact/node_modules"],
    ["admin/node_modules", "artifact/node_modules"],
    ["lib/dist/a.js", "artifact/build-output"],
    ["build/out.js", "artifact/build-output"],
    ["tsconfig.tsbuildinfo", "artifact/tsbuildinfo"],
    ["coverage/lcov.info", "artifact/coverage"],
    [".env", "artifact/env-file"],
    ["admin/.env.local", "artifact/env-file"],
    ["worktrees/a/b.ts", "artifact/worktrees"],
    ["vendor/pkg/.git/config", "artifact/nested-git"],
  ])("flags %s", (path, rule) => {
    expect(matchArtifactPath(path)).toBe(rule);
  });

  test.each([
    "src/index.ts",
    ".env.example",
    ".gitignore",
    ".github/workflows/ci.yml",
    "docs/distribution.md",
  ])("allows %s", (path) => {
    expect(matchArtifactPath(path)).toBeNull();
  });
});

describe("checkLicense", () => {
  const MIT =
    "MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, to any person";
  const pkg = (license?: string) => JSON.stringify({ name: "x", license });

  test("clean when LICENSE is MIT and fields agree", () => {
    expect(
      checkLicense({
        license: MIT,
        packages: { "package.json": pkg("MIT"), "lib/package.json": pkg() },
      }),
    ).toEqual([]);
  });

  test("flags missing LICENSE, non-MIT text and inconsistent fields", () => {
    const rules = (f: Finding[]) => f.map((x) => `${x.rule}:${x.file}`);
    expect(
      rules(
        checkLicense({
          license: null,
          packages: { "package.json": pkg("MIT") },
        }),
      ),
    ).toEqual(["license/missing:LICENSE"]);
    expect(
      rules(
        checkLicense({
          license: "All rights reserved",
          packages: { "package.json": pkg("MIT") },
        }),
      ),
    ).toEqual(["license/not-mit:LICENSE"]);
    expect(
      rules(
        checkLicense({
          license: MIT,
          packages: {
            "package.json": pkg("MIT"),
            "a/package.json": pkg("GPL-3.0"),
          },
        }),
      ),
    ).toEqual(["license/package-json:a/package.json"]);
    expect(
      rules(
        checkLicense({ license: MIT, packages: { "package.json": pkg() } }),
      ),
    ).toEqual(["license/package-json:package.json"]);
  });
});

describe("createPatchScanner", () => {
  test("only added lines are scanned, with commit, file and line number", () => {
    const tok = ghToken();
    const out: Finding[] = [];
    const feed = createPatchScanner(secretLineChecker, out);
    const patch = [
      "\u0001COMMIT abc123",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +10,3 @@",
      " context",
      `-removed ${awsKey()}`,
      `+const t = "${tok}";`,
    ];
    for (const l of patch) feed(l);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: "secret/github-token",
      file: "src/a.ts",
      commit: "abc123",
      line: 11,
    });
    expect(out[0]?.excerpt).not.toContain(tok);
  });
});

describe("parseGitleaksReport", () => {
  test("maps leaks to findings without copying the secret", () => {
    const [f] = parseGitleaksReport(
      JSON.stringify([
        {
          RuleID: "github-pat",
          File: "a.env",
          Commit: "deadbeef",
          StartLine: 3,
          Secret: "SECRETVALUE",
          Match: "token=SECRETVALUE",
        },
      ]),
    );
    expect(f).toMatchObject({
      rule: "gitleaks/github-pat",
      file: "a.env",
      commit: "deadbeef",
      line: 3,
    });
    expect(f?.excerpt).not.toContain("SECRETVALUE");
    expect(parseGitleaksReport("")).toEqual([]);
    expect(parseGitleaksReport("null")).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("parses flags and tree", () => {
    expect(
      parseArgs([
        "/t",
        "--json",
        "--report",
        "r.json",
        "--no-history-banned",
        "--no-gitleaks",
        "--working-tree-only",
      ]),
    ).toMatchObject({
      tree: "/t",
      json: true,
      report: "r.json",
      historyBanned: false,
      useGitleaks: false,
      workingTreeOnly: true,
    });
  });
  test("defaults are fail-closed: history banned strings, gitleaks, git history", () => {
    expect(parseArgs(["/t"])).toMatchObject({
      historyBanned: true,
      useGitleaks: true,
      workingTreeOnly: false,
    });
  });
  test("rejects bad input", () => {
    expect(() => parseArgs([])).toThrow("<tree>");
    expect(() => parseArgs(["/t", "--nope"])).toThrow("unknown argument");
    expect(() => parseArgs(["/t", "--report"])).toThrow("needs a value");
  });
});
