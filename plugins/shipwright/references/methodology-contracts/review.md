# Review Methodology Contract

The interface any subagent plugged into the "review" pipeline phase must satisfy — whether
that's the bundled `shipwright:code-reviewer` agent or a custom, operator-supplied subagent
swapped in via a per-agent, per-phase `AgentPhaseMethodology` override (`phase ->
subagentType or null`). The `/shipwright:review` command is the caller: it gathers the inputs
below, dispatches whichever subagent is configured for the review phase, and parses the
output shape below regardless of which concrete agent produced it. A drop-in replacement for
the built-in reviewer must accept exactly these inputs and return exactly this output shape —
the caller has no other integration point and does no phase-specific adaptation.

`plugins/shipwright/agents/code-reviewer.md` is the **reference implementation** this
contract was extracted from — its "The caller ... will pass you:" list and "## Output
Format" section are the ground truth this doc formalizes. Consult it for the full set of
review heuristics and rules a built-in implementation applies; this doc only specifies the
wire shape, not review policy or grading logic.

## Inputs

- **PR metadata** — `title`, `author`, `headRefName` (the PR's head branch), `baseRefName`
  (the PR's base branch), `headRefOid` (the head commit SHA). Also included alongside these:
  the PR `number`.
- **`diff`** — the full diff against the base branch (e.g. `git diff "origin/$base"...HEAD`).
- **Changed files** — the list of files touched by the diff.
- **CLAUDE.md content** — the contents of the root CLAUDE.md plus any directory-scoped
  CLAUDE.md files that live in directories containing changed files. Each should be
  identifiable (e.g. labeled by its directory) so the subagent knows which directory each
  block governs.
- **`acceptanceCriteria`** (optional) — the acceptance criteria from a mapped shipwright
  task, when the PR maps to one. Omitted entirely (not passed as an empty value) when there
  is no mapped task.
- **`testReadinessContext`** (optional) — the contents of `docs/test-readiness/test-system.md`
  plus the Testing section of the repo's CLAUDE.md. Omitted entirely when no test-readiness
  content was gathered; a compliant subagent falls back to a universal testing baseline when
  this field is absent.
- **Prior Findings — Requires Resolution Check** (PVD-1.2, optional) — a list of prior review
  bodies this same subagent posted on an earlier commit of this PR, each entry carrying a
  `ref` identifying which prior review it is. Omitted entirely when there are no prior
  qualifying reviews to check. When present, the subagent must explicitly assess, for
  **each** entry, whether the issue that prior review originally described is still present
  in the current diff, and report its determination per-entry in the output's
  `priorFindingsStatus[]` field.
- **Policy thresholds** — `min_confidence` (default 75) and `max_findings` (default 5). The
  subagent filters/scopes its findings against these; the caller may additionally re-apply
  them, but a compliant subagent should not emit findings below `min_confidence`.

## Output

A single JSON object:

```json
{
  "summary": "{1-2 sentence description of what the PR does and its overall quality}",
  "findings": [
    {
      "title": "{short issue title}",
      "file": "{path/to/file.ts}",
      "line": "{integer or null}",
      "severity": "critical|important|suggestion",
      "confidence": "{0-100}",
      "category": "bug|security|api-break|acceptance-criteria|silent-failure|claude-md|quality|test-readiness|architecture",
      "description": "{what's wrong, with enough context that the caller can format it}",
      "suggestion": "{optional one-line fix; null if none}"
    }
  ],
  "strengths": ["{what the PR does well — keep brief, 0-3 bullets}"],
  "recommendation": "APPROVE|COMMENT",
  "recommendation_reason": "{one-sentence reasoning}",
  "priorFindingsStatus": [
    {
      "ref": "{the ref identifying which prior review this entry addresses}",
      "resolved": true,
      "evidence": "{file:line or diff excerpt proving the fix, or explaining why it's not resolved}"
    }
  ],
  "riskAssessment": {
    "level": "low|medium|high",
    "factors": [
      {
        "factor": "{name of the judgment factor, e.g. blast radius}",
        "level": "low|medium|high",
        "evidence": "{file:line or diff excerpt supporting the rating}"
      }
    ]
  }
}
```

- **`summary`** — a short prose description of the PR and its overall quality.
- **`findings[]`** — zero or more findings, each with:
  - `title` — a short issue title.
  - `file` — the path of the affected file.
  - `line` — the affected line number, or `null` when not line-specific.
  - `severity` — `critical` / `important` / `suggestion`, mapped from `confidence`
    (`critical` = 90-100, `important` = 75-89, `suggestion` = 50-74).
  - `confidence` — 0-100. Findings below 50 should not be emitted at all; the caller applies
    the `min_confidence` threshold it passed in and trims to `max_findings`.
  - `category` — one of `bug`, `security`, `api-break`, `acceptance-criteria`,
    `silent-failure`, `claude-md`, `quality`, `test-readiness`, `architecture`.
  - `description` — enough context for the caller to format the finding without re-deriving
    it from the diff.
  - `suggestion` — an optional one-line fix, or `null` when none is offered.
- **`strengths[]`** — 0-3 brief bullets on what the PR does well.
- **`recommendation`** — `APPROVE` or `COMMENT` (the two verdicts this contract requires as
  its minimum bar, alongside a findings list and per-finding confidence). `APPROVE` when no
  findings meet the threshold; `COMMENT` otherwise.
- **`recommendation_reason`** — one sentence explaining the recommendation.
- **`priorFindingsStatus[]`** — required whenever the caller passed the "Prior Findings —
  Requires Resolution Check" input; omitted (or an empty array) only when the caller passed
  no such input. One entry per prior review `ref` passed in:
  - `ref` — identifies which prior review's `ref` this entry addresses.
  - `resolved` — boolean.
  - `evidence` — **required in both the `resolved: true` and `resolved: false` cases**, never
    left blank. For `resolved: true`, cite the exact `file:line` or diff excerpt proving the
    fix. For `resolved: false`, explain why the originally-described issue is still present.
- **`riskAssessment`** — **optional**. An overall risk rating for the PR, omitted entirely when
  the reviewer does not assess risk; omitting it is always valid, so custom reviewers that
  predate this field are unaffected and the caller must not treat its absence as an error.
  When present:
  - `level` — `low`, `medium`, or `high`: the overall risk of merging the PR.
  - `factors[]` — the judgment-based factors behind the rating, each with `factor` (the factor
    name), `level` (`low` / `medium` / `high`), and `evidence` (a `file:line` or diff excerpt
    supporting the rating). Factors are judgment-based, e.g. blast radius, data
    integrity/migrations, reversibility/rollback, availability hot paths, and public API
    changes. Factors must not be based on who the author is or any other person-based signal.

## Multiple reviewers

For the `review` phase only, the per-agent override may be a comma-separated list of up to 5
subagent types (e.g. `a,b`). The contract above is unchanged **per reviewer**: every entry
receives identical inputs and must return the same output shape, and a single-entry list is
the ordinary single-reviewer path. Everything else is owned by the caller, not by the
reviewers:

- **Fan-out** — the caller dispatches all reviewers in one parallel Agent call. A reviewer
  that fails is retried once, then dropped; if all fail, the built-in fallback chain runs.
- **Merge** — the caller dedupes findings across reviewers (same file, lines within 3, similar
  title), keeping the highest severity and the highest confidence, and records an agreement
  count used only as a `max_findings` tie-break. `priorFindingsStatus[]` is merged
  conservatively: a prior finding is `resolved` only if every reporting reviewer attests it.
  Thresholds (`min_confidence`, `max_findings`) are applied after the merge, not per reviewer.
- **Verifier** — when more than one reviewer's response was merged, the caller runs the fixed
  built-in `shipwright:finding-verifier`, which can only drop findings it cannot substantiate
  against the diff. It is not configurable (no phase key) and its failure is non-fatal.

A compliant reviewer needs no awareness of any of this; the merged result conforms to the
output shape above. See `commands/review.md` Step 7 for the full procedure.

## Scope

This contract covers only the wire shape between the caller and the review-phase subagent —
what goes in, what comes back. It says nothing about how the subagent decides confidence
scores, which review rules it applies, or how it should be prompted; those are the concrete
implementation's concern (see `code-reviewer.md` for the reference implementation's rule
set). It also says nothing about what the caller does with the output afterwards — scoring
thresholds, output formatting, posting to GitHub, or metrics — those stay entirely on the
caller's side of this boundary.
