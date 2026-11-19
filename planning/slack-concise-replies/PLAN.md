# Plan: slack-concise-replies

Home repo: `app-vitals/shipwright`. Also targets `app-vitals/agent`.

## Problem

Agent replies in Slack are too long. Nothing in the agent runtime tells agents how to write
for Slack; the only guidance is one SOUL line ("Concise when needed, thorough when it
matters"), which reads as permission for long replies. `/prd` and `/plan-session` post
whole spec sections, four-layer designs, full task tables and dependency graphs for
approval in one message. Humans skim these and miss the ask. On mobile, an ask at the top of
a long message forces scrolling up, then back down to the reply box.

## Design

**One rule set, defined once, in the runtime-owned `RUNTIME.md.template`** (`app-vitals/agent`).
`RUNTIME.md` is rewritten on every agent boot (`runtime/setup.ts`, `writeIfChanged`), so the
new "Slack Style" section reaches existing agents on the next image rollout. `SOUL.md`,
`IDENTITY.md` and `SPECIALTY.md` are seeded once and are agent-owned, so edits to their
templates only affect newly created agents.

**Rules (message needing a reply):**
1. First line is a headline: what this is.
2. At most 3 bullets of context.
3. The ask goes **last**, on its own line, right above the reply box. Numbered options where
   there are choices ("reply 1 or 2").
4. The whole message fits one phone screen (about 8-10 lines). Over that: trim or link out.
5. One decision per message; raise the next one after the answer.
6. Offer to drill down ("want details on #2?") instead of dumping detail.

**Message types:**

| Type | Shape |
|---|---|
| Chat reply / ask (`/prd`, `/plan-session`, `unblock`, `hitl`) | Rules 1-6 above |
| Decision needing a human | Headline, the 2-3 facts needed to decide, link, ask last |
| PR bodies, review posts, comment replies (`dev-task`, `patch`, `review`) | Not chat: bottom line first, then the specific details a reviewer needs (what changed, risk, what to check) as bullets. No narrative |
| Cron / status posts | Status line, counts, link. 3-5 lines |

Important items go in the headline, never trimmed. Artifacts (PR bodies, reviews, plan and
spec files) stay full-length; the brevity rule is for chat.

## Decision Log

- One-at-a-time scope: defaulted to decision-style messages only; status/results use short bullets.
- Cron posts: defaulted to 3-5 line summary plus link.
- Cross-repo: no release gate. The shipwright skill edits embed their own rules and consume no
  new `@app-vitals/agent-*` export; the `RUNTIME.md` change rolls out via the normal agent image chain.
- Existing agents' SOUL.md: left to a human task (`CSM-3.1`) because seeded files are agent-owned.

## Tasks

| Task | Repo | Title | Depends on | HITL |
|---|---|---|---|---|
| CSM-1.1 | app-vitals/agent | feat: add Slack Style section to RUNTIME.md.template | - | |
| CSM-2.1 | app-vitals/shipwright | docs: align SOUL template Vibe line with Slack Style | - | |
| CSM-2.2 | app-vitals/shipwright | feat: concise one-section-at-a-time interaction in /prd | - | |
| CSM-2.3 | app-vitals/shipwright | feat: staged, concise interaction in /plan-session | - | |
| CSM-2.4 | app-vitals/shipwright | feat: concise human-facing messages in unblock and hitl | - | |
| CSM-2.5 | app-vitals/shipwright | feat: bottom-line-first PR bodies and comment replies in dev-task and patch | - | |
| CSM-2.6 | app-vitals/shipwright | feat: concise review posts and staged-review prompts | - | |
| CSM-2.7 | app-vitals/shipwright | feat: cap cron-run final summaries for merge and scans | - | |
| CSM-3.1 | app-vitals/shipwright | chore: update existing agents' SOUL.md Vibe line | CSM-2.1 | HITL |

Dependency graph: `CSM-2.1 -> CSM-3.1`; everything else is independent.

Safe to deploy standalone: yes for every task (prompt/template text only; additions and
rewording, no renames or removals of consumed interfaces). Content tests asserting on the
edited files (`prd.content.test.ts`, `plan-session.content.test.ts`, `hitl.content.test.ts`,
`unblock.content.test.ts`, `dev-task.content.test.ts`, `patch.content.test.ts`,
`review*.content.test.ts`, `merge.content.test.ts`, `templates.content.test.ts`,
`RUNTIME.md.template.content.test.ts`) must be updated in the same task as the edit.
