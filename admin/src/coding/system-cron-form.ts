/**
 * admin/src/coding/system-cron-form.ts
 * Pure validation for the system-crons settings page's template form (SCR-1.4).
 *
 * Mirrors the task-store's rules (task-store/src/system-cron-service.ts and
 * system-cron-template.ts): both templates must be non-empty strings, and
 * `{repo}` is the only placeholder — substituted by plain string replacement,
 * nothing else is evaluated. Other brace/expression-looking sequences are legal
 * (they stay literal) but flagged as warnings so a typo like `{Repo}` or
 * `{{repo}}` doesn't go unnoticed. Kept dependency-free so it is unit-testable.
 */

/** The only placeholder the task-store substitutes. */
export const REPO_PLACEHOLDER = "{repo}";

/** Defensive caps; the task-store itself only requires non-empty. */
export const MAX_TITLE_TEMPLATE_LENGTH = 200;
export const MAX_DESCRIPTION_TEMPLATE_LENGTH = 10_000;

export interface TemplateFormInput {
  titleTemplate: string;
  descriptionTemplate: string;
}

export type TemplateFormResult =
  | {
      ok: true;
      value: TemplateFormInput;
      /** Non-blocking notes, e.g. unrecognized `{...}` tokens. */
      warnings: string[];
    }
  | { ok: false; errors: string[] };

/** `{word}` tokens other than the recognized placeholder. */
function unknownPlaceholders(template: string): string[] {
  const found = template.match(/\{[^{}\s]*\}/g) ?? [];
  return [...new Set(found.filter((t) => t !== REPO_PLACEHOLDER))];
}

/** Validate the edited title/description templates for one definition. */
export function validateTemplateForm(
  raw: Partial<Record<keyof TemplateFormInput, unknown>>,
): TemplateFormResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const fields: Array<[keyof TemplateFormInput, string, number]> = [
    ["titleTemplate", "Title template", MAX_TITLE_TEMPLATE_LENGTH],
    [
      "descriptionTemplate",
      "Description template",
      MAX_DESCRIPTION_TEMPLATE_LENGTH,
    ],
  ];
  const value = { titleTemplate: "", descriptionTemplate: "" };

  for (const [key, label, max] of fields) {
    const v = raw[key];
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${label} must not be empty.`);
      continue;
    }
    if (v.length > max) {
      errors.push(`${label} must be at most ${max} characters.`);
      continue;
    }
    value[key] = v;
    const unknown = unknownPlaceholders(v);
    if (unknown.length > 0) {
      warnings.push(
        `${label} contains ${unknown.join(", ")} — only ${REPO_PLACEHOLDER} is substituted; everything else stays literal.`,
      );
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value, warnings };
}
