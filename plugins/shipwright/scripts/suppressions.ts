/**
 * plugins/shipwright/scripts/suppressions.ts
 *
 * Parse, match and expiry evaluation for `.shipwright/suppressions.yml`.
 * Schema and semantics: references/suppressions-schema.md.
 *
 * Self-contained (imports only js-yaml and ./clock.ts) so it runs from the
 * plugin cache install location.
 */

import * as yaml from "js-yaml";
import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SuppressionRule = "osv" | "grype" | "entropy" | "posture";
export type SuppressionStatus = "false_positive" | "accepted_risk";

export const DEFAULT_ACCEPTED_RISK_DAYS = 90;

/** Required stable match-key fields per rule. Line numbers are never part of a key. */
export const MATCH_KEYS: Record<SuppressionRule, readonly string[]> = {
  osv: ["cve", "package"],
  grype: ["cve", "package"],
  entropy: ["file", "symbol"],
  posture: ["path"],
};

export interface Suppression {
  rule: SuppressionRule;
  match: Record<string, string>;
  status: SuppressionStatus;
  reason: string;
  addedBy: string;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD; present for accepted_risk only. Active through the end of this day (UTC). */
  expires?: string;
}

/** A scanner finding. Extra fields (e.g. `line`) are ignored for matching. */
export interface Finding {
  rule: string;
  cve?: string;
  package?: string;
  file?: string;
  symbol?: string;
  path?: string;
  line?: number;
}

export interface ExpiryResult {
  expired: boolean;
  /** Whole days until the expires day ends; null when the entry never expires. */
  daysRemaining: number | null;
}

export class SuppressionsError extends Error {
  constructor(public readonly errors: string[]) {
    super(
      `Invalid suppressions file:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    this.name = "SuppressionsError";
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(v: unknown): string | null {
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (
    typeof v === "string" &&
    DATE_RE.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  )
    return v;
  return null;
}

/** Default accepted_risk expiry: `date` + `days` (default 90), as YYYY-MM-DD. */
export function defaultExpiry(
  date: string,
  days: number = DEFAULT_ACCEPTED_RISK_DAYS,
): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// ─── Parse ────────────────────────────────────────────────────────────────────

const isNonBlank = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * Parse and validate suppressions YAML. Throws SuppressionsError listing every
 * problem found. Empty input yields no entries.
 */
export function parseSuppressions(text: string): Suppression[] {
  if (text.trim() === "") return [];
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new SuppressionsError([`YAML parse error: ${(e as Error).message}`]);
  }
  if (doc === undefined || doc === null) return [];
  const list = (doc as { suppressions?: unknown }).suppressions;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list))
    throw new SuppressionsError(["`suppressions` must be a list"]);

  const errors: string[] = [];
  const out: Suppression[] = [];
  list.forEach((raw, i) => {
    const at = `suppressions[${i}]`;
    const before = errors.length;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${at}: entry must be a mapping`);
      return;
    }
    const e = raw as Record<string, unknown>;

    const rule = e.rule as SuppressionRule;
    const ruleOk = typeof rule === "string" && Object.hasOwn(MATCH_KEYS, rule);
    if (!ruleOk) {
      errors.push(
        `${at}: unknown rule "${String(e.rule)}" (expected one of ${Object.keys(MATCH_KEYS).join(", ")})`,
      );
    }

    const match: Record<string, string> = {};
    if (
      typeof e.match !== "object" ||
      e.match === null ||
      Array.isArray(e.match)
    ) {
      errors.push(`${at}: match is required and must be a mapping`);
    } else if (ruleOk) {
      const m = e.match as Record<string, unknown>;
      for (const key of MATCH_KEYS[rule]) {
        if (!isNonBlank(m[key]))
          errors.push(`${at}: match.${key} is required for rule "${rule}"`);
        else match[key] = m[key];
      }
      for (const key of Object.keys(m)) {
        if (!MATCH_KEYS[rule].includes(key)) {
          errors.push(
            key === "line" || key === "column"
              ? `${at}: match.${key} is not allowed; match keys must not contain line numbers`
              : `${at}: unexpected match.${key} for rule "${rule}"`,
          );
        }
      }
    }

