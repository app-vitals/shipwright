# Plan: chart-parity-fix

**Session**: `chart-parity-fix` · **Prefix**: `CRP` · **Repo**: `app-vitals/shipwright`

## Problem
The `chart render parity vs base` job (`helm.yml` `render-parity`) was built as the zero-rename gate for the chart-move refactor (CHM-1.2) but runs on every `charts/**` PR. Any PR that intentionally changes rendered output fails it: auto-bump PRs move release tags (e.g. `agent-v1.439.0` -> `agent-v1.439.1`, agent-chat image 0.9.0 -> 0.12.0), and chart-version bumps also tripped it via `helm.sh/chart` text embedded in the cert-manager bootstrap ConfigMap string (`data.10-issuer.yaml`), which `normalize()` does not scrub. Failing runs: 40572842620, 40571855104, 40594291554.

## Design
- **Scope the gate to refactors.** A refactor renders identically by definition; `feat`/`fix`/`chore` PRs (including auto-bumps) change output on purpose. `pr-title-lint` already enforces Conventional-Commit titles, so `startsWith(github.event.pull_request.title, 'refactor')` needs no new convention. Add `edited`/`reopened` to the `pull_request` trigger types so retitling re-evaluates. A skipped job counts as passing for a required check.
- **Make `normalize()` scrub the label inside strings.** The tool's contract is "ignore the chart-version label"; `helm.sh/chart: <name>-<semver>` as text inside a string value is the same label. Regex anchored on the `helm.sh/chart:` prefix so image tags and other values still diff.
- Rejected: skipping by `chore/chart-v*` branch name (hides the gate on one PR family, leaves feature PRs failing); normalizing image tags (blinds the gate to real image changes); dropping the label from embedded manifests (breaking change that fails parity on its own PR).

## Tasks
| Task | Title | Layer | Cx / Model | Depends on |
|---|---|---|---|---|
| CRP-1.1 | ci: run render-parity only on refactor PRs | CLI | 1 / haiku | — |
| CRP-1.2 | fix: scrub embedded helm.sh/chart labels in render-parity normalize | CLI | 2 / haiku | — |

## Dependency Map
```
[START]
  ├─ CRP-1.1 (no deps)
  └─ CRP-1.2 (no deps)
```
Both safe to deploy standalone: yes. No HITL.
