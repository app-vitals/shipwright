# The Generalization Gate

The gate decides whether a correction is a *learning* (durable, worth context) or just
*the task* (already handled by doing the work). Most corrections are the task. Capturing
the task as a learning is the single biggest failure mode of a learning system: it fills
`CLAUDE.md` with one-off trivia until the file is too long to carry signal.

A correction passes the gate **only if both tests pass**.

---

## Test 1 — Does it generalize?

Ask: *will this apply to future work that is different from what we just did?*

The learning has to be true beyond the specific symbol, file, ticket, or bug in front of
you. If you cannot restate it without naming the thing you just changed, it does not
generalize.

| Generalizes (a learning)                          | Does not generalize (just the task)                     |
|----------------------------------------------------|---------------------------------------------------------|
| "Use `uv`, not `pip`, for Python deps."            | "Use `uv` to install the deps for *this* script."       |
| "Always run the suite before committing."          | "Run the suite now before you commit *this* PR."         |
| "API handlers go in `handlers/`, not `routes/`."   | "Move `getUser` into `handlers/`."                       |
| "We pin dependency versions exactly."              | "Pin `lodash` to 4.17.21."                              |

**Signal words that suggest it generalizes** — capture-leaning:
"always", "never", "from now on", "going forward", "in general", "as a rule",
"we / our team", "every time", "by default", "remember this".

**Signal words that suggest it does not** — skip-leaning:
"just this once", "for now", "temporarily", "in this case", "only here", "this one",
"for this PR".

When the signal is ambiguous, default to **does not generalize**.

---

## Test 2 — Is it already captured by the code?

Ask: *after the change we just made, would a fresh agent reading the repo already do the
right thing?*

If yes, the code is the memory. Writing it into `CLAUDE.md` too is duplication — and
worse, a duplicate that drifts: the code evolves, the prose does not, and now they
disagree.

The change you just made already captures the rule if:

- **The code now does it the right way** and that pattern is visible where future work
  will look. (The next handler will be copied from the one you just fixed.)
- **A test enforces it.** A failing test is a louder, more durable instruction than a
  `CLAUDE.md` line.
- **The type system makes the wrong version impossible.**
- **A lint rule, formatter, or CI gate will catch the violation** automatically.
- **It is already written down** — in `CLAUDE.md`, a skill, a `docs/` file, `REVIEW.md`.

A correction passes Test 2 only when the knowledge would otherwise be **lost** — when
nothing in the repo would stop a future agent from making the same mistake.

| Already captured — skip                                          | Not captured — eligible                                       |
|-------------------------------------------------------------------|---------------------------------------------------------------|
| You renamed the column; the migration is the record.             | "Two-release migration policy: drop code refs in N, column in N+1." |
| You fixed the import; the file now shows the right import.        | "SSR errors surface in the terminal, not the browser console."|
| You added the missing `await`; lint rule `no-floating-promises` covers it. | "Treasury Prime webhooks are fire-and-forget — reconcile, don't trust." |

The right column survives Test 2 because it is *policy* or *non-obvious system behavior*
that no single diff teaches.

---

## What is worth capturing, once both tests pass

In rough order of value:

1. **Standing corrections** — the user states a rule, not a fix. Highest signal.
2. **Non-obvious system behavior** — misleading errors, undocumented quirks, infra gotchas
   a future agent would burn an hour rediscovering.
3. **Policies and conventions** — decisions that constrain future work and are not
   mechanically enforced yet.
4. **Tooling and workflow preferences** — which tool, which command, which order.

## What is never worth capturing

- The task itself, restated as a rule.
- One-off corrections scoped to a single symbol/file/ticket.
- Anything a test, type, linter, or CI gate now enforces.
- Anything already written in `CLAUDE.md`, a skill, or `docs/`.
- Vague preferences with no action ("be more careful", "do it better").
- Questions, hypotheticals, and quotes from docs under discussion.

---

## The frequency dimension (for the dream job)

A human correcting you in real time *is* the signal — one explicit "always do X" is
enough, because a human judged it worth saying. The interactive `learning-capture` skill
relies on that judgement.

The **dream job** has no human in the loop, so it substitutes **recurrence** for
judgement: a pattern is only a learning if it shows up across **multiple sessions**. One
agent making one correction once is probably problem-specific noise. The same correction
surfacing in three sessions is a real, generalizable pattern. The dream job applies
Tests 1 and 2 *and* requires cross-session recurrence before it writes anything.
