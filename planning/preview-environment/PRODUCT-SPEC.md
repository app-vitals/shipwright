# Preview Environment — Product Specification

**Date**: 2026-11-14
**Session**: preview-environment
**Status**: Draft

## Overview

A preview environment brings the whole Shipwright stack up on a throwaway kind cluster inside a GitHub Actions runner. One job tests the stack automatically on pull requests that could break it; a second job, started only when a developer asks from the pull request, exposes the same stack at a password-protected public URL for a short window so a person can try the change in a browser. It ships in this repository as an open-source feature that any Shipwright adopter can enable with one GitHub Environment and one secret.

Supporting documents, which carry interface-level detail this spec does not repeat:

- Design: `docs/superpowers/specs/2026-11-14-preview-environment-design.md`
- Implementation plan: `docs/superpowers/plans/2026-11-14-preview-environment.md`

## Problem Statement

A Shipwright change is never seen running as a whole stack on Kubernetes until after it is released. The existing `helm-e2e` job installs the chart on kind but builds only two of the service images, runs only on chart changes, and checks only that services answer a connection test. No suite tests a deployed Shipwright end to end, and there is no way for a person to click through a pull request's version of the admin UI without running the stack on their own machine.

## Users & Context

- **Maintainers and contributors opening pull requests.** They want to know, before merge, that the admin, metrics, task-store, chat, mcp-server and agent provisioning still work together.
- **A developer or reviewer who wants to try a change by hand.** They ask for a preview from the pull request, wait for an approval, and open a URL.
- **The approver.** A maintainer who releases the preview password to a run by approving it.
- **Adopters running their own copy of Shipwright.** They enable the same feature with no cloud account and no cluster.

It is for pre-release testing only. No agent does real work in a preview and no real credential is placed in it.

---

## Features

### Feature 1: Feasibility probe

**Priority**: High
**Description**: A one-off measurement that decides whether the full stack fits on a standard GitHub-hosted runner, and records eight facts the later features depend on. It gates all other work.

**User Stories**:
- As a maintainer, I want measured numbers before anything is built so that we do not build a job that cannot run.

**Requirements**:
- Run the full stack (five images built from source, every service enabled) on `ubuntu-latest` from a throwaway workflow on a spike branch that is never merged.
- Record findings P1 to P8 as listed in the implementation plan, Task 1: time to Ready cold and warm; peak memory and any OOM or Pending pod; whether an agent pod reaches Ready with no model credential; what the admin API needs under `auth.mode: open`; which htpasswd hash format the ingress accepts and whether the admin tolerates a forwarded `Basic` header; whether the admin UI and chat page work through a quick tunnel started before install; whether an explicitly named `*.canary.test.ts` file runs under `bun test`; whether the job token can read environment protection rules.
- Apply the go/no-go rule: go if the warm run reaches Ready in under 15 minutes with no OOM kill and no Pending pod.
- If the rule fails, apply three fallbacks in order, re-measuring after each: trim resource requests; pull the published agent image instead of building it; drop the provisioned agent from the default run.

**Acceptance Criteria**:
- [ ] A `## Probe findings` section in `docs/superpowers/plans/2026-11-14-preview-environment.md` records a value for each of P1 to P8 and names any fallback applied.
- [ ] The findings state "go" or "no-go" against the 15-minute, no-OOM, no-Pending rule.
- [ ] If "no-go" after all three fallbacks, no later feature is started and the numbers are reported to the maintainers.
- [ ] The spike branch and its workflow are deleted; nothing from the spike is merged except the findings.

**Technical Considerations**: Model the workflow on the `helm-e2e` job in `.github/workflows/helm.yml` (kind creation, image build and `kind load`). The agent pod requests 500m CPU and 2Gi memory.

**Source Map**:
- `.github/workflows/helm.yml` — pattern to copy for the spike
- `charts/shipwright/examples/values-minikube.yaml` — starting values
- `docs/superpowers/plans/2026-11-14-preview-environment.md` — receives the findings

**Testing Strategy**: Layer: none — this is a measurement spike with a written result, not shipped code.

---

### Feature 2: Preview values profile

**Priority**: High
**Description**: A chart values file that turns every service on for a throwaway cluster.

**User Stories**:
- As a maintainer, I want one values file that represents "the whole stack" so that both jobs install the same thing.

