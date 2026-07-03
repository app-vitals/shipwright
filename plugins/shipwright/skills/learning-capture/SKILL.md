---
name: learning-capture
description: >
  Capture a durable learning by editing context directly. Triggers when the user
  corrects Claude in a generalizable way ("use X instead of Y", "always X", "never Y",
  "I prefer X", "from now on X"), states a reusable preference, or asks to "remember this"
  / "save this". Also triggers on the /learn command. Does NOT trigger on one-off,
  problem-specific corrections — see the generalization gate before acting.
---

# Learning Capture

When the user teaches you something durable, put it in its permanent home **now** —
edit `CLAUDE.md` or the relevant skill in the same turn. Git is the audit trail. There
is no staging file and no separate promotion step.

This skill replaces the old capture → stage → promote flow. That flow added three
interruptions and trusted the model less than it deserves. The model is trusted to make
the edit; the user reviews it the same way they review any other change — in the diff.

## The one rule: pass the gate first

Before editing anything, run the **generalization gate**. Capture a learning **only if
both** are true:

1. **It generalizes.** It will apply to *future, different* work — not just the change
   you both just made. A correction scoped to "this function", "this file", "this PR",
   or "in this case" is not a learning. It is just doing the task.

2. **It is not already captured by the code.** If the change you just committed already
   embodies the rule — the code does it the right way now, a test enforces it, a type
   makes the wrong version impossible, a lint rule will catch it — then **the code is the
   memory.** A `CLAUDE.md` line that restates what the diff already shows is noise and
   will rot. Skip it.

If you are unsure whether something generalizes, it probably does not. See
`references/generalization-gate.md` for the full criteria, signal patterns, and worked
examples. **When in doubt, do not capture.** A missed learning costs nothing; a noisy
`CLAUDE.md` costs every future session.

## What passes the gate (capture these)

- A correction the user frames as a standing rule: "always", "never", "from now on",
  "in general", "as a rule", "going forward".
- A preference that will shape unrelated future work: tooling, style, workflow.
- A non-obvious discovery that took real effort and will recur — a misleading error, an
  undocumented behavior, a workaround — *and* that the code itself does not now make
  self-evident.
- Anything the user explicitly says to remember.

## What fails the gate (do not capture)

- A correction that the committed change now embodies. The diff is the record.
- A fix scoped to one symbol, file, or ticket — "in this case", "just here", "for now".
- A restatement of something already in `CLAUDE.md`, a skill, the linter, or the types.
- A vague preference ("do it better") with no actionable content.
- A question, a hypothetical, or a quote from docs being discussed.

## How to capture: edit the home directly

When a learning passes the gate, pick its home, edit the file, and tell the user in one
line. Do not ask permission for the edit itself — the user opted in by correcting you, or
by running `/learn`. They can undo it with git like any other change.

### Routing — two questions: what scope, what form

Dropping the staging tier did not drop the *judgement* the old promote step made. That
judgement still matters — it just happens inline now. It is two questions.

**Question 1 — what scope?** Pick the **narrowest scope that still covers everywhere the
learning is true.** Too narrow and a future session misses it; too broad and you pollute
unrelated work.

| Scope | Home | True for... |
|-------|------|-------------|
| **Package** | `./packages/<x>/CLAUDE.md` (nearest) | one part of one repo |
| **Project · team** | `./CLAUDE.md` (committed) | this repo, everyone on it |
| **Project · personal** | `./CLAUDE.local.md` (gitignored) | this repo, just you |
| **User** | `~/.claude/CLAUDE.md` | every repo you work in, just you |
| **Person / agent** | the harness's own memory system (`~/.claude/projects/.../memory/*.md`, type: user) when present, else `workspace/LEARNINGS.md` as fallback | durable facts about a specific person or agent that the user interacts with (role, review authority, tone preference) |
| **Plugin / org** | a skill or file in a plugin — *in the plugin's own repo* | reusable across people and repos |
| **Agent workspace** | `workspace/LEARNINGS.md` | persistent-agent workspaces where a LEARNINGS file is the session memory store |

**Note on User vs. Person / agent:** The **User** row captures the acting user's own
preferences — keyboard shortcuts, style choices, workflow habits. The **Person / agent**
row captures durable facts *about* a specific individual or agent — their role, review
authority, tone preference — not the person currently at the keyboard. This distinction
allows you to remember facts about teammates, collaborators, or agents you interact with,
separate from your own working preferences.

