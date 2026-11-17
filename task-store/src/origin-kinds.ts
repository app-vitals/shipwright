/**
 * Registered task origin kinds (PLU-2.5) — the single list behind
 * `Task.originKind`. The write validator (routes/tasks.ts) and the
 * `GET /tasks?originKind=` filter (openapi-schemas.ts) both read it, so a value
 * a row can hold is always a value the filter accepts. Adding a kind is a
 * one-place change: append it here. The column stays a plain string, so no
 * migration is needed.
 */
export const ORIGIN_KINDS = ["document", "skill", "cron", "human"] as const;

export type OriginKind = (typeof ORIGIN_KINDS)[number];

export function isOriginKind(value: unknown): value is OriginKind {
  return (
    typeof value === "string" &&
    (ORIGIN_KINDS as readonly string[]).includes(value)
  );
}
