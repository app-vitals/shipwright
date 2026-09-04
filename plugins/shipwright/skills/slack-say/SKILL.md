---
name: slack-say
description: >
  Post a one-line progress update into the Slack thread or channel a run started
  from. Use exactly at stage boundaries of long-running work — e.g. finishing
  discovery, starting implementation, opening a PR, entering a fix loop — so a
  human watching Slack can see the run is alive and where it is. Do NOT use for
  chatter, for every small step, or as a substitute for the agent's final
  response — it is a best-effort ping, not the answer. Triggers on: multi-step
  commands/skills that run long enough a human might wonder if they stalled
  (dev-task, patch, review, plan-session, deploy), or when the user mentions
  "post progress to Slack", "slack-say", or "progress ping". Invokes
  `scripts/slack-say.ts` via `bun run` — never throws, never fails the caller.
---

# slack-say — Skill

Post a single-line progress message into the Slack thread (or channel) a run started
from. It exists so a human watching a long-running command can see it is still moving
without waiting for the final response.

---

## When to use this

- **One line at each stage boundary** of long-running work — e.g. "starting
  implementation", "opening PR #123", "CI failed, retrying fix (2/6)". A stage boundary is
  a transition between the major phases of a command/skill (discovery → build → review →
  ship), not every individual tool call.
- **Never for chatter.** Do not narrate routine tool calls, intermediate reasoning, or
  anything that isn't a meaningful phase transition.
- **Never as a replacement for the final response.** The calling command/skill still owes
  the user its normal end-of-run summary — `slack-say` only pings interim progress.

---

## Invocation

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/slack-say.ts" [--channel C] [--thread T] "text"
```

- `text` — every non-flag argument is joined with a space, so an unquoted multi-word
  message still works.
- `--channel` — overrides the resolved channel (see resolution order below).
- `--thread` — overrides the resolved thread timestamp.
- There is no `--token` flag, on purpose — the Slack bot token is env-only.

---

## Resolution order

| Value | Source (highest priority first) |
|---|---|
| Channel | `--channel` flag → `SLACK_CHANNEL_ID` env var |
| Thread | `--thread` flag → `SLACK_THREAD_TS` env var |
| Token | `SLACK_BOT_TOKEN` env var only (no flag) |

`SLACK_CHANNEL_ID` and `SLACK_THREAD_TS` are injected per run by the agent runtime, not
user-configured:

- **Slack-triggered runs** (a DM or @mention) get both `SLACK_CHANNEL_ID` and
  `SLACK_THREAD_TS` set, so the message replies into the originating thread.
- **Cron runs** get `SLACK_CHANNEL_ID` set (to the configured alert/report channel) but
  never `SLACK_THREAD_TS` — there is no originating thread, so the message posts directly
  to the channel instead of a reply.

See `docs/configuration.md` for the full env var reference.

---

## Fallback behavior

`slack-say.ts` never throws and never fails the calling step — it is a best-effort ping,
not a step whose failure should block anything:

- **No `SLACK_BOT_TOKEN` or no channel resolved** (neither flag nor env var) → the text is
  written to stdout instead, exit 0. This is the expected path for local/non-Slack runs.
- **Slack API returns non-2xx or `ok: false`** → one line naming Slack's `error` string is
  written to stderr, exit 0.
- **No thread resolved** (neither `--thread` nor `SLACK_THREAD_TS`) → the message posts to
  the channel directly rather than as a threaded reply.

---

## Reference

- Script: `plugins/shipwright/scripts/slack-say.ts`
- Unit tests: `plugins/shipwright/scripts/slack-say.unit.test.ts`
- Env var reference: `docs/configuration.md`
