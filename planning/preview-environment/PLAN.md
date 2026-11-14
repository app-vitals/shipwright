# Plan: preview-environment

Spec: `planning/preview-environment/PRODUCT-SPEC.md`
Design: `docs/superpowers/specs/2026-11-14-preview-environment-design.md`
Implementation plan: `docs/superpowers/plans/2026-11-14-preview-environment.md`

## Technical design

The spec carries an approved design and a file-level implementation plan, so this session adopts them as-is and only decomposes them into tasks.

- **Bring-up**: `scripts/preview-env.ts`, a pure command builder plus injected-exec driver reusing `Command`/`ExecFn`/`runCommands` from `scripts/minikube.ts`; installs `charts/shipwright/examples/values-preview.yaml` onto an existing kube context.
- **Two jobs, one composite action**: `.github/actions/preview-env` (kind, five image builds, bring-up) is called by `preview-test.yml` (automatic, `pull_request`, no secrets, no tunnel) and `preview.yml` (label-triggered `pull_request_target`, environment-gated, basic-auth gate, quick tunnel, hold loop).
- **Test fleet**: `helm test`, a new `preview/canary/*.canary.test.ts` suite, and three new Playwright specs in `preview/e2e/`. Existing `helm-e2e`, `admin/e2e`, `metrics/e2e` are untouched.
- **Security boundary**: in `preview.yml` all executed code comes from the default-branch checkout (`trusted/`); the PR checkout (`pr/`) is only a build context and chart path; the password is hashed in the single step that references the secret, before the PR is checked out. Enforced by content tests.
- **Test layers**: values profile = unit (helm-unittest); scripts = unit; canary = smoke/deployed-target; workflows/action = content; browser specs = e2e; docs = existing docs and banned-strings checks.

## Tasks

| Task | Title | Depends on | Layer | Hrs | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|
| PVE-1.1 | docs: record preview environment probe findings | — | Shared | 8 | 4 | sonnet | |
| PVE-2.1 | feat(chart): add preview values profile with every service enabled | 1.1 | Shared | 4 | 3 | sonnet | |
| PVE-3.1 | feat: add preview environment bring-up script | 2.1 | CLI | 6 | 4 | sonnet | |
| PVE-4.1 | test: add deployed-target canary suite for the preview environment | 3.1 | API | 8 | 4 | sonnet | |
| PVE-5.1 | ci: add preview-env action and automatic preview test workflow | 3.1, 4.1 | Background | 8 | 4 | sonnet | |
| PVE-6.1 | test: add browser specs for the preview environment | 5.1 | Frontend | 6 | 3 | sonnet | |
| PVE-7.1 | feat: add basic-auth gate for the preview environment | 3.1 | CLI | 6 | 4 | sonnet | |
| PVE-8.1 | feat: add preview hold loop and PR comment builder | 3.1 | CLI | 5 | 3 | sonnet | |
| PVE-9.1 | ci: add label-triggered preview workflow | 5.1, 6.1, 7.1, 8.1 | Background | 8 | 5 | opus | |
| PVE-10.1 | docs: document the preview environment | 9.1 | Shared | 3 | 2 | haiku | |
| PVE-10.2 | chore: configure preview label, environment, reviewers and secret in GitHub settings | 9.1, 10.1 | Shared | 1 | 1 | haiku | ⚠ HITL |
| PVE-10.3 | chore: run the live preview check on a test pull request | 10.2 | Shared | 1 | 1 | haiku | ⚠ HITL |

## Dependency map

```
[START]
  └─ PVE-1.1 probe (GATE: no other task may start until it reports "go")
        └─ PVE-2.1 values profile
              └─ PVE-3.1 bring-up script
                    ├─ PVE-4.1 canary suite
                    │     └─ PVE-5.1 action + automatic test workflow  (needs 3.1, 4.1)
                    │           └─ PVE-6.1 browser specs
                    ├─ PVE-7.1 password gate        (parallel with 4.1-6.1)
                    └─ PVE-8.1 hold loop + comment  (parallel with 4.1-6.1)
              PVE-9.1 preview workflow  (needs 5.1, 6.1, 7.1, 8.1)
                    └─ PVE-10.1 docs
                          └─ PVE-10.2 ⚠ HITL repo setup   (also needs 9.1 merged)
                                └─ PVE-10.3 ⚠ HITL live check
```

PVE-1.1 gates everything through the dependency chain. On "no-go" it is set to `blocked` (never `done`), so no dependent can become ready.

## Breaking change safety

All tasks are additive (new files, new workflow, new example values, new Taskfile entries). The only edits to existing files are: `Chart.yaml`/CHANGELOG (version bump, PVE-2.1), `Taskfile.yml` entries, `bunfig.toml` exclusion (PVE-6.1), `docs/README.md` and `CLAUDE.md` pointer lines (PVE-10.1), and the plan doc (PVE-1.1). `helm-e2e`, `admin/e2e` and `metrics/e2e` are not modified. Safe to deploy standalone: yes for every task. Release/deploy pipeline: new workflows only; chart is bumped once and no existing workflow's triggers change.

## HITL scan

- PVE-10.2 (Type A): GitHub Settings — create label, environment, reviewers, branch restriction, `PREVIEW_PASSWORD` secret.
- PVE-10.3 (Type A): live check in a browser on a real PR.
- PVE-9.1 adds a net-new `secrets.PREVIEW_PASSWORD` reference, which the CI-secret scan would normally flag as HITL. It is deliberately NOT flagged: the code change is fully agent-writable and fails closed until the secret exists; provisioning is carried by PVE-10.2.

## Decision Log

- Gating on the probe: defaulted to a dependency chain from PVE-1.1 plus "block, don't done, on no-go" — the task store has no other way to express "reports go".
- Probe-dependent details (hash format P5, agent readiness P3, admin request shape P4, reviewer-rule check P8, canary invocation P7, resource requests P2): defaulted to tasks reading the `## Probe findings` section of the plan doc rather than guessing now.
- PVE-9.1 also depends on PVE-6.1: the spec's sequence says Feature 9 needs 5, 7 and 8, but the preview job must run the browser specs (Feature 9 requirement), so 6 is a real prerequisite.
- PVE-7.1 and PVE-8.1 depend on PVE-3.1 only, as the spec states; they reach PVE-1.1 transitively.
- PVE-1.1 requires the docs in this plan's PR to be on main first; the findings are appended to the plan doc.
- Local kind verification: the planning agent has no container runtime, so ACs say "locally if a container runtime exists, otherwise via a throwaway CI run of the branch".
- PVE-9.1 scored complexity 5 / opus (default would be 4): a `pull_request_target` workflow with a privileged-job trust boundary where one mistake exposes the password.
- Docs task and HITL setup split: PVE-10.1 (docs) is agent work; the repository-setup criterion of Feature 10 is PVE-10.2, after the docs merge so the page is tested by following it alone. Feature 9's three live criteria are PVE-10.3.
- Task titles use conventional-commit types: `chore` for HITL settings tasks, `test` for suites, `ci` for workflows.

## Not carried

- "`task ci` passes" / "`task ci` green before every commit": enforced by the repo's merge gate.
- "Automatic test job is not made a required check": carried as a negative AC in PVE-5.1 (no branch-protection change).
- Spike branch deletion and "nothing from the spike merged except the findings": carried in PVE-1.1.
