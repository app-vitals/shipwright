# PRD Methodology Contract

The interface any subagent plugged into the "prd" phase must satisfy — whether that's the
bundled `/shipwright:prd` command or a custom, operator-supplied subagent swapped in via a
per-agent, per-phase `AgentPhaseMethodology` override (`phase -> subagentType or null`). The
`/shipwright:prd` command is the caller: it invokes whichever subagent is configured for the
prd phase, and consumes the output shape below regardless of which concrete agent produced it.
A drop-in replacement for the built-in PRD handler must accept exactly the inputs below and
produce exactly this output shape — the caller has no other integration point and does no
phase-specific adaptation.

`plugins/shipwright/commands/prd.md` is the **reference implementation** this contract was
extracted from. Consult it for the full PRD workflow (discovery phases, research enrichment,
complexity review, and the interactive drafting process); this doc only specifies the wire
shape and the durable output artifact, not the interactive session mechanics or question
flow.

## Inputs

The prd phase does not have a single bounded input payload the way review, patch, deploy, and
plan-session do. Instead, it is a continuous interactive multi-turn session:

- **Session folder name** (`{session}`) — passed to `/shipwright:prd {session}` by the human
  invoking the command. Used to derive the output path `planning/{session}/PRODUCT-SPEC.md`.
- **Human answers** — supplied one question at a time throughout the session. There is no
  pre-assembled input JSON; discovery is live and conversational. The subagent asks
  questions, probes vague answers, and gathers requirements through direct dialogue.

Because prd is a **direct human-invoked command** (not dispatched by `loop-orchestrator.ts`),
there is no caller-assembled input package and no autonomous-mode dispatch with a fixed
payload. The only "input" is the session name and the human's live interaction.

## Output

A single durable artifact: `planning/{session}/PRODUCT-SPEC.md`

**Location**: The file is written to `planning/{session}/PRODUCT-SPEC.md`, where `{session}`
is the folder-name argument the subagent was invoked with.

**Shape**: Must conform to the template structure defined in
`plugins/shipwright/references/product-spec-template.md`. The file is the bridge between
`/shipwright:prd` and `/shipwright:plan-session` — it is the input that plan-session consumes
directly via its `specContent` parameter.

**Required sections** (per the template):

- **Overview** — 2-3 sentences: what this is, why it matters, who it's for
- **Problem Statement** — the specific problem being solved (concrete, not vague)
- **Users & Context** — who uses this, in what workflow, and their goal
- **Features** — one subsection per feature, each with:
  - Priority (High / Medium / Low)
  - Description
  - User Stories
  - Requirements (bulleted)
  - **Acceptance Criteria** — testable, observable checkboxes (`- [ ] {specific outcome}`)
  - Technical Considerations (existing patterns, APIs, constraints)
  - Source Map (files the feature touches)
  - Testing Strategy (test layer and rationale)
- **Technical Constraints** — things the implementation must comply with or avoid
- **Scope**:
  - In Scope (explicitly included capabilities)
  - Out of Scope (explicitly excluded — prevents scope creep)
- **Priorities & Sequence** — build order constraints, if any
- **Testing Strategy** — summary table mapping each feature to its test layer
- **Resolved Decisions** — every uncertainty driven to a decision or named external blocker
  (no "TBD" or deferred items)
- **Success Criteria** — overall completion condition from user and technical perspectives

**Quality bar**:

- Every feature has **at least one testable acceptance criterion** written as a checkbox
  (`- [ ] {specific, observable, testable outcome}`). Acceptance criteria must be verifiable
  by a developer without additional clarification — avoid subjective language ("good UX",
  "fast", "clean").
- **No unresolved "TBD" markers.** Every uncertainty encountered during the PRD session must
  be driven to either a Resolved Decision (with rationale) or a named external blocker (with
  owner). The rule is explicit in the reference implementation's Phase 8 (Q8): unresolved
  questions must not be written to the spec. Plan-session cannot generate tasks from
  unresolved questions.
- All decisions in the Resolved Decisions section carry a rationale explaining why that
  choice was made, or (if a default was chosen on the subagent's recommendation) noting that
  it can be revisited before plan-session.

**Downstream integration**: `/shipwright:plan-session` reads `planning/{session}/PRODUCT-SPEC.md`
directly — it is the sole downstream consumer of prd's output. The plan-session command will
fail or produce poor task breakdowns if the spec is missing required sections, contains
unresolved questions, or lacks specific acceptance criteria.

## Scope

This contract covers only the shape and content of the durable output artifact —
`PRODUCT-SPEC.md` — and the requirement that every output must conform to the template
structure and quality bar. It says nothing about:

- How the subagent conducts the interactive discovery session (question flow, probing strategy,
  research enrichment) — that is the reference implementation's concern.
- What happens after the file is written (plan-session's consumption, task generation, or
  downstream planning) — that stays entirely on the plan-session side of this boundary.
- The discovery process, research phases, or complexity-review mechanics — only the final
  artifact's shape is specified here.

**Why this is the lightest contract of the six:**

1. **No task-store writes.** Unlike plan-session (`POST /tasks/bulk`), review, patch, and
   deploy (which all write/update task-store PR records), prd never touches the task store
   at all. Its only durable output is the PRODUCT-SPEC.md file on disk. There is no queue
   state, no PR tracking record, no completion marker in an external service.

2. **Not loop-dispatched.** Per the Shipwright plugin's Design Constitution
   (`plugins/shipwright/CLAUDE.md`, "Candidate Selection Contract" section), the
   `shipwright-loop` cron's `loop-orchestrator.ts` dispatches exactly five pipeline phases
   via candidate providers: `check-dev-task.ts`, `check-plan.ts` (for plan-session),
   `check-review.ts`, `check-patch.ts`, and `check-deploy.ts`. There is no `check-prd.ts` —
   prd is invoked only directly by a human running `/shipwright:prd {folder-name}`. By
   contrast, plan-session IS both human-invocable and loop-dispatched under `--autonomous`;
   prd has no such dual mode.

**Forward compatibility note:** As of this task, `admin/src/agent-phase-methodology.ts`
supports `"prd"` as one of six valid phase values, but no dispatcher in `agent/` or `plugins/`
currently wires prd's config yet for subagent selection. This contract is written for forward
compatibility — describing the shape a swapped-in subagent would need to satisfy once the
wiring is added (PRM-1.2). Today, `/shipwright:prd` always uses the bundled command.