**Requirements**:
- `charts/shipwright/examples/values-preview.yaml` enables admin, metrics, task-store, chat, mcp-server, agent provisioning and bundled PostgreSQL.
- The five images built in CI (admin, metrics, task-store, mcp-server, agent) use local repositories with `pullPolicy: Never`. Chat and PostgreSQL are pulled.
- Metrics runs in live mode, reading the task-store and admin, not offline fixtures.
- `auth.mode: open`; no persistence; resource requests sized from probe finding P2.
- Tokens come from pre-created Secrets named `shipwright-preview-mcp`, `shipwright-preview-task-store-seed` and `shipwright-preview-metrics`.
- The file is not placed in `charts/shipwright/ci/`.
- The chart version, chart CHANGELOG and `artifacthub.io/changes` annotation are bumped.

**Acceptance Criteria**:
- [ ] `helm unittest charts/shipwright` passes a new suite asserting Deployments render for admin, metrics, task-store, chat and mcp-server under this file.
- [ ] The suite asserts the metrics Deployment is not in offline mode and has task-store and admin URLs set.
- [ ] The suite asserts the five built images use `imagePullPolicy: Never`.
- [ ] The suite asserts the Ingress carries no basic-auth annotation by default.
- [ ] `task helm:check` passes, including the chart version-increment check.

**Technical Considerations**: The mcp-server Deployment always reads its tokens from `mcpServer.auth.existingSecret`; the chart cannot mint a task-store token, so the task-store seeds one from `TASK_STORE_SEED_ADMIN_TOKEN` through `taskStore.extraEnv`. The `render-parity` job renders every file in `examples/` on refactor PRs.

**Source Map**:
- `charts/shipwright/examples/values-minikube.yaml` — starting point
- `charts/shipwright/values.yaml` — keys for `mcpServer`, `taskStore.extraEnv`, `metrics.provider`
- `charts/shipwright/tests/` — existing helm-unittest suites to follow
- `charts/shipwright/Chart.yaml`, `charts/shipwright/CHANGELOG.md` — version bump

**Testing Strategy**: Layer: unit (helm-unittest) — rendered-manifest assertions with no cluster.

---

### Feature 3: Bring-up script

**Priority**: High
**Description**: A script that installs the preview profile onto a Kubernetes context that already exists. It does not create a cluster and knows nothing about GitHub, so the same script can later target something other than kind.

**User Stories**:
- As a workflow author, I want one command that turns an empty cluster into a running Shipwright so that every job brings the stack up the same way.
- As a developer, I want to run the same bring-up against a local kind cluster.

**Requirements**:
- `scripts/preview-env.ts` is a pure command builder plus an injected-exec driver, the pattern used by `scripts/minikube.ts`.
- It generates random throwaway tokens on every run and creates the three Secrets before install.
- It installs the ingress controller and waits for it, runs `helm dependency build`, installs the chart, and waits for every workload.
- It accepts an ingress host; when given, it also sets the admin base URL to `https://<host>`.
- It starts port-forwards on fixed local ports for admin, metrics, task-store, chat, mcp-server and the ingress, and writes the service URLs and throwaway tokens to an env file.
- No secret value appears in a command's arguments or in anything the driver prints.
- A `task preview:up` entry runs it.

**Acceptance Criteria**:
- [ ] Unit tests show the builder never emits a cluster-creation command.
- [ ] Unit tests show every `kubectl` and `helm` command names the given context.
- [ ] Unit tests show the three Secrets, the ingress readiness wait and `helm dependency build` all come before `helm install`.
- [ ] Unit tests show that with a host set, the install sets the ingress host and the `https://` admin base URL.
- [ ] Unit tests show no command label contains a generated token.
- [ ] Running `task preview:up` against a local kind cluster with the five images loaded ends with every Deployment available.

**Technical Considerations**: Reuse `Command`, `ExecFn` and `runCommands` from `scripts/minikube.ts`. That file's header documents the ordering rules. Interfaces are fixed in the implementation plan, Task 3.

**Source Map**:
- `scripts/minikube.ts` — types and pattern to reuse
- `scripts/minikube.unit.test.ts` — test pattern
- `Taskfile.yml` — new `preview:up` entry

**Testing Strategy**: Layer: unit — the command list is built by a pure function and tested with an injected exec.

---

### Feature 4: Deployed-target test suite

