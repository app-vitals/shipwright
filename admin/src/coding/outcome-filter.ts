/**
 * admin/src/coding/outcome-filter.ts
 * Shared multi-select outcome filter helpers (COF-2.1) for the Queue &
 * Activity pages. Options match the labels produced by cronRunOutcomeLabel;
 * "skipped" is hidden unless selected.
 */

export const OUTCOME_FILTER_OPTIONS = [
  "completed",
  "skipped",
  "failed",
  "unknown",
] as const;

/** Selection applied when the request carries no `outcome` param. */
export const DEFAULT_OUTCOMES: readonly string[] = [
  "completed",
  "failed",
  "unknown",
];

/**
 * Parse repeated `outcome` query values into the effective selection. Blank
 * values are dropped and duplicates collapsed; a single legacy value (e.g.
 * "error") is passed through unchanged. No values -> DEFAULT_OUTCOMES.
 */
export function parseOutcomeParams(values: readonly string[]): string[] {
  const picked = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  return picked.length > 0 ? picked : [...DEFAULT_OUTCOMES];
}

/** Render the `<option>` list for the multi-select, marking selected values. */
export function renderOutcomeOptions(selected: readonly string[]): string {
  return OUTCOME_FILTER_OPTIONS.map((o) => {
    const attr = selected.includes(o) ? " selected" : "";
    return `<option value="${o}"${attr}>${o}</option>`;
  }).join("\n");
}

/** Append every selected outcome to `params` as repeated `outcome` entries. */
export function appendOutcomeParams(
  params: URLSearchParams,
  selected: readonly string[],
): void {
  for (const o of selected) params.append("outcome", o);
}
