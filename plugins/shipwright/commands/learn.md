---
name: learn
description: Capture a durable learning and write it to its permanent home
argument-hint: "[insight]"
---

# /learn — Capture a Learning

Capture a learning and put it in its permanent home **now** — `CLAUDE.md`, the relevant
skill, or (for installed plugins) the right place per the routing rules. No staging file,
no separate promote step. Git is the audit trail.

## Usage

```
/learn use uv instead of pip
/learn always run the suite before committing
/learn SSR errors surface in the terminal, not the browser console
/learn
```

## Process

1. **Get the insight.**
   - With an argument: that is the insight.
   - Without an argument: look at the recent conversation, propose the one or two
     strongest candidate learnings, and ask the user which to capture (this is the only
     question the command asks — picking the insight, not approving the edit).

2. **Run the generalization gate.** Apply both tests from
   `skills/learning-capture/references/generalization-gate.md`:
   - Does it generalize beyond the change just made?
   - Is it already captured by the code, a test, a type, lint, CI, or existing docs?

   If it fails the gate, say so plainly and stop — do not write a watered-down version:

   ```
   Not capturing that — the change you just made already enforces it (the new
   handler is the pattern future handlers will copy). The code is the memory here.
   ```

3. **Route it** using the table in the `learning-capture` skill. Project `CLAUDE.md`,
   package `CLAUDE.md`, `~/.claude/CLAUDE.md` / `CLAUDE.local.md` for personal, a skill,
   or — for installed plugins — the plugin source (local marketplace) or a local override
   plus a PR note (remote marketplace).

4. **Check for duplicates.** Grep the target file. If a near-duplicate exists, edit it in
   place. If the new learning contradicts an old one, replace the old one.

5. **Make the edit and confirm in one line:**

   ```
   Noted in CLAUDE.md: use `uv`, not `pip`, for Python package management.
   ```

## Notes

- `/learn` is an explicit opt-in, so it does not ask permission for the edit — only,
  when run bare, which candidate insight to capture.
- The gate still applies to `/learn`. Running the command does not force a bad learning
  through; if it fails the gate, the command declines and explains why.
- For learnings across many past sessions rather than this one, use `/learn-dream`.