**Priority**: High
**Description**: The first test suite that exercises a running Shipwright through its service APIs.

**User Stories**:
- As a maintainer, I want tests that prove the services work together so that a green PR means more than "the pods started".

**Requirements**:
- Tests live in `preview/canary/` and use the repository's reserved `*.canary.test.ts` suffix, run by a dedicated `task preview:canary` entry and never by plain `bun test`.
- The suite reads one URL per service and the throwaway tokens from the environment, and refuses any URL that is not local unless explicitly allowed.
- It covers: admin health and readiness; a task-store create, read, update, delete round trip, plus rejection without a token; a task created in the task-store appearing in the metrics API; chat health; an mcp-server call reaching the task-store, plus rejection without a token; creating and deleting an agent through the admin API.
- Every test removes what it created.
- The agent check asserts the pod state that probe finding P3 showed is reachable without a model credential.

**Acceptance Criteria**:
- [ ] `task preview:canary` passes against a stack brought up by `task preview:up`.
- [ ] The suite completes in under 60 seconds.
- [ ] A missing target variable produces an error naming every missing variable.
- [ ] A non-local target URL is refused unless `PREVIEW_ALLOW_REMOTE=true`.
- [ ] After a run, the task-store holds no task created by the suite and no test agent remains.
- [ ] `task ci` still passes and plain `bun test` does not execute any `*.canary.test.ts` file.

**Technical Considerations**: Take routes and payloads from each service's own route definitions and OpenAPI spec. The metrics service has read routes only, which is why its test is "a task shows up" and not "ingest an event". `bunfig.toml` already excludes `*.canary.test.ts`; probe finding P7 decides how the dedicated task invokes the files.

**Source Map**:
- `bunfig.toml` — existing canary exclusion
- `docs/test-readiness/naming.md` — the reserved suffix rule
- `plugins/shipwright/skills/canary-execution/SKILL.md` — the canary contract
- `task-store/src/`, `metrics/src/`, `mcp-server/src/` — route contracts
- `Taskfile.yml` — new `preview:canary` entry

**Testing Strategy**: Layer: smoke, deployed-target (`*.canary.test.ts`) — HTTP contracts against real running services; the target-reading helper is unit tested.

---

### Feature 5: Shared bring-up action and automatic test job

**Priority**: High
**Description**: A composite action that creates the cluster, builds the images and runs the bring-up, and the first of the two jobs: an automatic test that uses no secrets and never opens a tunnel.

**User Stories**:
- As a contributor, I want the whole stack tested on my PR without asking so that I find integration breaks before merge.
- As an outside contributor on a fork, I want the same test to run on my PR.

**Requirements**:
- `.github/actions/preview-env/action.yml` is a composite action, not a reusable workflow. It takes a source path (Dockerfiles and chart), a trusted path (the script), an optional host and an optional htpasswd file.
- It builds the five images with layer caching and side-loads them into kind.
- `.github/workflows/preview-test.yml` triggers on every `pull_request` and uses an internal change detector, as `ci.yml` does, to run the real work only when the diff touches the chart, a service directory, the preview files, or the agent-platform version pins (`package.json`, `bun.lock`).
- The job runs `helm test`, then the deployed-target suite.
- On failure it uploads pod status, events and logs, excluding Secret objects.
- A new push cancels the previous run for the same PR.
- It is not made a required check in this work.

**Acceptance Criteria**:
- [ ] A content test asserts the workflow triggers only on `pull_request`, has `contents: read` permissions, references no secret, declares no environment, and never mentions `cloudflared`.
- [ ] A content test asserts every third-party action in the action and workflow is pinned by commit SHA.
- [ ] A content test asserts the action passes no build arguments or build secrets to image builds.
- [ ] The job passes on this feature's own pull request.
- [ ] On a pull request that changes only documentation, the job finishes without creating a cluster.
- [ ] A deliberately broken service causes the job to fail and produces the diagnostics artifact.

**Technical Considerations**: A reusable workflow runs as a separate job on a separate runner, so the cluster would not survive to the caller; that is why this is a composite action. Automated platform-release and chart-bump PRs must match the change detector so that an agent-platform release is tested when it arrives here.

