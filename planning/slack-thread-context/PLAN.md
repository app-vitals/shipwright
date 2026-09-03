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

- `agent/src/claude.ts` — `createRunClaude()` returns
  `runClaude(message, sessionKey?, onProgress?, signal?)`. `_runClaude` builds args,
  calls `_spawn(args, onProgress, signal)` (and once more on the retry path).
  `_spawn` builds the child env as `const { SENTRY_DSN, ...spawnEnv } = process.env`
  and passes `{ cwd: workspace, env: spawnEnv, stdout: "pipe", stderr: "pipe" }` to the
  injected `spawner`. No per-run env exists today.
- `agent/src/slack.ts` — three handlers (`app.message`, `app_mention`,
  `reaction_added`) all know `channel` and the reply thread (`thread_ts ?? ts`) — the
  same pair used for `sessionKey = getThreadKey(channel, replyTs)` — and call
  `runner(prompt, sessionKey, progress.onProgress)`. `ClaudeRunner` is declared at
  `slack.ts:148` as `(message, sessionKey?, onProgress?)`.
- `agent/src/cron-handler.ts` — `ClaudeRunner` is `(message, onProgress?)`;
  `index.ts:209/547` adapt it as `(message, onProgress) => runner(message, undefined, onProgress)`.
  For `channel` crons the channel is known before the run. For `user` crons the DM
  channel is opened *after* the run (`conversations.open` at `cron-handler.ts:528`),
  inside the delivery block that tags Slack failures.
- `agent/workspace/CLAUDE.md.template` — response-marker table (lines 24–45) is where
  per-run Slack facts are documented; "Waiting and Polling" (142–183) contains the
  stale "resume failure silently clears the session" paragraph; `_runClaude`
  (`claude.ts:655–710`) actually retries the same session once and rethrows leaving the
  mapping intact.
- `plugins/shipwright/scripts/` — self-contained scripts with sibling
  `*.unit.test.ts`, `clock.ts` for injectable time, deps injected via a `deps` object
  (`check-error-patrol.ts`). `task check-config-docs` requires every `process.env.*`
  read under `agent/src/` and `plugins/shipwright/scripts/` to be documented in
  `docs/configuration.md`.
- Versioning is owned by semantic-release (`.claude/skills/marketplace-dev/SKILL.md`):
  a `feat:` commit bumps the minor on merge — **no manual `plugin.json` edits**.
- Existing test precedent: `claude.unit.test.ts:318` asserts the spawned `opts.env`
  via the injected `mockSpawn`; `slack.unit.test.ts` mocks `runner` and asserts its
  call args; `cron-handler.unit.test.ts` uses `mockRunner`.

Complexity flags: none material. All changes are additive (optional params, new env
vars, new script). No renames or removals → every task is safe to deploy standalone.

## Design

**Business logic / Background**

1. `createRunClaude()`'s returned function gains an optional fifth parameter
   `extraEnv?: Record<string, string>`. `_runClaude` forwards it to `_spawn` on both
   the first attempt and the retry; `_spawn` spreads it over `spawnEnv`
   (`{ ...spawnEnv, ...extraEnv }`) *after* the `SENTRY_DSN` strip so the strip is
   unchanged. `ClaudeRunner` in `slack.ts` and `cron-handler.ts` gain the same optional
   param; `index.ts` adapters forward it.
2. `slack.ts` handlers pass
   `{ SLACK_CHANNEL_ID: channel, SLACK_THREAD_TS: replyTs }` where `replyTs` is the
   same value used for the session key (`thread_ts ?? ts`; for `reaction_added`,
   `item.ts`).
3. `cron-handler.ts` passes `{ SLACK_CHANNEL_ID: channel }` for `channel` crons.
   For `user` crons it resolves the DM channel with `conversations.open` **before**
   the run (best-effort: on failure log and run without it) and reuses that id for the
   post-run delivery, leaving the existing failure-tagging block intact. `silent`
   crons with neither field pass nothing. `SLACK_THREAD_TS` is never set on cron runs.

**CLI (plugin script)**

