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

// ─── Repo scope (CRS-1.3) ─────────────────────────────────────────────────────

/** Mirrors the task-store's cap on a 'selected' repos list. */
export const MAX_SCOPE_REPOS = 500;

export type RepoScope = "all" | "selected";

export interface ScopeFormInput {
  repoScope: RepoScope;
  repos: string[];
}

export type ScopeFormResult =
  | {
      ok: true;
      /** `undefined` when the form carried no scope: leave the definition as-is. */
      value: ScopeFormInput | undefined;
    }
  | { ok: false; errors: string[] };

const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Validate the scope control: 'all' (clears repos) or 'selected' with at least
 * one org/repo. The task-store enforces the same rules (400) as a backstop.
 */
export function validateScopeForm(raw: {
  repoScope?: unknown;
  repos?: unknown;
}): ScopeFormResult {
  if (raw.repoScope === undefined) return { ok: true, value: undefined };
  if (raw.repoScope === "all") {
    return { ok: true, value: { repoScope: "all", repos: [] } };
  }
  if (raw.repoScope !== "selected") {
    return { ok: false, errors: ["Repository scope must be all or selected."] };
  }
  const submitted = Array.isArray(raw.repos) ? raw.repos : [];
  const repos = [
    ...new Set(
      submitted
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.trim())
        .filter((r) => r !== ""),
    ),
  ];
  if (repos.length === 0) {
    return {
      ok: false,
      errors: ["Select at least one repository, or choose All repositories."],
    };
  }
  const malformed = repos.filter((r) => !REPO_SLUG.test(r));
  if (malformed.length > 0) {
    return {
      ok: false,
      errors: [`Not an org/repo name: ${malformed.join(", ")}.`],
    };
  }
  if (repos.length > MAX_SCOPE_REPOS) {
    return {
      ok: false,
      errors: [`Select at most ${MAX_SCOPE_REPOS} repositories.`],
    };
  }
  return { ok: true, value: { repoScope: "selected", repos } };
}
