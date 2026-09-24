# Agent Trial Expiry — Product Specification

**Date**: 2026-09-24
**Session**: agent-trial-expiry
**Status**: Draft
**Repo**: `app-vitals/shipwright`

## Overview

An optional expiry date on an agent that automatically tears it down once passed, with a warning alert beforehand. This closes the third of four gaps toward offering free-trial hosted agents (course students getting Shipwright Managed free for 2-3 months) — but like the prior two PRDs in this set, it stands alone as a general capability: any time-boxed agent (a trial, a bake-off, a temp environment) currently has no automatic cleanup and relies on someone remembering to delete it by hand.

## Problem Statement

`deleteAgentFully()` (`admin/src/agent-deletion.ts`) already exists as a well-designed, idempotent, retryable full-teardown function — but nothing calls it automatically. An agent lives forever unless a human deletes it via `DELETE /agents/:id` or the admin UI's danger zone. There is no concept of a time-boxed agent anywhere in the schema.

## Users & Context

- **An operator setting up a time-boxed agent** (a trial, a temp environment): sets an expiry date once at creation or via a later PATCH, and doesn't have to remember to clean it up.
- **The agent itself**, in the days before expiry: gets a Slack warning so whoever's using it isn't surprised.

---

## Features

### Feature 1: `trialExpiresAt` field + admin API support

**Priority**: High
**Description**: A new optional `DateTime` field on `Agent` marking when it should be automatically torn down.

**Requirements**:
- `Agent.trialExpiresAt DateTime?`, nullable, default `null` (unset = never expires, current behavior for every existing agent).
- Editable via the existing `PATCH /agents/:id` route and returned by `GET /agents/:id`, following the same pattern as Feature 2 of the spend-caps PRD (`app-vitals/shipwright#3644`) — this field is independent of that one but follows the identical additive-nullable-scalar-field pattern.

**Acceptance Criteria**:
- [ ] `PATCH /agents/:id` with `{ "trialExpiresAt": "2026-12-01T00:00:00Z" }` persists and is returned by `GET /agents/:id`
- [ ] An agent with `trialExpiresAt` unset behaves identically to today — no expiry processing applies to it
- [ ] The Prisma migration is additive only
- [ ] Test decision: extend the existing smoke suite covering `PATCH`/`GET /agents/:id` with cases for setting, reading, and clearing this field

**Source Map**:
- `admin/prisma/schema.prisma` — `Agent` model scalar fields
- Existing agent PATCH/GET handler (same one Feature 2 of the spend-caps PRD touches — dev-task should check whether that PR has already merged and, if so, add this field in the same handler rather than re-locating it independently)

**Testing Strategy**: Layer: smoke — HTTP route contract, matching the existing PATCH/GET test pattern.

---

### Feature 2: Expiry warning alert

**Priority**: Medium
**Description**: A Slack warning to the agent's own alerts channel some number of days before `trialExpiresAt`, so deletion isn't a surprise.

