/**
 * metrics/src/formatters.ts
 * Date range resolution and response envelope formatting.
 *
 * All presets and the "future" validation check anchor to America/Los_Angeles
 * so the response meta agrees with the timezone-aware HogQL queries.
 */

import { type Clock, SystemClock } from "../lib/clock.ts";
import { DASHBOARD_TZ } from "./queries.ts";
import type { ResponseMeta } from "./schemas.ts";
import type { DatePreset, ResolvedDateRange } from "./types.ts";

export type { ResponseMeta } from "./schemas.ts";

// ─── Meta / Envelope types ────────────────────────────────────────────────────

export interface MetricsEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

// ─── LA timezone helpers ──────────────────────────────────────────────────────

/** Returns YYYY-MM-DD for the LA local date corresponding to this UTC instant. */
function laDateString(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: DASHBOARD_TZ });
}

/**
 * Returns the UTC instant equal to LA midnight on the given LA date string.
 * Tries both possible offsets (PST -08:00, PDT -07:00) and picks the one whose
 * resulting instant round-trips back to LA midnight on that date.
 */
function laMidnightUtc(laDateStr: string): Date {
  for (const offset of ["-07:00", "-08:00"]) {
    const candidate = new Date(`${laDateStr}T00:00:00${offset}`);
    if (laDateString(candidate) !== laDateStr) continue;
    const hour = candidate.toLocaleString("en-US", {
      timeZone: DASHBOARD_TZ,
      hour: "2-digit",
      hour12: false,
    });
    if (hour.startsWith("00")) return candidate;
  }
  return new Date(`${laDateStr}T08:00:00.000Z`);
}

/** Returns the LA date string N days before the given LA date string. */
function laDateMinus(laDateStr: string, days: number): string {
  // Parse YYYY-MM-DD as a UTC date for safe arithmetic, then format back to YYYY-MM-DD.
  const d = new Date(`${laDateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Returns the UTC instant equal to LA 23:59:59.999 on the given LA date string. */
function laEndOfDayUtc(laDateStr: string): Date {
  // End-of-day = next LA midnight - 1ms. Pure string arithmetic avoids the
  // DST-day asymmetry of (start + 24h).
  const nextMidnight = laMidnightUtc(laDateMinus(laDateStr, -1));
  return new Date(nextMidnight.getTime() - 1);
}

// ─── Date preset resolution ───────────────────────────────────────────────────

/**
 * Resolve a date preset to UTC instants anchored on LA (America/Los_Angeles)
 * day boundaries. All ranges are inclusive: from=start of LA-day, to=end of LA-day.
 */
export function resolvePreset(
  preset: DatePreset,
  clock: Clock = SystemClock(),
): ResolvedDateRange {
  const todayLA = laDateString(clock.now());
  const dayEnd = laEndOfDayUtc(todayLA);
  const daysBack =
    preset === "today" ? 0 : preset === "7d" ? 6 : preset === "30d" ? 29 : 89; // inclusive of today
  const dayStart = laMidnightUtc(laDateMinus(todayLA, daysBack));
  return { from: dayStart.toISOString(), to: dayEnd.toISOString(), preset };
}

// ─── Custom range validation ──────────────────────────────────────────────────

/**
 * Validate a custom date range (YYYY-MM-DD strings).
 * Returns an error message, or null if valid. The "future" check is anchored
 * on LA today so a date that is already past in LA wall-clock is accepted
 * even if UTC has rolled over.
 *
 * Rules:
 *   - from must be strictly before to
 *   - to cannot be a future LA calendar date (tomorrow LA or later)
 */
export function validateCustomRange(
  from: string,
  to: string,
  clock: Clock = SystemClock(),
): string | null {
  // Compare start-of-day for both so same-day ranges are rejected
  const fromDayMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toDayMs = new Date(`${to}T00:00:00.000Z`).getTime();

  if (Number.isNaN(fromDayMs) || Number.isNaN(toDayMs)) {
    return "invalid date format";
  }

  if (fromDayMs >= toDayMs) {
    return "from must be before to";
  }

  const todayLA = laDateString(clock.now());
  // Lexical YYYY-MM-DD comparison works because both strings are zero-padded.
  if (to > todayLA) {
    return "to date cannot be in the future";
  }

  return null;
}

// ─── Meta date range resolution ───────────────────────────────────────────────

/**
 * Resolve query params to a ResolvedDateRange for the response meta.
 * Falls back to the "today" preset when no valid range is provided so the meta
 * agrees with the dashboard's default view.
 */
export function resolveDateRangeForMeta(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
): ResolvedDateRange {
  if (
    preset === "today" ||
    preset === "7d" ||
    preset === "30d" ||
    preset === "90d"
  ) {
    return resolvePreset(preset);
  }
  if (from && to) {
    return {
      from: laMidnightUtc(from).toISOString(),
      to: laEndOfDayUtc(to).toISOString(),
    };
  }
  return resolvePreset("today");
}

// ─── Response envelope ────────────────────────────────────────────────────────

/** Wrap data in the standard metrics response envelope. */
export function wrapResponse<T>(
  data: T,
  meta: ResponseMeta,
): MetricsEnvelope<T> {
  return { data, meta };
}