**Source Map**:
- `.github/workflows/helm.yml` — kind and image-build steps to follow
- `.github/workflows/ci.yml` — the `changes` job to model
- `.github/actions/helm-repos/` — reused for chart repos
- `ci-chart-shell-tests.content.test.ts` — pattern for root-level workflow content tests

**Testing Strategy**: Layer: content — static assertions on the workflow and action YAML at the repo root; the job running green on its own PR is the integration proof.

---

### Feature 6: Browser tests against the deployment

**Priority**: Medium
**Description**: New Playwright specs that drive the deployed admin UI and metrics dashboard.

**User Stories**:
- As a maintainer, I want a browser to load the real deployed UI on PRs so that rendering and wiring breaks are caught.

**Requirements**:
- Specs live in `preview/e2e/` with their own Playwright config whose base URL comes from the environment and which fails at load if it is unset.
- Three specs: the admin UI loads with no console errors; an agent created through the API appears on the agents page; the metrics dashboard renders.
- The existing fixture-based suites in `admin/e2e` and `metrics/e2e` are not modified.
- `bunfig.toml` excludes `preview/e2e/` from `bun test`.
- The automatic test job runs these specs after the deployed-target suite.

**Acceptance Criteria**:
- [ ] `task preview:e2e` reports 3 passed against a stack brought up by `task preview:up`.
- [ ] The config throws a clear error when the base URL variable is unset.
- [ ] `git diff` shows no change under `admin/e2e` or `metrics/e2e`.
- [ ] `task ci` passes and `bun test` does not try to execute `.e2e.ts` files under `preview/`.
- [ ] The automatic test job runs the specs and a content test asserts the step exists.

**Technical Considerations**: Both existing Playwright suites start a fixture server and mint session cookies with a fixture secret, so none of their specs can be pointed at a deployment.

**Source Map**:
- `bunfig.toml` — add the exclusion
- `admin/playwright.config.ts` — config shape to follow
- `.github/workflows/preview-test.yml` — add the step
- `Taskfile.yml` — new `preview:e2e` entry

**Testing Strategy**: Layer: e2e — a real browser against the running stack.

---

### Feature 7: Password gate

**Priority**: High
**Description**: Basic authentication enforced at the ingress in front of every route, with tooling to build it from a hashed password and to prove it works.

**User Stories**:
- As a maintainer, I want the previewed admin UI unreachable without the password, because the preview runs with authentication turned off inside.

**Requirements**:
- `scripts/preview-gate.ts` reads the password from stdin, never from an argument, and refuses an empty or whitespace-only value.
- It writes an htpasswd file with two entries: user `preview` with the hashed shared password, and a random per-run self-check user.
- The hash format is the one probe finding P5 showed the ingress accepts.
- The bring-up script, when given the htpasswd file, creates the gate Secret before install and installs with the basic-auth annotations.
- A verify command checks three things through a URL: no credentials gets 401; wrong credentials get 401; the self-check credential gets 200.
- If P5 showed the admin rejects a forwarded `Basic` header, the gate strips it at the ingress.

**Acceptance Criteria**:
- [ ] Unit tests show an empty and a whitespace-only password are refused.
- [ ] Unit tests show a password containing `:`, quotes and a trailing newline is accepted with only the trailing newline removed.
- [ ] Unit tests show verification fails when an unauthenticated request returns anything other than 401.
- [ ] Unit tests show verification fails when the self-check credential does not return 200.
- [ ] Unit tests show the hash command prints neither the password nor the self-check password.
- [ ] Unit tests show that with a gate, the gate Secret is created before `helm install`, and without one no auth annotation is set.

**Technical Considerations**: `networking.ingress.annotations` exists in the chart, so ingress-nginx basic auth needs no template change. Inject `fetch`; do not override the global.

**Source Map**:
- `scripts/preview-env.ts` — gains the gate branch
- `charts/shipwright/values.yaml` — `networking.ingress.annotations`

**Testing Strategy**: Layer: unit — hashing, file assembly and verification logic with an injected fetch.

---

### Feature 8: Preview window and pull request comment

**Priority**: High
**Description**: The logic that keeps a preview alive, decides when it ends, and tells people on the pull request.

**User Stories**:
- As a developer, I want one comment on my PR that tells me the URL, who to ask for the password, and when it expires.
- As a maintainer, I want a preview to end by itself so that no public URL is left open.

