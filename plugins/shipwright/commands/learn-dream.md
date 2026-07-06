---
name: learn-dream
description: Extract cross-session learnings from past session transcripts in batch
argument-hint: "[--since <when>] [--apply | --review]"
---

# /learn-dream — Batch Learning from Session Transcripts

The interactive `learning-capture` skill needs a human in the loop — it reacts to a
correction as it happens. Autonomous agents (Managed Agents, background/cron agents) have
no human to react to. `/learn-dream` is how *they* learn: a batch job that reads past
session transcripts, finds patterns no single session could see, and writes the durable
ones into context.

This is the "dreaming" pattern — consolidation that happens *between* sessions, not
during them. Run it manually, or wire it to a nightly cron (see **Scheduling** below).

## Usage

```
/learn-dream                      # last 24h, review mode (default)
/learn-dream --since 7d            # last 7 days
/learn-dream --apply               # write learnings directly, no review
/learn-dream --review              # write a LEARNINGS-REVIEW.md for a human (default)
```

## Process

Delegate the heavy reading to the `learning-dreamer` agent. It:

1. **Collects transcripts.** Claude Code stores session transcripts as JSONL under
   `~/.claude/projects/<sanitized-project-path>/*.jsonl`. Managed Agents expose their own
   run logs. Gather every transcript in the window for this project.

2. **Mines cross-session patterns.** It is looking for signal that *only aggregation
   reveals* — never acting on a single session:
   - A correction or stumble that **recurred across multiple sessions**.
   - A workflow several runs **independently converged on**.
   - A tool call, command, or path that **failed repeatedly** the same way.
   - An existing `CLAUDE.md` line or skill that sessions **kept overriding** — a sign it
     is wrong or stale.

3. **Applies the gate, with recurrence.** Every candidate must pass both tests in
   `skills/learning-capture/references/generalization-gate.md` — *and* must have recurred
   across sessions. One occurrence is problem-specific noise; recurrence is the
   substitute for the human judgement the interactive skill relies on.

4. **Consolidates memory.** Dreaming is not only additive. The agent also prunes stale
   entries, merges duplicates, and resolves contradictions in `CLAUDE.md` and skills —
   keeping the context lean is as valuable as adding to it.

5. **Flushes the Harness TODO queue.** The interactive track never crosses repos — when
   it spots a learning about a plugin or skill, it logs a `# Harness TODO` in
   `CLAUDE.local.md` instead of context-switching. The dream job is where that queue gets
   drained. For each entry, the agent locates the tool's local repo, makes the **small**
   edits, opens an issue for the **large** ones, and bundles everything per repo into
   **one PR** — so a day of harness corrections becomes one PR per tool, reviewed when
   you choose, instead of N interruptions while you worked. See
   `agents/learning-dreamer.md`.

6. **Writes the output**, per mode:
   - `--review` (default): writes `LEARNINGS-REVIEW.md` at the repo root — proposed
     additions, edits, and deletions, each with the sessions that justify it. A human
     accepts or rejects, then deletes the file. Nothing touches `CLAUDE.md` unattended.
   - `--apply`: makes the edits directly and reports a summary. Use this only once a
     team trusts the dream job — and only with `CLAUDE.md` under version control, so
     every dreamed change is reviewable in the diff and revertable.

7. **Records the run.** On successful completion (either mode), write
   `state/learn-dream-last-run.json` with the current timestamp:
   ```json
   { "lastRun": "2026-07-06T03:00:00.000Z" }
   ```
   This is the anchor `scripts/check-learn-dream.ts` reads to gate future cron firings —
   without it, the precheck never has a baseline and every firing falls through to a full
   session. Write it last, after the review file or applied edits are in place, so a run
   that fails partway through does not falsely advance the anchor past unprocessed
   transcripts.

## Scheduling

Wire it to run overnight so learnings are waiting in the morning:

```bash
# crontab — nightly at 3am, review mode
0 3 * * * cd /path/to/repo && claude -p "/learn-dream --since 1d --review"
```

Start in `--review` mode. Move to `--apply` only after a few weeks of review output has
shown the dream job's judgement is sound.

## Why this is a separate track

Interactive capture and dreaming are two tracks of one loop, not competitors:

- **Interactive** — human present, reacts in real time, one good correction is enough.
- **Dreaming** — no human, runs in batch, needs recurrence to trust a pattern.

A team with both autonomous agents and humans at the keyboard runs both. A human
correcting Claude at 2pm and a dream job consolidating the fleet's transcripts at 3am
feed the same `CLAUDE.md`.
