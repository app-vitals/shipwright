# Prompt-Audit Decisions

A repo-tracked, project-level registry of prompt-audit findings that were looked at
and deliberately accepted. This is not a set of detection rules (those live in
`plugins/shipwright/skills/prompt-scan/references/thresholds.md`) — it's a record
of specific `prompt-scan` findings a human reviewed and chose to keep, so the scan
stops re-flagging them every run.

**Who edits this file:** humans, not agents. Entries are added during review of a
`prompt-fix` proposal (when a proposed edit is rejected as not worth doing) or
proactively (when the team already knows a cost is intentional and wants to
pre-empt the scan flagging it). This file lives at the same override tier as
`.claude/shipwright/consolidation-decisions.md` and
`.claude/shipwright/test-readiness-decisions.md` — repo-local, human-owned, loaded
by the skills but never written by them. The generic contract is described in
`plugins/shipwright/references/decisions-registry.md`.

**How `prompt-scan` consumes it:** the skill loads this file before merging a
scan's findings into `state/prompt-audit-ledger.json`. A missing file is a graceful
no-op ("no suppressions configured"). If it exists, entries are parsed generically
and defensively (one entry per accepted finding, with a description and a revisit
condition; anything the skill can't confidently interpret is skipped). A finding
whose fingerprint matches an entry's **Finding** is recorded as `suppressed` in the
ledger and omitted from the report — unless the entry's **Revisit** condition has
been met, in which case the suppression no longer applies and the finding is
eligible to resurface.

**Rule promotion:** `prompt-fix` tasks are propose-only (`hitl: true`) by default.
A rule may be promoted to autonomous execution only by a human-added entry here
carrying an additional `**Autonomy:** <rule>, <evidence>` field, after at least
five accepted proposals for that rule with no human edit or rejection. No such
entry exists yet.

---

## Entry Format

Each decision is one `###` entry with a fixed field order:

```
### <short finding name>

**Finding:** <rule id and file — specific enough that prompt-scan's fingerprint
  for it can be matched against this entry>
**Decision:** <accept as cost | reject proposal | other explicit call>
**Rationale:** <why this cost is intentional, not accidental>
**Revisit:** <the condition under which this decision should be reconsidered —
  a token threshold, a model change, a triggering event, or a date>
```

Keep **Finding** concrete enough to match against a real fingerprint, not a vague
category — a future reader (human or `prompt-scan` itself) should be able to tell
whether a newly-scanned finding is "the same thing" as this entry.

---

## Decisions

### Persona imports in the agent workspace template

**Finding:** `a/import-chain` on `agent/workspace/CLAUDE.md.template` for its
`@SOUL.md`, `@IDENTITY.md`, `@BOOTSTRAP.md` and `@VOICE.md` imports, which load at
launch in the `agent-runtime` context and count toward the always-loaded baseline.
**Decision:** Accept as cost. Do not propose converting these imports to
on-demand loads or inlining them.
**Rationale:** The four persona files are the agent's identity, operating rules,
first-run bootstrap and voice. They are meant to be in context on every turn, and
keeping them as separate `@` imports is deliberate so each can be edited and
templated independently. Moving them behind a path-scoped rule or a skill would
defeat their purpose, and the per-file split costs nothing extra: an `@` import
loads at launch exactly as inlined text would.
**Revisit:** Reconsider if the four persona files together exceed 150 lines, or
if a measured `agent-runtime` baseline for the fleet's default model shows the
always-loaded set above 10% of the model's context window.