**Requirements**:
- `scripts/preview-hold.ts` polls once a minute and ends the preview when any of these holds: the window has passed; the job is 345 minutes old; the `preview` label is gone; the PR is closed; the PR head no longer matches the previewed commit; the tunnel process has died; three polls in a row have failed.
- The default window is 120 minutes and is settable; it is always capped by elapsed job time.
- One comment per PR, found by a hidden marker and updated in place. Live: URL, username `preview`, short commit SHA, expiry time, and that maintainers hold the password. Expired: no URL, and the reason.

**Acceptance Criteria**:
- [ ] Unit tests with an injected clock show each of the seven end conditions returns its own reason.
- [ ] Unit tests show two failed polls continue and the third stops.
- [ ] Unit tests show a 120-minute request late in a job is shortened to end 345 minutes after job start.
- [ ] Unit tests show the live comment contains the URL, username, short SHA and expiry.
- [ ] Unit tests show the expired comment contains no URL.

**Technical Considerations**: Inject the clock and the PR-state fetcher. Fail closed on API errors.

**Source Map**:
- New files only: `scripts/preview-hold.ts`, `scripts/preview-hold.unit.test.ts`

**Testing Strategy**: Layer: unit — pure decision logic with an injected clock.

---

### Feature 9: On-request preview job

**Priority**: High
**Description**: The second job. A developer adds the `preview` label on a pull request; after a maintainer approves, the stack comes up behind the gate at a public URL and stays up for the window.

**User Stories**:
- As a developer, I want to add a label to my PR and get a URL where I can click through my change.
- As an approver, I want to release the password with one click and be confident the PR's code cannot read it.

**Requirements**:
- `.github/workflows/preview.yml` triggers on `pull_request_target` `labeled` (label `preview`) and on manual dispatch with a PR number.
- A first job with no environment validates the label and refuses a PR whose head is in a fork.
- The preview job declares `environment: preview`, a 355-minute timeout, and permissions of `contents: read` and `pull-requests: write` only.
- It checks out the default branch to `trusted/` and the PR head to `pr/` without credentials. Every local action and every executed script comes from `trusted/`. `pr/` is used only as the image build context and chart path.
- The password secret is passed to exactly one step, which hashes it and runs before the PR is checked out.
- The job fails before any tunnel starts if the password is empty. If probe finding P8 showed the job token can read protection rules, it also fails when the environment has no required reviewers; otherwise it prints a warning pointing at the docs.
- A pinned, checksum-verified `cloudflared` quick tunnel starts before the chart is installed; its hostname becomes the ingress host.
- The job runs `helm test`, the deployed-target suite and the browser specs, verifies the gate through the public URL, posts the comment, and holds.
- On any exit the tunnel is stopped first, then the comment is marked expired.
- One preview per PR at a time; no cancel-in-progress.

**Acceptance Criteria**:
- [ ] A content test asserts the two triggers and the fork check in a first job with no environment.
- [ ] A content test asserts `secrets.PREVIEW_PASSWORD` appears in exactly one step and that step precedes the PR checkout.
- [ ] A content test asserts every `uses: ./` path starts with `./trusted/` and no `run` step executes a file under `pr/`.
- [ ] A content test asserts the job token is referenced only in the comment and hold steps.
- [ ] A content test asserts the tunnel step precedes the bring-up, the comment step follows gate verification, and an `if: always()` cleanup stops the tunnel before updating the comment.
- [ ] A content test asserts the concurrency group includes the PR number with cancel-in-progress off.
- [ ] After merge and repository setup: labelling a same-repository PR and approving it produces a comment with a URL that returns 401 without credentials and loads the admin UI with them.
- [ ] Removing the label marks the comment expired and the URL stops answering within two minutes.
- [ ] Labelling a PR from a fork raises no approval request.

**Technical Considerations**: `pull_request_target` runs the workflow file from the default branch with access to secrets, which is why the trusted and PR checkouts must be kept apart and why the content test exists. This event and manual dispatch only work once the workflow is on the default branch, so the last three criteria are checked after merge.

**Source Map**:
- `.github/actions/preview-env/action.yml` — called from `trusted/`
- `scripts/preview-gate.ts`, `scripts/preview-hold.ts`, `scripts/preview-env.ts` — invoked from `trusted/`
- `ci-chart-shell-tests.content.test.ts` — content-test pattern

