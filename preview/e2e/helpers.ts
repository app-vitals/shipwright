/**
 * Local helpers for the preview browser specs. Runs under Playwright (Node),
 * so no bun-only APIs. Mirrors preview/canary/client.ts auth + agent calls.
 */

import { randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see task preview:e2e)`);
  return value;
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** admin under auth.mode=open: GET /admin/dev-login -> 302 + admin_session. */
export async function adminSessionToken(adminUrl: string): Promise<string> {
  const res = await fetch(`${adminUrl}/admin/dev-login`, {
    redirect: "manual",
  });
  const entry = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("admin_session="));
  const token = entry?.split(";")[0]?.slice("admin_session=".length);
  if (res.status !== 302 || !token) {
    throw new Error(
      `admin dev-login did not issue a session (status ${res.status})`,
    );
  }
  return token;
}

/** Authenticate a browser context for admin and (same cookie) metrics. */
export async function authenticate(
  context: BrowserContext,
  token: string,
  urls: string[],
): Promise<void> {
  await context.addCookies(
    urls.map((url) => ({ name: "admin_session", value: token, url })),
  );
}

export async function createAgent(
  adminUrl: string,
  token: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${adminUrl}/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `admin_session=${token}`,
    },
    body: JSON.stringify({ name, specialty: "coding", runtime: "in-cluster" }),
  });
  if (!res.ok) {
    throw new Error(`agent create failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { id: string }).id;
}

export async function deleteAgent(
  adminUrl: string,
  token: string,
  id: string,
): Promise<void> {
  const res = await fetch(`${adminUrl}/agents/${id}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Cookie: `admin_session=${token}`,
    },
    body: "{}",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`agent delete failed: ${res.status} ${await res.text()}`);
  }
}
