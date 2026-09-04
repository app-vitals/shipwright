# Plan: patch-owner-scope-gap

**Repo:** app-vitals/shipwright
**Session:** patch-owner-scope-gap

## Problem

`/shipwright:patch` Step 2 (`plugins/shipwright/commands/patch.md`) hardcodes its scope
gate as `author.login != CURRENT_USER` → reject. `agent/src/check-patch.ts`'s
`getPatchCandidates` (DBR-1.4, #3132) already broadened its own qualification logic to
additively merge self-authored PRs with PRs from a configured `patchAuthorAllowlist`
(synced from the agent config bundle via `patchAuthorAllowlistRef`). This agent's live
config already has `patchAuthorAllowlist: ["app/renovate"]` set (confirmed via
`GET /agents/{id}/config`) — populated the same day `isGithubLogin()` was extended to
accept the `app/<slug>` bot-login format (`plan/bot-login-allowlist`, BLA-1.1, PR #3156).

Because `patch.md` never learned about the allowlist, PR app-vitals/shipwright#2920 (a
`app/renovate`-authored PR) bounced repeatedly between the review and patch phases on
2026-09-04: `check-review.ts` has no author restriction and re-flags the PR on every
Renovate rebase, `readyForPatchAt` gets set, the loop dispatches `/shipwright:patch`, and
Step 2 immediately rejects it as `command:no-work` — burning a cron tick (~$0.48, mostly
cached-context replay) each cycle with no progress. `check-patch.ts` would have accepted
this exact PR; `patch.md` alone didn't know how.

This is the specific case the plugin's own design constitution
(`plugins/shipwright/CLAUDE.md`, Candidate Selection Contract) calls out in advance:
*"When a provider's qualification logic changes, the corresponding command's
Arguments/Step 0-2 assumptions should be reviewed."* That review didn't happen when
DBR-1.4 shipped.

## Design

Two code fixes to `plugins/shipwright/commands/patch.md`, plus one doc line:

1. **Step 2's scope gate** — fetch `patchAuthorAllowlist` from
   `GET /agents/$SHIPWRIGHT_AGENT_ID/config` (the exact same endpoint `review.md` already
   calls for `.repos[0]`, see `review.md` Step 14) and accept the PR when
   `author.login == CURRENT_USER` **OR** `author.login` is in that list. Fail closed to
   today's CURRENT_USER-only behavior if the fetch fails or the list is empty/absent —
   mirrors `check-patch.ts`'s explicit non-fail-open design for this particular allowlist
   (an unsynced/empty patch allowlist means self-authored-only, never "allow everyone").

2. **Line ~745's author-reply detection** — currently assumes the PR author is always
   `CURRENT_USER` when deciding whether a review finding was addressed by an author reply.
   For an allowlisted non-self PR this can never match a real reply from the actual author.
   `check-patch.ts` hit and fixed the identical shape of bug (RAS-1.1/DBR-1.4, threading a
   real `prAuthor` instead of assuming `currentUser`). Mirror it: capture `PR_AUTHOR` from
   Step 2's `gh pr view` result and thread it into this check in place of `CURRENT_USER`.

3. **`plugins/shipwright/CLAUDE.md`, Independence Principle #3** — currently states patch
   is scoped to "the authenticated user's own open PRs (matching by PR author)." Update to
   "own PRs, or PRs authored by an entry in the agent's configured `patchAuthorAllowlist`"
   so the constitution doesn't go stale the next time the allowlist changes.

**Explicitly out of scope:**
- No change to `check-patch.ts`/candidate selection — it's already correct; this is purely
  porting its already-shipped decision into the command that executes on it.
- No change to Step 2.1's model-tier lookup — it already handles zero matched
  task-store tasks gracefully (defaults to `sonnet`, no escalation), which is exactly what
  a Renovate PR with no linked task produces.
- No fix to PR app-vitals/shipwright#2920 itself — once `patch.md` accepts allowlisted
  authors, the review↔patch oscillation resolves on its own; the PR's underlying CI
  failures (unrelated Renovate bumps) are a separate concern.

### Test reasoning

`patch.md` is prompt content, not executable code — its test layer is `*.content.test.ts`
(`patch.content.test.ts` already exists and covers Step 2's current CURRENT_USER-only
wording). New assertions are added to that file for the allowlist-fetch branch and the
`PR_AUTHOR` threading; nothing is retired, since this is net-new coverage for a
previously-unwritten branch of Step 2 — the existing CURRENT_USER-only assertions still
hold as the fallback path.

## Tasks

| Task     | Depends on | Blocks | HITL |
|----------|------------|--------|------|
| PAS-1.1  | —          | —      |      |
| PAS-1.2  | — (bundle-mate of PAS-1.1) | — | |

Both tasks share branch `feat/pas-1-patch-author-allowlist` (bundled — same root cause,
same file family, avoids ceremony of a second tiny PR for a one-line doc update).

### PAS-1.1 — Port patch-author allowlist into `/shipwright:patch`'s scope check and author-reply detection

**Description:** Fix `patch.md` Step 2's authorization gate to accept PRs authored by
either `CURRENT_USER` or an entry in the agent's configured `patchAuthorAllowlist`
(fetched from `GET /agents/{id}/config`, mirroring `review.md`'s existing config-fetch
pattern), instead of hardcoding CURRENT_USER-only. Also thread a real `PR_AUTHOR` variable
(captured in Step 2) into the ~line 745 author-reply-detection logic in place of the
hardcoded `CURRENT_USER`.

**Acceptance Criteria:**
- Step 2's scope check accepts `author.login == CURRENT_USER OR author.login ∈
  patchAuthorAllowlist`; a failed fetch or an empty/absent allowlist falls back to today's
  CURRENT_USER-only behavior (fail closed).
- `PR_AUTHOR` is captured from Step 2's `gh pr view` result and threaded into the
  author-reply-detection logic (~line 745) in place of the hardcoded `CURRENT_USER`, so a
  genuine reply from an allowlisted PR's real author is recognized as addressing a finding.
- Test decision: content-layer only (`patch.content.test.ts`). Add assertions that Step
  2's body references the `patchAuthorAllowlist` fetch/`/agents/{id}/config` call and that
  the author-reply section threads `PR_AUTHOR` rather than a bare `CURRENT_USER`-only
  comparison. No existing test is retired — this is net-new coverage for a previously
  CURRENT_USER-only branch.
- Manual verification note (not an automated test): re-running `/shipwright:patch
  app-vitals/shipwright#2920` (or whatever `app/renovate`-authored PR is open at
  execution time) should proceed past Step 2 instead of printing "not found among own
  open PRs."