4. `plugins/shipwright/scripts/slack-say.ts` — `bun run …/slack-say.ts [--channel C]
   [--thread T] "text"`. Pure `postSlackSay(deps, argv)` function with injected
   `fetch`, `env`, `stdout`, `stderr`; `main()` wires real ones. Resolution: flags →
   env (`SLACK_CHANNEL_ID`, `SLACK_THREAD_TS`, `SLACK_BOT_TOKEN`). No token or no
   channel → print text to stdout, exit 0. Slack non-2xx or `ok:false` → stderr line
   with the Slack `error` string, exit 0. Body: `channel`, `text`, `mrkdwn: true`,
   `unfurl_links: false`, `thread_ts` only when resolved.
5. `plugins/shipwright/skills/slack-say/SKILL.md` — when to use (stage boundaries of
   long work; one line; never chatter), invocation, env resolution, terminal fallback.

**Docs**

6. `docs/configuration.md` Plugin Config table: `SLACK_CHANNEL_ID`, `SLACK_THREAD_TS`
   (injected by the agent per run; read by `slack-say`). `SLACK_BOT_TOKEN` is already
   documented under Agent Config → Slack; the slack-say row cross-references it.
7. `agent/workspace/CLAUDE.md.template`: a "Run context" subsection next to the
   marker table documenting the two env vars and pointing at `slack-say`; rewrite the
   stale resume paragraph in "Waiting and Polling" to match `_runClaude`, and add the
   submit-and-stop pattern (persist job id in a state file, end the turn, let a
   `preCheck` cron poll and continue) as the recommendation for waits beyond the Bash
   ceiling.

**Testing (adopted from the spec's strategy — layer assignments confirmed against the
codebase)**

- unit: `claude.unit.test.ts` (extraEnv present on first and retry spawn; absent →
  env unchanged; `SENTRY_DSN` still stripped), `slack.unit.test.ts` (runner called
  with the env pair for each of the three handlers; thread value equals the session
  key's ts), `cron-handler.unit.test.ts` (channel cron → `SLACK_CHANNEL_ID`, no
  `SLACK_THREAD_TS`; user cron → DM channel from `conversations.open`; open failure →
  no env, run still happens), `slack-say.unit.test.ts` (flag > env precedence,
  `thread_ts` only when present, stdout fallback, `ok:false` → exit 0 + stderr).
- smoke: none — no HTTP route surface.
- docs: `task check-config-docs` and `task check-strings` green.

## Tasks

| ID | Title | Branch | Deps | Layer | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|
| STC-1.1 | Add per-run `extraEnv` to the claude runner | `feat/stc-thread-env` | — | Background | 3 | sonnet | |
| STC-1.2 | Pass Slack channel and thread env from Slack handlers | `feat/stc-thread-env` | STC-1.1 | Background | 2→sonnet (bundle) | sonnet | |
| STC-1.3 | Pass Slack channel env from cron dispatch | `feat/stc-thread-env` | STC-1.1 | Background | 3 | sonnet | |
| STC-2.1 | Add `slack-say` plugin script with unit tests and config docs | `feat/stc-slack-say` | — | CLI | 3 | sonnet | |
| STC-2.2 | Add `slack-say` skill doc and plugin README/TESTING entries | `feat/stc-slack-say` | STC-2.1 | CLI | 1→sonnet (bundle) | sonnet | |
| STC-3.1 | Document run-context env vars and fix the resume/polling guidance in the agent template | `feat/stc-3-1-agent-template-docs` | STC-1.3, STC-2.1 | Shared | 1 | haiku | |

Dependency map:

```
[START]
  ├─ STC-1.1: runner extraEnv (no deps)
  │     ├─ STC-1.2: slack handlers pass env      (bundle: feat/stc-thread-env)
  │     └─ STC-1.3: cron passes channel env      (bundle: feat/stc-thread-env)
  └─ STC-2.1: slack-say script (no deps)
        └─ STC-2.2: slack-say skill + README     (bundle: feat/stc-slack-say)
                     └─ STC-3.1: template docs (needs 1.3, 2.1)
```

HITL scan: no tasks require human steps.
Breaking-change scan: none; every task is safe to deploy standalone.

## Verification (post-merge)

1. `task ci` green on `main`.
2. Dev agent DM: a prompt that runs `slack-say "hello from mid-run"` then sleeps 20 s —
   the line appears before the final reply.
3. Channel thread: the line lands inside the thread.
4. `channel` cron calling `slack-say` with no flags posts to that channel;
   `env | grep SLACK_` in the prompt shows no `SLACK_THREAD_TS`.
5. `bun run plugins/shipwright/scripts/slack-say.ts "x"` with no env prints `x`, exit 0.
