#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";

/**
 * scripts/preview-gate.ts — basic-auth gate for the preview environment.
 *
 *   hash   --out <file>                    password on STDIN (never argv) ->
 *                                          htpasswd file + <file>.selfcheck
 *   verify --url <u> --selfcheck <file>    401 / 401 / 2xx-3xx gate check
 *
 * Findings (P5): ingress-nginx accepts bcrypt (`htpasswd -B`, `$2y$`) and
 * apr1; the admin rejects a forwarded `Authorization: Basic` header, so the
 * ingress strips it before proxying.
 *
 * No password is ever written to stdout, stderr, argv or an error message.
 */

export const GATE_USER = "preview";
export const GATE_SECRET_NAME = "shipwright-preview-gate";
/** ingress-nginx reads htpasswd content from this Secret key. */
export const GATE_SECRET_KEY = "auth";

export type SelfCheck = { user: string; password: string };
export type GateCheck = { ok: true } | { ok: false; reason: string };

/** bcrypt only uses the first 72 bytes; Bun pre-hashes longer input, which crypt(3) in nginx cannot verify. */
export const MAX_PASSWORD_BYTES = 72;

/** Strip exactly one trailing newline; refuse empty, whitespace-only, or over-72-byte input. */
export function assertUsablePassword(raw: string): string {
  const pw = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (pw.trim() === "") {
    throw new Error("password is empty or whitespace-only");
  }
  if (Buffer.byteLength(pw, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(
      `password exceeds ${MAX_PASSWORD_BYTES} bytes (bcrypt limit; nginx would reject it)`,
    );
  }
  return pw;
}

/** `user:hash` lines, newline-terminated. */
export function buildHtpasswd(lines: string[]): string {
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 1 || i === line.length - 1) {
      throw new Error("htpasswd entry must look like user:hash");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Ordered ingress-nginx annotations for `networking.ingress.annotations`.
 *
 * NOTE: `configuration-snippet` is rejected by ingress-nginx v1.12.1 unless
 * the controller ConfigMap sets `allow-snippet-annotations: "true"` (default
 * false since v1.9) and `annotations-risk-level: Critical` (snippets are
 * Critical; the default allows up to High). preview-env.ts patches the
 * ConfigMap when a gate is requested.
 */
export function gateIngressValues(): [string, string][] {
  const p = "nginx.ingress.kubernetes.io/";
  return [
    [`${p}auth-type`, "basic"],
    [`${p}auth-secret`, GATE_SECRET_NAME],
    [`${p}auth-realm`, "Shipwright preview"],
    [`${p}configuration-snippet`, 'proxy_set_header Authorization "";'],
  ];
}

/** Escape dots so a helm `--set` key is one map key, not a path. */
export function helmSetEscape(key: string): string {
  return key.replaceAll(".", "\\.");
}

const basic = (user: string, password: string): string =>
  `Basic ${btoa(`${user}:${password}`)}`;

export async function verifyGate(
  url: string,
  selfCheck: SelfCheck,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<GateCheck> {
  const status = async (auth?: string): Promise<number> =>
    (
      await fetchFn(url, {
        headers: auth ? { Authorization: auth } : {},
        redirect: "manual",
      })
    ).status;
  try {
    const none = await status();
    if (none !== 401) {
      return { ok: false, reason: `no credentials: expected 401, got ${none}` };
    }
    const wrong = await status(
      basic(selfCheck.user, randomBytes(12).toString("hex")),
    );
    if (wrong !== 401) {
      return {
        ok: false,
        reason: `wrong credentials: expected 401, got ${wrong}`,
      };
    }
    const good = await status(basic(selfCheck.user, selfCheck.password));
    // Redirects are not followed, so a 3xx is the app answering behind the
    // gate (the admin UI redirects `/`). Any 2xx or 3xx means it let us in.
    if (good < 200 || good >= 400) {
      return {
        ok: false,
        reason: `self-check credentials: expected 2xx or 3xx, got ${good}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `request failed: ${(err as Error).name}` };
  }
}

async function bcryptHash(pw: string): Promise<string> {
  const h = await Bun.password.hash(pw, { algorithm: "bcrypt" });
  // htpasswd -B writes $2y$; Bun writes $2b$. Same algorithm.
  return h.replace(/^\$2b\$/, "$2y$");
}

/** Write the htpasswd file and `<out>.selfcheck`. Prints nothing secret. */
export async function hashToFiles(
  rawStdin: string,
  out: string,
): Promise<void> {
  const password = assertUsablePassword(rawStdin);
  const self: SelfCheck = {
    user: `check-${randomBytes(4).toString("hex")}`,
    password: randomBytes(16).toString("hex"),
  };
  const htpasswd = buildHtpasswd([
    `${GATE_USER}:${await bcryptHash(password)}`,
    `${self.user}:${await bcryptHash(self.password)}`,
  ]);
  writeFileSync(out, htpasswd, { mode: 0o600 });
  writeFileSync(`${out}.selfcheck`, `${self.user}:${self.password}\n`, {
    mode: 0o600,
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const flags = parseFlags(process.argv, [
    "--out",
    "--url",
    "--selfcheck",
  ] as const);
  if (cmd === "hash" && flags["--out"]) {
    const out = flags["--out"];
    await hashToFiles(await Bun.stdin.text(), out);
    console.log(`[gate] wrote ${out} and ${out}.selfcheck`);
    return;
  }
  if (cmd === "verify" && flags["--url"] && flags["--selfcheck"]) {
    const raw = readFileSync(flags["--selfcheck"], "utf8").trim();
    const i = raw.indexOf(":");
    const res = await verifyGate(
      flags["--url"],
      { user: raw.slice(0, i), password: raw.slice(i + 1) },
      globalThis.fetch,
    );
    if (!res.ok) throw new Error(`gate check failed: ${res.reason}`);
    console.log(
      "[gate] OK: 401 without credentials, 401 wrong, self-check let through",
    );
    return;
  }
  console.error(
    "usage: preview-gate.ts hash --out <file>   (password on stdin)\n" +
      "       preview-gate.ts verify --url <u> --selfcheck <file>",
  );
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[gate] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