**Testing Strategy**: Layer: content — static assertions on the workflow; a human-run live check after merge covers the end-to-end path.

---

### Feature 10: Adopter documentation and repository setup

**Priority**: Medium
**Description**: The guide an adopter follows to turn the feature on, and the one-time settings for this repository.

**User Stories**:
- As an adopter, I want a short page that tells me what to create in GitHub settings and what the feature will and will not do.

**Requirements**:
- `docs/preview-environment.md` covers: what it is and is not; the two jobs and how they differ; one-time setup; requesting and ending a preview; how the password is protected; limits; troubleshooting.
- Setup is written as browser steps: create the `preview` label; create the `preview` environment; add required reviewers; restrict deployment branches to the default branch; add the `PREVIEW_PASSWORD` environment secret.
- It states that required reviewers on a private repository need a GitHub plan that includes them, and that without reviewers there is no approval gate.
- It states that the public URL is for a browser only and that API calls cannot be made through it.
- `docs/README.md` and `CLAUDE.md` gain one line each pointing at the new page and tasks.

**Acceptance Criteria**:
- [ ] `docs/preview-environment.md` exists with the seven sections above.
- [ ] The page contains no client name, operator identity, internal hostname or credential; `task check-strings` passes.
- [ ] `task ci` passes, including the docs checks.
- [ ] A maintainer has created the label, environment, reviewers, branch restriction and secret on this repository by following only the page.

**Technical Considerations**: The repository is public; follow the "Before you commit" rules in `CLAUDE.md`.

**Source Map**:
- `docs/README.md` — index entry
- `CLAUDE.md` — one line under Commands

**Testing Strategy**: Layer: content — covered by the existing docs and banned-strings checks.

---

## Technical Constraints

- Public MIT repository: no client names, operator identity, internal infrastructure identifiers, local filesystem paths or credentials in any file, log or PR comment.
- No real credential enters the cluster: no model key, GitHub token or cloud key.
- The plain-text preview password is passed to exactly one workflow step, before the PR is checked out.
- No tunnel starts unless the password is set and the job runs in the `preview` environment.
- In the preview workflow, executed code comes only from the default-branch checkout.
- Every third-party action is pinned by commit SHA.
- The preview values file never lives in `charts/shipwright/ci/`.
- Any change under `charts/shipwright/**` bumps the chart version, CHANGELOG and `artifacthub.io/changes`.
- Test layers follow the filename conventions in `CLAUDE.md`. No `mock.module()` and no global overrides; inject `fetch`, exec and a clock.
- `helm-e2e` and the fixture Playwright suites in `admin/e2e` and `metrics/e2e` are not modified.
- Runs on a standard GitHub-hosted Linux runner; a job cannot exceed 6 hours.
- Conventional Commits; `task ci` green before every commit.

## Scope

**In Scope**:
- The bring-up script, preview values profile and composite action.
- The automatic test job.
- The on-request preview job with approval, password gate, tunnel and hold.
- A deployed-target test suite and three browser specs.
- Adopter documentation.

**Out of Scope**:
- A staging environment or any long-lived cluster.
- Kargo, promotion between stages, or gating other repositories' release PRs.
- Installing already-published chart and image versions instead of building from the PR.
- Testing any downstream wrapper chart or cloud-specific wiring.
- An agent doing real work; any model or GitHub credential in the environment.
- Previews for fork pull requests.
- Per-person sign-in on the preview URL; a stable preview URL.
- API access through the public URL.
- Making the automatic test job a required check.
- Changes to `helm-e2e` or the existing Playwright suites.

## Priorities & Sequence

Feature 1 gates everything; nothing else starts until it reports "go".

Then Features 2 → 3 → 4 → 5 → 6 deliver the automatic test job, which involves no secrets and can merge on its own.

Features 7 and 8 depend only on Feature 3 and can be built in parallel with 4 to 6.

Feature 9 needs Features 5, 7 and 8. Feature 10 is last, and its repository-setup criterion and Feature 9's three live criteria are human steps done in a browser after Feature 9 merges.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Feasibility probe | none | A measurement with a written result, not shipped code |
| Preview values profile | unit (helm-unittest) | Rendered-manifest assertions with no cluster |
| Bring-up script | unit | Pure command builder tested with an injected exec |
| Deployed-target test suite | smoke, deployed-target | HTTP contracts against real running services |
| Shared action and automatic test job | content | Static assertions on workflow and action YAML |
| Browser tests against the deployment | e2e | A real browser against the running stack |
| Password gate | unit | Hashing and verification logic with an injected fetch |
| Preview window and comment | unit | Pure decision logic with an injected clock |
| On-request preview job | content | Static assertions on the workflow, plus a human live check |
| Adopter documentation | content | Existing docs and banned-strings checks |

