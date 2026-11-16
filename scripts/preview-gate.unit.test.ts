/**
 * scripts/preview-gate.unit.test.ts
 *
 * Pins the basic-auth gate helpers: password hygiene, htpasswd format, the
 * ingress annotations, the three-way gate verification, and that the `hash`
 * CLI never prints a password.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUsablePassword,
  buildHtpasswd,
  GATE_SECRET_NAME,
  gateIngressValues,
  helmSetEscape,
  verifyGate,
} from "./preview-gate.ts";

describe("assertUsablePassword", () => {
  it("refuses empty and whitespace-only input", () => {
    expect(() => assertUsablePassword("")).toThrow();
    expect(() => assertUsablePassword("\n")).toThrow();
    expect(() => assertUsablePassword("   \n")).toThrow();
  });

  it("strips exactly one trailing newline and keeps everything else", () => {
    expect(assertUsablePassword("p:a'ss\"\n")).toBe("p:a'ss\"");
    expect(assertUsablePassword("pw\n\n")).toBe("pw\n");
    expect(assertUsablePassword(" pw \n")).toBe(" pw ");
    expect(assertUsablePassword("pw")).toBe("pw");
  });
});

describe("buildHtpasswd", () => {
  it("emits one newline-terminated line per entry", () => {
    expect(buildHtpasswd(["a:$2y$x", "b:$2y$y"])).toBe("a:$2y$x\nb:$2y$y\n");
  });

  it("rejects an entry without a user:hash shape", () => {
    expect(() => buildHtpasswd(["nohash"])).toThrow();
    expect(() => buildHtpasswd([":hash"])).toThrow();
  });
});

describe("gateIngressValues", () => {
  it("names the gate Secret and strips the forwarded Authorization header", () => {
    const m = new Map(gateIngressValues());
    expect(m.get("nginx.ingress.kubernetes.io/auth-type")).toBe("basic");
    expect(m.get("nginx.ingress.kubernetes.io/auth-secret")).toBe(
      GATE_SECRET_NAME,
    );
    expect(m.has("nginx.ingress.kubernetes.io/auth-realm")).toBe(true);
    expect(m.get("nginx.ingress.kubernetes.io/configuration-snippet")).toBe(
      'proxy_set_header Authorization "";',
    );
  });

  it("escapes dots in helm --set keys", () => {
    expect(helmSetEscape("nginx.ingress.kubernetes.io/auth-type")).toBe(
      "nginx\\.ingress\\.kubernetes\\.io/auth-type",
    );
  });
});

type Call = { auth: string | null };
function fakeFetch(
  respond: (auth: string | null) => number,
  calls: Call[] = [],
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ auth });
    return new Response("", { status: respond(auth) });
  }) as unknown as typeof fetch;
}

const SELF = { user: "check-1", password: "selfpw" };
const selfHeader = `Basic ${btoa("check-1:selfpw")}`;
const happy = (auth: string | null): number =>
  auth === selfHeader ? 200 : 401;

describe("verifyGate", () => {
  it("passes on the happy path and sends three distinct requests", async () => {
    const calls: Call[] = [];
    const res = await verifyGate("http://x", SELF, fakeFetch(happy, calls));
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[0].auth).toBeNull();
    expect(calls[1].auth).not.toBeNull();
    expect(calls[1].auth).not.toBe(selfHeader);
    expect(calls[2].auth).toBe(selfHeader);
  });

  it("fails when unauthenticated is not 401", async () => {
    const res = await verifyGate(
      "http://x",
      SELF,
      fakeFetch((a) => (a === null ? 200 : happy(a))),
    );
    expect(res.ok).toBe(false);
  });

  it("fails when wrong credentials are not 401", async () => {
    const res = await verifyGate(
      "http://x",
      SELF,
      fakeFetch((a) => (a === null || a === selfHeader ? happy(a) : 200)),
    );
    expect(res.ok).toBe(false);
  });

  it("fails when the self-check credential does not get 200", async () => {
    const res = await verifyGate(
      "http://x",
      SELF,
      fakeFetch(() => 401),
    );
    expect(res.ok).toBe(false);
  });

  it("never puts a password in the failure reason", async () => {
    const res = await verifyGate(
      "http://x",
      SELF,
      fakeFetch(() => 401),
    );
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).not.toContain("selfpw");
    expect(res.reason).not.toContain(selfHeader);
  });
});

describe("hash CLI", () => {
  it("writes the htpasswd and selfcheck files and prints no password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-gate-test-"));
    try {
      const out = join(dir, "htpasswd");
      const password = "sup3r-secret-pw:'\"";
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "preview-gate.ts"), "hash", "--out", out],
        { stdin: new Blob([`${password}\n`]), stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);

      const self = readFileSync(`${out}.selfcheck`, "utf8").trim();
      const sep = self.indexOf(":");
      const [selfUser, selfPw] = [self.slice(0, sep), self.slice(sep + 1)];
      expect(selfPw.length).toBeGreaterThanOrEqual(16);
      for (const s of [password, selfPw]) {
        expect(stdout).not.toContain(s);
        expect(stderr).not.toContain(s);
      }
      expect(statSync(`${out}.selfcheck`).mode & 0o777).toBe(0o600);

      const lines = readFileSync(out, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^preview:\$2y\$/);
      expect(lines[1].startsWith(`${selfUser}:$2y$`)).toBe(true);
      // $2y$ is what htpasswd -B writes; Bun verifies it after prefix swap.
      const hash = lines[0].slice("preview:".length);
      expect(
        await Bun.password.verify(password, hash.replace("$2y$", "$2b$")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty password without writing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-gate-test-"));
    try {
      const out = join(dir, "htpasswd");
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "preview-gate.ts"), "hash", "--out", out],
        { stdin: new Blob(["  \n"]), stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).not.toBe(0);
      expect(() => statSync(out)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