    const status = e.status as SuppressionStatus;
    if (status !== "false_positive" && status !== "accepted_risk") {
      errors.push(`${at}: status must be false_positive or accepted_risk`);
    }
    if (!isNonBlank(e.reason))
      errors.push(`${at}: reason is required and must be non-empty`);
    if (!isNonBlank(e.addedBy))
      errors.push(`${at}: addedBy is required and must be non-empty`);

    const date = toDateString(e.date);
    if (date === null)
      errors.push(`${at}: date is required and must be YYYY-MM-DD`);

    let expires: string | undefined;
    if (e.expires !== undefined && e.expires !== null) {
      const x = toDateString(e.expires);
      if (x === null) errors.push(`${at}: expires must be YYYY-MM-DD`);
      else expires = x;
    }
    if (status === "accepted_risk" && e.expires == null) {
      errors.push(
        `${at}: expires is required for accepted_risk (suggested: ${date ? defaultExpiry(date) : "date + 90 days"})`,
      );
    }
    if (status === "false_positive" && e.expires != null) {
      errors.push(`${at}: false_positive entries never expire; remove expires`);
    }
    if (date && expires && expires < date)
      errors.push(`${at}: expires (${expires}) is before date (${date})`);

    if (errors.length === before && ruleOk && date) {
      out.push({
        rule,
        match,
        status,
        reason: (e.reason as string).trim(),
        addedBy: (e.addedBy as string).trim(),
        date,
        ...(expires ? { expires } : {}),
      });
    }
  });

  if (errors.length > 0) throw new SuppressionsError(errors);
  return out;
}

// ─── Expiry ───────────────────────────────────────────────────────────────────

/**
 * An accepted_risk entry is active through the whole `expires` day (UTC) and
 * expired from 00:00:00Z the following day. false_positive never expires.
 */
export function evaluateExpiry(
  entry: Suppression,
  clock: Clock = SystemClock(),
): ExpiryResult {
  if (entry.status === "false_positive" || !entry.expires)
    return { expired: false, daysRemaining: null };
  const endMs = Date.parse(`${entry.expires}T00:00:00Z`) + DAY_MS;
  const remaining = endMs - clock.now().getTime();
  return {
    expired: remaining <= 0,
    daysRemaining: Math.max(0, Math.floor(remaining / DAY_MS)),
  };
}

// ─── Match ────────────────────────────────────────────────────────────────────

function keyMatches(entry: Suppression, finding: Finding): boolean {
  if (entry.rule !== finding.rule) return false;
  const f = finding as unknown as Record<string, unknown>;
  return MATCH_KEYS[entry.rule].every((key) => {
    const want = entry.match[key];
    const got = f[key];
    if (typeof want !== "string" || typeof got !== "string") return false;
    return key === "cve"
      ? want.toUpperCase() === got.toUpperCase()
      : want === got;
  });
}

/**
 * Find the suppression entry matching a finding by rule + stable match key.
 * Expired entries are skipped unless `includeExpired` is set.
 */
export function findSuppression(
  entries: Suppression[],
  finding: Finding,
  clock: Clock = SystemClock(),
  opts: { includeExpired?: boolean } = {},
): Suppression | undefined {
  return entries.find(
    (e) =>
      keyMatches(e, finding) &&
      (opts.includeExpired || !evaluateExpiry(e, clock).expired),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/** `bun suppressions.ts <suppressions.yml>` — validate and print a summary. */
if (import.meta.main) {
  const file = process.argv[2] ?? ".shipwright/suppressions.yml";
  const f = Bun.file(file);
  if (!(await f.exists())) {
    console.log(JSON.stringify({ file, entries: 0, expired: 0 }));
    process.exit(0);
  }
  try {
    const entries = parseSuppressions(await f.text());
    const expired = entries.filter((e) => evaluateExpiry(e).expired).length;
    console.log(JSON.stringify({ file, entries: entries.length, expired }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