The team-vs-personal split at the project level is the one to get right: if a teammate
would benefit, it is `CLAUDE.md`; if it is your taste alone, it is `CLAUDE.local.md`.
Ask the user if it is genuinely unclear.

The **Plugin / org** row is the tricky one: a plugin's home is its *own repo*, usually a
sibling of the project you are in, not a file under it. See **The home is often another
repo** below before routing one of these.

**Question 2 — instruction or skill?** A one-line rule is an *instruction* — it goes in a
`CLAUDE.md` at the scope above. A multi-step procedure or reusable workflow is a *skill*.
A skill is itself scoped: `./.claude/skills/` (project), `~/.claude/skills/` (user), or a
plugin (org). Same ladder, different form.

Keep `CLAUDE.md` edits to **one concise line per concept** — it is part of every prompt.
For a skill, add the guidance to the right section and keep the SKILL.md focused.

### Confirm in one line

After editing, say what you did and where, so it shows in the transcript:

```
Noted in CLAUDE.md: use `uv`, not `pip`, for Python package management.
```

That is the whole interaction. No preview, no "stage this?", no follow-up command.

## The home is often another repo — and you do not go there now

A learning is frequently *not* about the project you are working in. It is about a piece
of your **harness** — a plugin, a skill pack, your marketplace, your `~/.claude` setup —
and that harness lives in its own repo, a sibling of the project you are in.

Two things are true at once:

1. The learning belongs in the **tool's repo**, not this project's `CLAUDE.md`. Writing
   it here buries it where nobody who maintains the tool will see it.
2. Reaching across to another repo mid-session — opening it, editing it, branching,
   committing, opening a PR — while you are in the middle of something else, *is* the
   kind of disruption v0.2 exists to remove. It is the staging-tier problem wearing a
   different coat.

**So the interactive track does not cross repos.** It does the minimal, in-flow thing:
records a precise `# Harness TODO` in `CLAUDE.local.md`. The cross-repo edit and the PR
are batched onto the dream job, which runs when you are *not* in flow.

### Record a Harness TODO

Append to a `# Harness TODO` section in the current project's `CLAUDE.local.md`. Do the
useful detection now — you just record it instead of acting on it:

- Identify the tool and its repo. Check the session's **working directories** and
  `~/.claude/plugins/known_marketplaces.json` (a `directory` source is a local clone; a
  `github` source is a cache that cannot be edited).
- Write the entry so the dream job can flush it without re-investigating: name the repo
  path, the file, the change, and one line of why.

```markdown
# Harness TODO

- **shipwright** (`~/src/shipwright`, local) — `skills/learning-capture/SKILL.md`:
  the gate should call out type-system enforcement explicitly. Small edit.
- **shipwright** (`~/src/shipwright`, local) — the staging model is wrong;
  needs a redesign. Large: file as an issue, not an edit.
```

Then confirm in one line and keep working:

```
Logged a Harness TODO for the shipwright plugin. The dream job will pick it up.
```

### The dream job flushes the queue

`/learn-dream` reads `# Harness TODO`, locates each local repo, makes the **small** edits,
opens an issue for the **large** ones, and bundles everything per repo into **one PR** —
not one interruption per correction. For a `github`-source plugin with no local clone, it
leaves a note: to fix upstream, clone the marketplace as a local `directory` source.

If you do not run a nightly dream job, run `/learn-dream` on demand to flush the queue.

This is where the old "promote" judgement still lives — code you do not own needs a PR,
and a tool you own but is not in front of you needs carrying to its repo — but the
*carrying* is now batched and off your critical path.

## Duplicates and contradictions

Before adding a line, grep the target file. If a similar line exists, **edit it in place**
rather than appending a near-duplicate. If the new learning contradicts an old one, the
new one wins — replace it, do not stack both.

## Autonomous agents do not use this skill

This skill assumes a human is present and just corrected you. Managed agents and
background agents run headless — there is no correction to react to in real time. Their
learnings are captured in batch by the **dream job** (`/learn-dream`), which reads
session transcripts on a schedule. See `commands/learn-dream.md`.
