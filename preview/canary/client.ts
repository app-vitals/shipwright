import { randomBytes } from "node:crypto";
import { readTargets, type Targets } from "./targets.ts";

export const CANARY_REPO = "canary/preview";

export function loadTargets(): Targets {
  return readTargets(process.env);
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function parseSessionCookie(setCookies: string[]): string | undefined {
  const entry = setCookies.find((c) => c.startsWith("admin_session="));
  return entry?.split(";")[0];
}

/** MCP Streamable HTTP replies are plain JSON or a single SSE `data:` event. */
export function parseMcpBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`no data line in SSE body: ${text}`);
    return JSON.parse(line.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

/**
 * Admin under auth.mode=open has no header auth: GET /admin/dev-login answers
 * 302 and sets an admin_session cookie that the API then requires (probe P4).
 */
export async function adminSessionCookie(adminUrl: string): Promise<string> {
  const res = await fetch(`${adminUrl}/admin/dev-login`, {
    redirect: "manual",
  });
  const cookie = parseSessionCookie(res.headers.getSetCookie());
  if (res.status !== 302 || !cookie) {
    throw new Error(
      `admin dev-login did not issue a session (status ${res.status})`,
    );
  }
  return cookie;
}

/**
 * Metrics read routes answer with a `{ data, meta }` envelope (`wrapResponse`
 * in metrics/src/formatters.ts), so the queue count lives at
 * `data.tasksBlocked`. Throws on any other shape so a contract drift fails
 * loudly instead of reading as "count never rose".
 */
export function parseQueueTasksBlocked(body: unknown): number {
  const value = (body as { data?: { tasksBlocked?: unknown } } | null)?.data
    ?.tasksBlocked;
  if (typeof value !== "number") {
    throw new Error(
      `metrics queue body has no numeric data.tasksBlocked: ${JSON.stringify(body)}`,
    );
  }
  return value;
}

export type CanaryTask = { id: string; title: string; session: string };

export async function createTask(
  t: Targets,
  fields: { status?: string } = {},
): Promise<CanaryTask> {
  const session = uniqueName("canary-session");
  const title = uniqueName("canary-task");
  const res = await fetch(`${t.taskStoreUrl}/tasks`, {
    method: "POST",
    headers: {
      ...bearer(t.taskStoreToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      status: fields.status ?? "pending",
      repo: CANARY_REPO,
      session,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`task create failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id, title, session };
}

/** Idempotent: a task already deleted by the test is not an error. */
export async function deleteTask(t: Targets, id: string): Promise<void> {
  const res = await fetch(`${t.taskStoreUrl}/tasks/${id}`, {
    method: "DELETE",
    headers: bearer(t.taskStoreToken),
  });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`task delete failed: ${res.status} ${await res.text()}`);
  }
}

export async function poll<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() + intervalMs > deadline) return undefined;
    await Bun.sleep(intervalMs);
  }
}
