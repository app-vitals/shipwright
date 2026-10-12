export { isOrgRepo } from "@shipwright/lib/org-repo";

const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/;
const PR_ACCEPTED_FORMS =
  "a positive integer, an integer string, or a github.com pull-request URL (https://github.com/<owner>/<repo>/pull/<n>)";

/**
 * Normalize a client-supplied `pr` to a positive integer (or null/undefined,
 * passed through). Task.pr is Int? — a string reaching Prisma throws a
 * PrismaClientValidationError (a raw 500). Returns the normalized value, or
 * an error message naming the field and accepted forms.
 */
export function normalizePr(
  value: unknown,
):
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value };
  let n: number | undefined;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const s = value.trim();
    const m = PR_URL_RE.exec(s);
    if (m) n = Number(m[1]);
    else if (/^\d+$/.test(s)) n = Number(s);
  }
  if (n === undefined || !Number.isSafeInteger(n) || n <= 0) {
    return {
      ok: false,
      error: `pr must be ${PR_ACCEPTED_FORMS}`,
    };
  }
  return { ok: true, value: n };
}