**Requirements**:
- A scheduled check (piggybacking on an existing periodic job if one runs at suitable frequency, or a new lightweight cron — dev-task's Step 2 exploration should identify the best fit) that finds agents where `trialExpiresAt` is within a configurable warning window (default 3 days) and have not yet been warned.
- Sends one alert via the existing per-agent Slack alert pattern (`agent/src/cron-handler.ts:298-309`), naming the expiry date and that the agent will be automatically deprovisioned.
- The warning fires exactly once per agent, not once per check-run — needs a way to record "already warned" (e.g. a `trialExpiryWarnedAt` timestamp field, mirroring `trialExpiresAt`'s nullable-additive pattern).

**Acceptance Criteria**:
- [ ] An agent with `trialExpiresAt` 2 days away and a 3-day warning window receives exactly one Slack alert
- [ ] Re-running the check after the alert has fired does not send a second alert for the same agent
- [ ] An agent with `trialExpiresAt` unset is never considered by this check
- [ ] Test decision: unit test the warning-window comparison and dedup logic in isolation; integration test the check against fixture agents with an injected Slack client double

**Source Map**:
- `agent/src/cron-handler.ts:298-309` — Slack alert pattern to reuse
- `admin/prisma/schema.prisma` — new `trialExpiryWarnedAt` field alongside `trialExpiresAt`

**Testing Strategy**: Layer: integration — fixture agents against real Postgres, injected Slack double per this repo's isolation rule.

---

### Feature 3: Trial-expiry lockdown (superseded — see 2026-09-24 correction below)

> **This feature's original design (call `deleteAgentFully()`) is superseded.** Dan: no auto-deprovisioning — a trial ending should lock the agent down, not destroy it. See the correction note at the end of this document for the actual design (disable crons + block Slack messages). The task-store record for `ATE-3.1` reflects the corrected design; this section is left as historical context for why the original approach was considered and rejected.

**Priority**: High
**Description**: ~~Once `trialExpiresAt` passes, automatically call `deleteAgentFully()` for that agent.~~ Superseded — see correction note.

**Requirements**:
- A scheduled check (can share the same job as Feature 2, checking a later threshold) that finds agents where `trialExpiresAt` has passed and calls `deleteAgentFully(agentId)` for each, with no `xoxpToken` supplied (an automated job has no human Slack session to pull one from).
- Because `deleteAgentFully()` already skips Slack-app deletion when no token is supplied and produces a manual-steps checklist (`agent-deletion.ts`'s existing `buildManualStepsChecklist`) instead of failing, expired-agent teardown will always leave the agent's Slack app orphaned pending manual cleanup — **this is an accepted limitation, not solved here.** Post that checklist (and confirmation that K8s/token/thread cleanup succeeded) to an admin-level ops channel, not the just-deleted agent's own channel (which may no longer be reachable once teardown runs) — a new `SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_ALERT_CHANNEL` env var, following this repo's existing `SHIPWRIGHT_<SUBSERVICE>_<THING>` namespacing convention.
- `deleteAgentFully()` is already idempotent/retryable — if the check runs again before a prior partial failure is resolved (e.g. K8s deprovision succeeded but token revoke failed), re-invoking it is safe per its own documented behavior. No new retry logic needed here.

**Acceptance Criteria**:
- [ ] An agent with `trialExpiresAt` in the past is fully torn down (K8s workload, tokens, chat threads) on the next check run, with the Agent row deleted per `deleteAgentFully()`'s existing success path
- [ ] The resulting manual-steps checklist (Slack app cleanup) is posted to the configured admin ops channel, not silently dropped
- [ ] An agent with `trialExpiresAt` unset or in the future is never torn down by this check
- [ ] A simulated partial failure inside `deleteAgentFully()` (e.g. K8s deprovision succeeds, token revoke fails) leaves the Agent row in place per its existing retry-anchor design, and a subsequent check run retries it — verified by a test, not assumed
- [ ] Test decision: integration test against fixture agents with an injected `deleteAgentFully()` dependency set (K8s/token/chat doubles), covering full success, partial failure, and the not-yet-expired no-op case

**Technical Considerations**: This calls an existing, already-tested teardown function — the new work here is entirely "find expired agents and call it," not reimplementing teardown. The real risk is triggering it on the wrong agent (an off-by-one in the time comparison deleting a live, non-expired agent) — acceptance criteria above require an explicit not-yet-expired no-op test to guard against this.

**Source Map**:
- `admin/src/agent-deletion.ts` — `deleteAgentFully()`, called as-is
- `admin/src/agent-deletion-checklist.ts` — `buildManualStepsChecklist`, reused for the ops-channel post

**Testing Strategy**: Layer: integration — fixture agents, injected teardown-dependency doubles, matching this repo's no-`mock.module()` isolation rule.

---

## Technical Constraints

- Additive only — `trialExpiresAt`/`trialExpiryWarnedAt` nullable, default `null`; every existing agent is unaffected.
- Must not reimplement or duplicate `deleteAgentFully()`'s teardown logic — call it, don't fork it.
- Slack-app orphan cleanup after automated expiry is explicitly out of scope for full automation — surfaced as a manual-steps checklist to an ops channel, per `deleteAgentFully()`'s existing designed behavior for a missing `xoxpToken`.

## Scope

**In Scope**:
- `trialExpiresAt` + `trialExpiryWarnedAt` fields, admin API support
- Pre-expiry Slack warning (Feature 2)
- Automatic teardown via existing `deleteAgentFully()` (Feature 3)

**Out of Scope**:
- Automated Slack-app deletion for expired agents (needs a human-supplied token by design — not solved here, see Feature 3)
- Trial-to-paid conversion flow (upgrading an about-to-expire agent instead of deleting it) — not decided; would need a real product decision on what "converting" means (new agent? extend the same one? billing hookup?) and is deferred as a follow-up, not guessed at here
- Shared-tier GitHub App/Slack architecture and self-serve triggering — see `app-vitals/shipwright#3645`'s named blocker; this PRD's teardown mechanism works identically regardless of how that question resolves, since it operates on an existing `Agent` row regardless of how it was created

## Priorities & Sequence

Feature 1 must land before Features 2 and 3 (both need the field to query against). Features 2 and 3 can be built in parallel or share one scheduled-check implementation — dev-task's Step 2 exploration should decide whether one job handles both the warning and the teardown threshold, or two separate ones; either is acceptable.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| trialExpiresAt field | smoke | HTTP route contract for existing PATCH/GET pattern |
| Expiry warning alert | integration | fixture agents + injected Slack double |
| Automatic teardown | integration | fixture agents + injected teardown-dependency doubles |

## Resolved Decisions

- **No trial-to-conversion flow in this PRD.** — Rationale: "what does converting a trial to paid actually mean" is a product/billing decision, not an engineering default I can sensibly guess; deleting-or-not-deleting on expiry is the only behavior this spec implements.
- **Slack-app cleanup stays manual on automated expiry.** — Rationale: `deleteAgentFully()` already models this correctly (skip + checklist rather than fail) when no human token is available; inventing a way to store and reuse a Slack admin token for unattended deletion would be a new, separate security surface not asked for here.
- **Ops-channel alert destination is a new admin-level env var, not the expiring agent's own channel.** — Rationale: the agent's own Slack app may already be mid-teardown or unreachable by the time the post-teardown summary is ready to send; a stable admin channel is more reliable.

## Success Criteria

- ~~An agent with `trialExpiresAt` set is automatically torn down~~ — superseded, see correction below.
- A Slack warning fires once, 3 days (default) before expiry.
- Every existing agent with `trialExpiresAt` unset is completely unaffected.
- `task ci` passes with no regression to existing tests.

## 2026-09-24 correction: no auto-deprovisioning

Dan, reviewing PR #3646: "I don't want to auto deprovision. We should just flag as trial being over for now, disable crons and block messages in slack." `ATE-3.1` was still `pending` with no code (confirmed before amending — `ATE-1.1` has PR #3656 open and was left untouched, its own scope is unaffected by this change), so redesigned in place rather than superseding with a new task.

**Corrected design — Feature 3 becomes "Trial-expiry lockdown":**
- **Disable crons.** A scheduled check finds agents where `trialExpiresAt` has passed and at least one `AgentCronJob` is still `enabled`, and `PATCH`es each to `enabled: false` via the existing per-cron route (`admin/src/agents-api.ts:1231` — there is no bulk-update endpoint, iterate each cron). Naturally idempotent: once every cron is disabled, a later run finds nothing to do — no new state-tracking field needed.
- **Block Slack messages.** A new reject-gate in `agent/src/slack.ts`, mirroring the existing `shouldRejectSlackSender()` pattern (checked identically by all three inbound handlers — `app.message`, `app_mention`, `reaction_added`) — checks `trialExpiresAt` before any Claude session is invoked. Unlike `shouldRejectSlackSender()`, which silently drops a rejected message, this gate replies once with a clear "trial has ended" notice — silence would read as the agent being broken, not intentionally paused.
- **No `deleteAgentFully()` call anywhere in this feature.** The agent's K8s workload, tokens, chat threads, and `Agent` row are all left untouched by trial expiry — reversible if the trial is extended or the customer converts, which was the whole point of the correction.
- **No new DB field required** beyond `trialExpiresAt` (already added by `ATE-1.1`) — both the cron-disable check and the Slack gate read it directly.

This also **retires the Slack-app-orphan-cleanup limitation** documented earlier in this spec (§ Feature 3 original design, § Resolved Decisions) — since nothing is deleted, there's no Slack app to orphan in the first place.
