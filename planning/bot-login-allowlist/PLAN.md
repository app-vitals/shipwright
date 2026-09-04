# Plan: bot-login-allowlist

**Repo:** app-vitals/shipwright
**Session:** bot-login-allowlist

## Problem

`patchAuthorAllowlist` and `reviewAuthorAllowlist` (per-agent GitHub login
allowlists, `PATCH /agents/:id`) reject GitHub App bot author logins.
GitHub's actual PR author login for App-installed bots (Renovate,
Dependabot, etc.) is `app/<slug>` (confirmed via `gh pr list --search
"author:app/renovate"` on app-vitals/shipwright — real PRs come back with
`author.login == "app/renovate"`), and `check-patch.ts`'s
`gh pr list --author <login>` filtering already accepts that format. But
`isGithubLogin()` in `lib/github-login.ts` only allows alphanumeric +
single-hyphen strings (no `/`), so `PATCH /agents/:id` 400s with `"each
entry must be a valid GitHub login"` on any bot login. No GitHub App bot
can currently be added to either allowlist.

## Design

`isGithubLogin()` is the single choke point — `CreateAgentBodySchema` +
`PatchAgentBodySchema` (`admin/src/openapi-schemas.ts`) and all 5
form/mutation validation sites in `admin/src/admin-ui.ts` (create-form,
single-add for both review and patch allowlists) delegate to it. Fixing
this one function fixes every entry point at once — no API, DB, or UI
changes needed.

Extend `isGithubLogin` to special-case the `app/<slug>` GitHub-App-bot
format, validating the slug portion with the same character rules as a
normal login:

```ts
const LOGIN_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;

export function isGithubLogin(s: string): boolean {
  if (s.startsWith("app/")) {
    const slug = s.slice(4);
    return slug.length > 0 && slug.length <= 39 && LOGIN_PATTERN.test(slug);
  }
  return s.length > 0 && s.length <= 39 && LOGIN_PATTERN.test(s);
}
```

- `"app/renovate"` → valid
- `"octo/cat"` → still invalid (doesn't start with `app/`) — existing test
  (`isGithubLogin — invalid strings > returns false for a login containing
  a slash`) is unaffected
- `"app/"`, `"app/-bad"`, `"app//x"` → invalid (empty/malformed slug)

Purely additive — loosens validation, nothing previously valid becomes
invalid. No breaking-change concerns, no migration, no consumers to
update.

## Tasks

| Task     | Depends on | Blocks | HITL |
|----------|------------|--------|------|
| BLA-1.1  | —          | —      |      |

### BLA-1.1 — Accept `app/<slug>` bot logins in author-allowlist validation

**Description:** Extend `isGithubLogin()` in `lib/github-login.ts` to
accept the GitHub-App-bot author login format (`app/<slug>`), so
`patchAuthorAllowlist`/`reviewAuthorAllowlist` can include bot authors like
Renovate/Dependabot. Single choke point — no other files need changes.

**Acceptance Criteria:**
- `isGithubLogin("app/renovate")` and `isGithubLogin("app/dependabot")`
  return `true`.
- `isGithubLogin("app/")`, `isGithubLogin("app/-bad")`, and
  `isGithubLogin("app//x")` return `false`.
- Existing behavior for human logins (including the slash-rejection case,
  `"octo/cat"` → `false`) is unchanged — all current cases in
  `lib/github-login.unit.test.ts` still pass.
- Test decision: unit-only (isolated pure function, no I/O). Add new cases
  to `lib/github-login.unit.test.ts` for the `app/<slug>` valid and
  invalid forms above. No existing tests are retired — all current cases
  remain valid and unchanged.

**Layer:** Shared
**Hours:** 1
**Complexity:** 1
**Model:** haiku
**HITL:** no
**Safe to deploy standalone:** yes
**Branch:** `feat/bla-1-1-allow-bot-author`
