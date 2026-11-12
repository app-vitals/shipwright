# Plan: specialists-agent-integration

Session: `specialists-agent-integration`. Audit and decisions: [FINDINGS.md](./FINDINGS.md). Audited: specialists `6ba55b9`, agent `ac19919`.

## Design

Specialists predates the agent module. This session lands only the changes that hold regardless of the open composition question, and parks the rest.

Decisions in force (see FINDINGS.md for the reasoning):

- Nothing new goes into the agent repo for persona or bootstrap. The `specialist-base` persona hook stays so specialists features keep working.
- Specialty crons become system crons when specialists adopts the manifest (parked).
- The manifest is a specialists artifact in the agent repo's format; nothing is added to the agent repo for it.
- Specialists depends on the agent module, not on Shipwright. The image stays `FROM shipwright-agent` until vitals-os hosts a different image per specialty.
- Composition is not touched. A manifest resolves one specialty per agent, so manifest adoption is parked behind that decision.

## Tasks

| Task | Title | Repo | Layer | Hrs | Cx / model | Branch | Deps | HITL |
|---|---|---|---|---|---|---|---|---|
| SAI-1.1 | docs: replace the "zero Shipwright changes" rule in the specialists CLAUDE.md | app-vitals/specialists | Shared | 1 | 1 / haiku | `docs/sai-1-1-replace-zero-shipwright-rule` | — | |
| SAI-1.2 | fix: make the specialist manifest templatesDir resolve | app-vitals/agent | Shared | 2 | 2 / haiku | `fix/sai-1-2-specialist-templates-dir` | — | |

### SAI-1.1: docs: replace the "zero Shipwright changes" rule in the specialists CLAUDE.md

Replace the first hard rule in `CLAUDE.md` ("Zero Shipwright changes. This repo consumes Shipwright's public admin API and plugin mechanism only...") with a rule that matches the decision: specialists depends on the agent module and not on Shipwright.

Acceptance criteria:
- The hard rule states that specialists integrates through the agent module's published surfaces (packages, platform image contract, admin API, manifest and extension points), and that a feature needing an agent-repo change is raised as a request instead of worked around.
- The rule does not claim the image base has changed: it notes the derived image stays `FROM shipwright-agent` until per-specialty images exist.
- No other doc in the repo (`README.md`, `docs/`, `planning/`) repeats the old wording; any that do are updated in the same PR.
- Test decision: docs-only, no test layer affected. Run `bun test` and `bun run lint` to confirm no content test asserts on the old CLAUDE.md wording; add no tests and retire none.

Safe to deploy standalone: yes.

### SAI-1.2: fix: make the specialist manifest templatesDir resolve

The shipped `specialist` manifest sets `identity.templatesDir` to `specialties/specialist/templates/`, which does not exist in this repo (the files live under `agent-types/specialist/templates/`), so the type silently falls back to the built-in templates. Point it at the real directory.

Acceptance criteria:
- `agent-types/specialist/manifest.yaml` `identity.templatesDir` resolves to `agent-types/specialist/templates/`, and `resolveTemplatesDir()` returns that directory for the `specialist` type with no fallback warning.
- The "Known drift" section of `docs/agent-types.md` no longer lists the `templatesDir` problem. The remaining path-comment drift stays only if still true.
- Existing agents are unaffected: existing workspace files are never rewritten, and only `SPECIALTY.md` is rewritten on boot (the specialist template is a placeholder).
- Test decision: unit layer. Add a test that loads the real shipped `specialist` manifest and asserts its templates directory resolves to `agent-types/specialist/templates/`. Retire none; extend the existing manifest content test if it already covers the file.

Breaking Change Scan: changes which template set new `specialist`-type agents are seeded from. No removal or rename. Safe to deploy standalone: yes.

## Dependency map

```
[START]
  ├─ SAI-1.1: docs: replace the "zero Shipwright changes" rule   (no deps)
  └─ SAI-1.2: fix: make the specialist manifest templatesDir resolve   (no deps)
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| SAI-1.1 | — | — | |
| SAI-1.2 | — | — | |

HITL scan: no tasks require human steps.

## Parked (not queued)

Revisit when composition in specialists is decided. They are recorded here so they are not lost; they are not in the task store.

- Declare each specialty's plugins, env keys, tools and crons in an agent-format manifest, with crons as system crons. Blocked on: one specialty per agent, and on how manifests reach the admin deployment's specialties directory.
- Retire the duplicated cron and env declarations once the manifest is the source.
- Composition: remove from specialists, with Saul-style agents defined as one specialty carrying a plugin list.
