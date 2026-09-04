# Plan: Slack thread context for spawned runs + `slack-say`

**Session:** `slack-thread-context`
**Repo:** `app-vitals/shipwright`
**Spec:** `planning/slack-thread-context/PRODUCT-SPEC.md`

## Problem

A `claude -p` run started from Slack can only reach Slack through its final response.
The spawned process is never told which channel or thread it serves, so a skill that
wants to post a progress line mid-run (a 30-minute media pipeline, a long deploy) has
no address to post to, and a cron tick that continues that work can only post
top-level to the cron's channel. Long-running skills therefore go quiet until they
finish — or until the 25-min idle / 60-min hard timeout kills them.

## Codebase findings

**Status: STC-1.1, STC-1.2, STC-1.3, and STC-2.1 have already shipped on `main`** —
re-verified against `repos/shipwright` main (HEAD `9e291d14`), which is newer than either
of these findings' original snapshot:

- `agent/src/claude.ts` — `createRunClaude()`'s returned function already has the 5th
  `extraEnv?: Record<string, string>` param; `_runClaude` forwards it to `_spawn` on
  both the first attempt and the retry; `_spawn` spreads it over `spawnEnv`
  (`{ ...spawnEnv, ...extraEnv }`) after the `SENTRY_DSN` strip. Shipped via PR #3143
  ("feat: add per-run extraEnv to the claude runner").
- `agent/src/slack.ts` — all three handlers (`app.message`, `app_mention`,
  `reaction_added`) already pass `{ SLACK_CHANNEL_ID, SLACK_THREAD_TS }` to the runner,
  using the same `replyTs` value as the session key. Shipped via PR #3143 (tagged
  `STC-1.2`).
- `agent/src/cron-handler.ts` — already resolves `SLACK_CHANNEL_ID` before the run
  (comments tagged `STC-1.3`): `channel` crons pass the cron's channel directly; `user`
  crons resolve the DM channel via `conversations.open` *before* the run and reuse it
  for post-run delivery; resolution failures log and run without the var. Shipped via
  PR #3143 (tagged `STC-1.3`).
- `plugins/shipwright/scripts/slack-say.ts` already exists alongside
  `slack-say.unit.test.ts`, and `docs/configuration.md` already documents both
  `SLACK_CHANNEL_ID` and `SLACK_THREAD_TS` (injection behavior, cron vs. Slack-triggered
  differences, and `slack-say.ts` consumption). `plugins/shipwright/skills/slack-say/SKILL.md`
  also already exists, and `plugins/shipwright/README.md`'s file tree already lists it.
  All shipped via PR #3146 ("feat: add slack-say plugin script with unit tests and
  config docs"). `slack.unit.test.ts` and `cron-handler.unit.test.ts` already carry
  `STC-1.2`/`STC-1.3`-tagged test blocks; `cron-handler.smoke.test.ts` references the
  STC-1.3 pre-run resolution too.

**What's still genuinely outstanding**, confirmed against the same HEAD:

- `plugins/shipwright/TESTING.md` has zero mentions of `slack-say` — no manual test
  scenario exists for it (the README file-tree line is not a test scenario).
- `agent/workspace/CLAUDE.md.template` has no "Run context" subsection and no mention
  of `slack-say`, `SLACK_CHANNEL_ID`, or `SLACK_THREAD_TS` anywhere. Its "Waiting and
  Polling" section (lines 142–184) still contains the stale paragraph claiming a failed
  resume "silently clears the session" and restarts context-free — verified against
  `_runClaude` in `claude.ts` (~line 661 on), which retries the same resumed session
  once and, on double failure, rethrows the *original* error while leaving the session
  mapping intact. The paragraph is still wrong and still needs the rewrite, plus the
  submit-and-stop / `preCheck`-cron pattern this plan originally called for.

Versioning is owned by semantic-release (`.claude/skills/marketplace-dev/SKILL.md`): a
`feat:` commit bumps the minor on merge — no manual `plugin.json`/`marketplace.json`
edits, ever (that skill explicitly forbids it; `marketplace.json` doesn't exist yet).

Complexity flags: none material. Remaining changes are additive, docs-only edits.

## Design

**Docs (the only work remaining — STC-1.1–1.3 and STC-2.1's runtime/CLI work above is
already live on `main`)**

1. `plugins/shipwright/TESTING.md` — add a manual test scenario for `slack-say`:
   invoking it with no env/flags (stdout fallback), with `--channel`/`--thread` flags,
   and with only `SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` env set, confirming the resulting
   `chat.postMessage` body shape. Mirrors the existing scenario style already in the
   file.
2. `agent/workspace/CLAUDE.md.template`:
   - Add a "Run context" subsection next to the response-marker table documenting
     `SLACK_CHANNEL_ID` / `SLACK_THREAD_TS` and pointing at `slack-say`.
   - Rewrite the stale resume paragraph in "Waiting and Polling" (lines 142–184) to
     match `_runClaude`'s actual behavior (retries the same session once; on double
     failure rethrows the *original* error and leaves the session mapping intact —
     never silently restarts context-free).
   - Add the submit-and-stop pattern (persist a job id in a state file, end the turn,
     let a `preCheck` cron poll and continue) as the recommendation for waits beyond
     the Bash ceiling.

**Testing**

- docs: `task check-config-docs` and `task check-strings` stay green (already true on
  `main` post-#3146; re-verify after the template edit).
- No unit/smoke coverage needed — both remaining tasks are markdown-only edits.

## Tasks

STC-1.1, STC-1.2, STC-1.3 (PR #3143) and STC-2.1, plus the `slack-say` SKILL.md and
README entry (both PR #3146), have already shipped on `main` — not re-listed below.

| ID | Title | Branch | Deps | Layer | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|
| STC-2.2 | Add a `slack-say` manual test scenario to plugin TESTING.md | `feat/stc-2-2-testing-docs` | — | Docs | 1 | haiku | |
| STC-3.1 | Document run-context env vars and fix the resume/polling guidance in the agent template | `feat/stc-3-1-agent-template-docs` | — | Docs | 1 | haiku | |

Dependency map:

```
[START]
  ├─ STC-2.2: slack-say TESTING.md entry (no deps)
  └─ STC-3.1: agent template docs        (no deps)
```

HITL scan: no tasks require human steps.
Breaking-change scan: none; both remaining tasks are docs-only.

## Verification (post-merge)

1. `task ci` green on `main` (already true — the STC-1.x/STC-2.1 runtime and CLI work
   is live).
2. `plugins/shipwright/TESTING.md` has a `slack-say` scenario covering the stdout
   fallback, flag override, and env-only paths.
3. `agent/workspace/CLAUDE.md.template` has a "Run context" subsection documenting
   `SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` and `slack-say`, and "Waiting and Polling" no
   longer claims a failed resume silently restarts context-free.
4. `task check-config-docs` and `task check-strings` stay green after the template
   edit.
