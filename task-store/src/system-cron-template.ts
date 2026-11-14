/**
 * task-store/src/system-cron-template.ts
 * Pure helpers for system-cron fires (SCR-1.1): template rendering, the
 * deterministic slot string, and the deterministic per-repo task id.
 *
 * Template rendering is deliberately NOT a template engine. The only
 * recognized placeholder is the exact five-character token `{repo}`, replaced
 * by plain split/join substitution — so `${x}`, `{{x}}`, `{other}`, `{REPO}`,
 * `<%= %>` and every other expression-looking sequence is left literal, and
 * nothing in either the template or the substituted value is ever evaluated
 * or re-scanned. split/join (rather than String.prototype.replace) also means
 * `$&` / `$1`-style replacement patterns in the repo value are inserted
 * verbatim.
 *
 * Slot format: the compact UTC basic-ISO-8601 form `YYYYMMDDTHHMMSSZ` of the
 * normalized `scheduledFor` instant (e.g. 2026-11-14T09:00:00Z →
 * `20261114T090000Z`). `scheduledFor` must carry an explicit timezone (`Z` or
 * `±HH:MM`) and is truncated to whole seconds, so every representation of the
 * same instant maps to the same slot and the same trigger row.
 *
 * Task id: `SC-{cronId}-{slot}-{owner}-{repo}`, where owner/repo are the two
 * halves of the `org/repo` string, as supplied.
 */

/** The only placeholder `renderRepoTemplate` recognizes. */
export const REPO_PLACEHOLDER = "{repo}";

/** Replace every literal `{repo}` with `repo`. Nothing else is interpreted. */
export function renderRepoTemplate(template: string, repo: string): string {
  return template.split(REPO_PLACEHOLDER).join(repo);
}

/** ISO-8601 date-time with a mandatory `Z` or `±HH:MM` designator. */
const ISO_WITH_ZONE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse a client-supplied `scheduledFor` into a whole-second UTC Date, or
 * null when it isn't an unambiguous ISO-8601 timestamp.
 */
export function parseScheduledFor(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_WITH_ZONE_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000);
}

/** Compact UTC slot string: `YYYYMMDDTHHMMSSZ`. */
export function formatSlot(scheduledFor: Date): string {
  return `${scheduledFor.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** Deterministic task id for one repo of one fired slot. */
export function systemCronTaskId(
  cronId: string,
  slot: string,
  repo: string,
): string {
  const [owner, name] = repo.split("/");
  return `SC-${cronId}-${slot}-${owner}-${name}`;
}

const CRON_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Definition ids are lowercase slugs — they're embedded in task ids. */
export function isValidCronId(id: string): boolean {
  return CRON_ID_RE.test(id);
}

const SYSTEM_CRON_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Strict `org/repo` check — repos are embedded in task ids. */
export function isValidSystemCronRepo(repo: string): boolean {
  return SYSTEM_CRON_REPO_RE.test(repo);
}
