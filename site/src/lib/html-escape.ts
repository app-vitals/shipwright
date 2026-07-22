// Matches Astro's own text-node escaping for {expression} interpolation, so
// components using set:html to compose per-cell/per-item markup (e.g.
// ComparisonTable) produce the same entity-encoded output as plain JSX-style
// interpolation would (e.g. "codebase Q&A" -> "Q&amp;A").
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