## Resolved Decisions

- **Where it runs**: A kind cluster inside the GitHub runner, with a tunnel for the public URL. — Rationale: the only option that needs no infrastructure from an adopter and costs nothing on a public repo; a throwaway VM and a virtual cluster in an existing cluster were considered and rejected.
- **Two jobs**: An automatic test job and a separate on-request preview job. — Rationale: testing should need nobody to ask; public access should exist only when someone asks.
- **How a preview is requested**: A `preview` label on the pull request, with manual dispatch as a second route. — Rationale: developers ask from the pull request.
- **Trigger type for the preview job**: `pull_request_target`, with trusted code kept apart from PR code. — Rationale: a plain `pull_request` label trigger runs the PR's own copy of the workflow, which could rewrite the password handling.
- **Access control**: One shared password, HTTP basic auth at the ingress, username `preview`. — Rationale: per-person sign-in needs a fixed address and an identity provider, which a random tunnel address cannot support.
- **Password storage**: A secret in a GitHub Environment with required reviewers, restricted to the default branch. — Rationale: bots and apps with push access could read a plain repository secret.
- **Password handling in the job**: Hashed in the first step, before the PR is checked out; a per-run self-check credential proves the gate. — Rationale: PR code must never see the plain text.
- **Tunnel**: Cloudflare quick tunnel. — Rationale: free and needs no account; the client is open source and the maintainers accepted that the service is not.
- **Public URL is browser-only**: APIs are tested inside the runner through port-forwards. — Rationale: the gate and the services' bearer tokens use the same header.
- **Agent in the preview**: One agent is provisioned with no credentials and does no work. — Rationale: provisioning is covered without placing a model key in a reachable cluster.
- **Metrics mode**: Live, reading the task-store. — Rationale: offline fixtures would not test that the services work together.
- **Test fleet**: `helm test`, a new deployed-target suite, and new browser specs. — Rationale: the existing smoke tests run in-process and the existing browser suites are fixture-based.
- **Preview job runs the default branch's tests**: — Rationale: a consequence of never executing PR code in the privileged job; the PR's own tests run in the automatic job.
- **Fork pull requests**: Automatic tests only. — Rationale: GitHub gives fork runs no secrets.
- **Preview window**: 120 minutes by default, capped by elapsed job time; ends on label removal, close, new commit, tunnel death, repeated API failure or cancel. — Rationale: previews are rare and should not outlive their use.
- **Required check**: The automatic test job is not required at first. — Rationale: its flake rate on a 4-CPU runner is unknown until it has run for a while.
- **Bring-up packaging**: A composite action over a script that takes an existing kube context. — Rationale: a reusable workflow cannot share a cluster with its caller, and the split leaves room for a different target later.
- **Images**: Five built from the PR; chat and PostgreSQL pulled; whisper left out. — Rationale: chat is built in another repository and whisper is off by default.
- **Probe-dependent details**: The hash format, the agent readiness assertion, the admin API request shape and the reviewer-rule check each follow the matching probe finding, with the rule for each outcome written into the feature. — Rationale: these depend on behaviour in an external package or on the runner and could only be settled by measurement. _(Settled by Feature 1 before any dependent feature starts.)_

## Success Criteria

- A pull request that touches chart or service code gets a pass or fail from a job that installed every Shipwright service on a kind cluster from that PR's source and ran `helm test`, the deployed-target suite and the browser specs.
- That job uses no secrets, opens nothing to the internet, and also runs for fork pull requests.
- Adding the `preview` label to a same-repository pull request, followed by one approval, produces a PR comment with an HTTPS URL that returns 401 without credentials and loads the admin UI with username `preview` and the shared password.
- The preview ends by itself within its window, or within two minutes of the label being removed, and the comment says so.
- No public URL is ever created without the label and an approval.
- The plain-text password is never available to code from the pull request.
- An adopter can enable the feature by following `docs/preview-environment.md` alone.