**Layer:** CLI
**Hours:** 3
**Complexity:** 3
**Model:** sonnet
**HITL:** no
**Safe to deploy standalone:** yes — purely additive broadening of an authorization check;
the existing self-authored-only behavior is preserved as the fallback path.
**Branch:** `feat/pas-1-patch-author-allowlist`

### PAS-1.2 — Update Independence Principle #3 for patch's broadened scope

**Description:** Update `plugins/shipwright/CLAUDE.md`'s Independence Principles, item 3,
so the `patch`/`deploy` scope sentence reflects that patch's scope is "own PRs, or PRs
authored by an entry in the agent's configured `patchAuthorAllowlist`" (config-driven,
additive) rather than "own PRs" alone — matching PAS-1.1's shipped behavior.

**Acceptance Criteria:**
- Independence Principle #3's `patch` scope line names the `patchAuthorAllowlist`
  allowlist as an additional acceptance path alongside `CURRENT_USER` authorship.
- Test decision: no test change — this is a prose-only doc edit with no executable
  behavior; nothing to assert beyond PAS-1.1's own content-test additions.

**Layer:** Shared
**Hours:** 0.5
**Complexity:** 1
**Model:** sonnet (bundle inheritance from PAS-1.1)
**HITL:** no
**Safe to deploy standalone:** yes — doc-only.
**Branch:** `feat/pas-1-patch-author-allowlist` (bundled with PAS-1.1)

## HITL scan

No tasks require human steps (no infra/secret/console keywords or judgment triggers —
the allowlist itself is pre-existing config, not something this work provisions).
