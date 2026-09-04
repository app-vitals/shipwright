# slack-thread-context — shipwright

<!-- Generated: 2026-09-03 | Source design: an internal design doc from a private sibling repo (shipwright-relevant section) -->

## Why

A deployed agent's `claude -p` run can only reach Slack through its final response. The spawned process is not told which channel or thread it is serving, so a skill that wants to post a progress line mid-run (a 30-minute media pipeline, a long deploy, a multi-stage migration) has no way to address the thread it was started from. Background cron ticks that continue that work post to the cron's channel as top-level messages, not into the originating thread.

The concrete driver is a multi-stage podcast pipeline run by a marketing agent from a channel thread, where the operator needs one status line per stage in that thread and the work is continued by a resumer cron between operator replies. The capability is general: any long-running skill on any agent benefits.

## Scope

1. **Thread context in the spawned env.** Slack-originated runs (`app.message`, `app_mention`, `reaction_added` in `agent/src/slack.ts`) pass the resolved `channel` and `thread_ts` (the same values used to build the session key) through the runner into `agent/src/claude.ts` `_spawn`, exported as `SLACK_CHANNEL_ID` and `SLACK_THREAD_TS` on the child env. Cron runs (`agent/src/cron-handler.ts`) set `SLACK_CHANNEL_ID` to the cron's `channel` (or the resolved DM channel for `user` crons) and leave `SLACK_THREAD_TS` unset. Both variables are documented in `agent/workspace/CLAUDE.md.template` alongside the response-marker table.

2. **`slack-say` helper** at `plugins/shipwright/scripts/slack-say.ts`, invoked as `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/slack-say.ts [--channel C] [--thread T] "text"`:
   - `--channel` / `--thread` default from `SLACK_CHANNEL_ID` / `SLACK_THREAD_TS`.
   - Posts via `chat.postMessage` with `SLACK_BOT_TOKEN`, `thread_ts` when present, `mrkdwn: true`, `unfurl_links: false`.
   - If no token or no channel can be resolved, prints the text to stdout and exits 0 — it must never fail a run (terminal use, tests, misconfigured agent).
   - Non-2xx / `ok: false` from Slack is logged to stderr with the Slack error string and exits 0 for the same reason.
   - A skill entry (`plugins/shipwright/skills/slack-say/SKILL.md` or a section in an existing skill) documents when to use it: stage boundaries of long work, never for chatter.

3. **Doc fix** in `agent/workspace/CLAUDE.md.template` "Waiting and Polling": the paragraph stating that a failed resume silently clears the session id and restarts context-free is stale — `_runClaude` retries the same resumed session once and, on double failure, rethrows leaving the mapping intact. Rewrite to match the code, and add the recommended pattern for waits longer than the Bash ceiling: submit the job, persist its id in a state file, end the turn, let a cron tick (with `preCheck`) poll and continue.

## Constraints

- Test isolation rules in `CLAUDE.md`: inject `fetch` into `slack-say` (no `global.fetch` override), inject time via `Clock` if any is needed, no `mock.module()`.
- Env injection must not leak into cron-originated runs' `SLACK_THREAD_TS`, and must not change `spawnEnv` behaviour for `SENTRY_DSN` stripping.
- Public repo: no client names, no channel ids or tokens in fixtures; use `C0EXAMPLE` / `1700000000.000100` style placeholders. Run `task check-strings` and `task pre-public` before committing.
- Versioning is owned by semantic-release (`marketplace-dev` skill) — no manual `plugin.json`/`marketplace.json` edits; a `feat:` commit is sufficient to bump the minor on merge.
- Follow `docs/agent.md` for the env-var reference table if one exists there.

## Testing strategy

| Layer | What |
|---|---|
| unit | `slack.ts` handler → runner receives `{channel, thread_ts}`; `claude.ts` `_spawn` env contains `SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` when provided and omits `SLACK_THREAD_TS` for cron; `slack-say` builds the correct `chat.postMessage` body, uses `thread_ts` only when present, falls back to stdout without token/channel, and exits 0 on a Slack `ok:false` |
| smoke | none needed (no HTTP route surface) |
| docs | `task check-config-docs` passes after the template change |

## Out of scope

- A one-shot / delayed scheduling primitive (the podcast pipeline uses a recurring `preCheck` cron instead).
- Any change to the Thinking Steps stream or `SlackProgress`.
- Reply-to-thread for cron posts themselves (the helper is what posts into threads; cron final text keeps its current behaviour).

## Verification

1. Unit tests above green; `task ci` green.
2. On a dev agent: DM the agent with a prompt that runs `slack-say "hello from mid-run"` then waits 20 s before answering — the "hello" line appears in the DM before the final response.
3. Same from a channel thread: the line lands inside the thread, not at channel top level.
4. A cron with `channel` set runs a prompt calling `slack-say` with no flags: the line lands in that channel; `SLACK_THREAD_TS` is unset in the run (verify with `env | grep SLACK_` in the prompt).
5. `bun run plugins/shipwright/scripts/slack-say.ts "x"` with no env prints `x` and exits 0.
