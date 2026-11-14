# Preview Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the whole Shipwright stack up on a throwaway kind cluster inside a GitHub Actions runner, test it automatically, and on request expose it at a password-protected public URL for a limited window.

**Architecture:** A pure command-builder script (`scripts/preview-env.ts`) installs the chart onto an existing kube context; a composite action wraps cluster creation, image builds and that script. Two workflows call the action: `preview-test.yml` (automatic, no secrets, no tunnel) and `preview.yml` (label-triggered `pull_request_target`, approval-gated, adds a basic-auth gate at the ingress and a Cloudflare quick tunnel, then holds).

**Tech Stack:** Bun + TypeScript, go-task, Helm 4, kind, ingress-nginx, helm-unittest, Playwright, GitHub Actions, `cloudflared`.

**Spec:** `docs/superpowers/specs/2026-11-14-preview-environment-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Public MIT repo. No client names, operator identity, internal infra identifiers, local filesystem paths or credentials in any file, log line or PR comment. `task check-strings` must pass.
- No real credential ever enters the cluster: no model key, no GitHub token, no cloud key.
- The plain-text preview password is passed to exactly one workflow step, which runs before the PR is checked out.
- No tunnel process starts unless `PREVIEW_PASSWORD` is non-empty and the job runs in the `preview` environment.
- In `preview.yml`, every `uses: ./...` and every script a `run:` step executes comes from the default-branch checkout (`trusted/`). The PR checkout (`pr/`) is only a Docker build context and a chart path.
- The preview values file lives in `charts/shipwright/examples/`, never `charts/shipwright/ci/`.
- Any change under `charts/shipwright/**` bumps `Chart.yaml` `version`, adds a `charts/shipwright/CHANGELOG.md` entry and updates the `artifacthub.io/changes` annotation.
- Test layers by filename: `*.unit.test.ts`, `*.content.test.ts` (workflow guards live at the repo root because `bun test` skips dot-directories), `*.canary.test.ts` (deployed-target, excluded from `bun test`, run by a dedicated task), `*.e2e.ts` (Playwright).
- No `mock.module()`, no `global.fetch` overrides. Inject `fetch`, exec and a `Clock`.
- Every third-party action is pinned by commit SHA with a version comment, as in `helm.yml`.
- Conventional Commits, single-line messages. `task ci` green before every commit. Stage files by name, never `git add -A`.
- `helm-e2e` in `.github/workflows/helm.yml` and the fixture Playwright suites in `admin/e2e` and `metrics/e2e` are not modified.

## Review Focus

Conditions the spec implies that are most likely to bite, each pinned by a test in the task named:

1. **The tunnel process dies mid-window.** Expected: the preview ends and the PR comment is marked expired, not left advertising a dead URL. Pinned in Task 8 (`decideHold` with `tunnelAlive: false`).
2. **GitHub API errors while the hold loop polls.** Expected: fail closed. Three consecutive failed polls end the preview. Pinned in Task 8.
3. **The PR head moves between the label and the approval.** Expected: the preview builds the SHA recorded at request time, shows it in the comment, and ends at the first poll because the head no longer matches. Pinned in Task 8.
4. **A password that is empty, whitespace-only, or contains `:`, quotes or a trailing newline.** Expected: empty and whitespace-only are refused before anything starts; everything else hashes correctly because it is read from stdin, never argv. Pinned in Task 7.
5. **The `preview` label on a fork PR, or a second label while a preview is live.** Expected: the fork run stops before the environment job, so no approval request is raised; a second request never opens a second tunnel. Pinned in Task 9 (content test on job order and concurrency group).

## File Map

| File | Responsibility |
|---|---|
| `scripts/preview-env.ts` | Pure builder + driver: throwaway secrets, ingress controller, chart install, readiness wait, port-forwards |
| `scripts/preview-gate.ts` | htpasswd assembly, gate ingress values, gate verification |
| `scripts/preview-hold.ts` | Hold-loop decision logic, window arithmetic, PR comment body |
| `charts/shipwright/examples/values-preview.yaml` | Every service on, local images, live metrics, no persistence |
| `charts/shipwright/tests/preview_values_test.yaml` | helm-unittest guard for the preview profile |
| `.github/actions/preview-env/action.yml` | Composite action: kind, image builds, bring-up |
| `.github/workflows/preview-test.yml` | Automatic test job |
| `.github/workflows/preview.yml` | Label-triggered preview job |
| `preview/canary/*.canary.test.ts`, `preview/canary/targets.ts` | Deployed-target Bun suite |
| `preview/e2e/*.e2e.ts`, `preview/e2e/playwright.config.ts` | Deployed-target browser specs |
| `preview-*.content.test.ts` (repo root) | Workflow and action guards |
| `docs/preview-environment.md` | Adopter setup and limits |

---

### Task 1: Measure and probe (gate for everything else)

This is a spike. Its workflow is throwaway and is never merged. Its output is a findings section appended to this plan.

**Files:**
- Create (branch `spike/preview-probe` only): `.github/workflows/preview-probe.yml`
- Modify: this plan, new section `## Probe findings`

**Produces:** findings P1–P8, each a recorded fact later tasks read.

- [ ] **Step 1: Write `preview-probe.yml`**, triggered by `push` to `spike/preview-probe`, on `ubuntu-latest`. It creates a kind cluster, builds the admin, metrics, task-store, mcp-server and agent images from source (timing each), side-loads them, installs ingress-nginx, creates by hand the Secrets the chart needs with every service enabled, installs the chart, and waits for all Deployments.
- [ ] **Step 2: Record these, by running it twice (cold cache, then warm):**
  - **P1** wall time from job start to all Deployments Ready, cold and warm.
  - **P2** peak memory (`free -m` sampled every 15 s) and whether any pod was OOM-killed or stayed Pending.
  - **P3** whether an agent created through the admin API reaches Ready with no model credential, or what state it settles in.
  - **P4** exactly what a request to the admin API needs under `auth.mode: open` (headers, cookie, or nothing).
  - **P5** with basic auth on the ingress: which htpasswd hash formats ingress-nginx accepts (`htpasswd -B` bcrypt, then `apr1`), and whether the admin UI still works when the `Authorization: Basic` header is forwarded to it.
  - **P6** with `cloudflared tunnel --url` started before install and its hostname set as `networking.ingress.host` and the admin base URL: whether the admin UI, including the chat page, works through the tunnel.
  - **P7** whether `bun test ./path/x.canary.test.ts` runs a file that `bunfig.toml` `pathIgnorePatterns` excludes.
  - **P8** whether a job's `GITHUB_TOKEN` can read `GET /repos/{owner}/{repo}/environments/preview` and see `protection_rules`.
- [ ] **Step 3: Apply the go/no-go rule.** Go if warm P1 is under 15 minutes and P2 shows no OOM kill and no Pending pod. If not, apply the spec's fallbacks in order (trim resource requests; pull the published agent image instead of building; drop the provisioned agent) and re-measure after each. **If it still fails after all three, stop, write the numbers into `## Probe findings`, and report back. Do not start Task 2.**
- [ ] **Step 4: Write `## Probe findings`** in this plan with P1–P8 and which fallbacks, if any, were applied. Delete the `spike/preview-probe` branch.
- [ ] **Step 5: Commit** the plan update: `docs: record preview environment probe findings`.

### Task 2: Preview values profile

**Files:**
- Create: `charts/shipwright/examples/values-preview.yaml`
- Create: `charts/shipwright/tests/preview_values_test.yaml`
- Modify: `charts/shipwright/Chart.yaml`, `charts/shipwright/CHANGELOG.md`

**Produces:** Secret names the bring-up script must create before install:
- `shipwright-preview-mcp` with keys `SHIPWRIGHT_MCP_SERVER_TOKEN`, `SHIPWRIGHT_TASK_STORE_TOKEN` (referenced by `mcpServer.auth.existingSecret`)
- `shipwright-preview-task-store-seed` with key `TASK_STORE_SEED_ADMIN_TOKEN` (referenced from `taskStore.extraEnv`)
- `shipwright-preview-metrics` with the key the chart's `metrics.provider.taskStoreToken` block expects

- [ ] **Step 1: Write the failing helm-unittest suite** `preview_values_test.yaml`, following the existing suites in `charts/shipwright/tests/`, with `values: [../examples/values-preview.yaml]`. Assert:
  - Deployments render for admin, metrics, task-store, chat and mcp-server.
  - The metrics Deployment has no `METRICS_OFFLINE` env set to `"true"`, and has the task-store and admin URLs set.
  - Admin, metrics, task-store, mcp-server and agent images use `imagePullPolicy: Never`.
  - The admin Deployment has `ADMIN_DEV_AUTH` enabled (open mode).
  - No PersistentVolumeClaim renders for PostgreSQL.
  - The Ingress has no `nginx.ingress.kubernetes.io/auth-type` annotation (the gate is added only by the preview job).
- [ ] **Step 2: Run** `helm unittest charts/shipwright -f 'tests/preview_values_test.yaml'`. Expected: FAIL, values file not found.
- [ ] **Step 3: Write `values-preview.yaml`.** Start from `examples/values-minikube.yaml`. Changes: enable `mcpServer`; set `metrics.provider.offline: false` with `adminUrl`, `taskStoreUrl` and `taskStoreToken` pointing at the in-cluster services and the Secret above; local image repositories and tag `0.1.0` with `pullPolicy: Never` for the five built images; persistence off; resource requests from finding P2; a file-header comment stating it is for throwaway CI clusters only.
- [ ] **Step 4: Run** the suite again, then `task helm:check`. Expected: PASS.
- [ ] **Step 5: Bump** `Chart.yaml` `version` (patch), add the CHANGELOG entry and the `artifacthub.io/changes` annotation.
- [ ] **Step 6: Commit:** `feat(chart): add preview values profile with every service enabled`.

### Task 3: Bring-up script

**Files:**
- Create: `scripts/preview-env.ts`, `scripts/preview-env.unit.test.ts`
- Modify: `Taskfile.yml` (add `preview:up`)

**Interfaces:**
- Consumes: `Command`, `ExecFn`, `runCommands` from `scripts/minikube.ts`; Secret names from Task 2.
- Produces:

```ts
export type PreviewSecrets = {
  mcpServerToken: string;
  taskStoreToken: string;      // seeded as the task-store admin token; also used by mcp-server and metrics
};
export type PreviewGate = { htpasswdFile: string };   // file holding the htpasswd content
export type PreviewOpts = {
  context: string;             // existing kube context, required
  chartPath: string;           // chart directory to install
  host?: string;               // ingress host; default "preview.localhost"
  gate?: PreviewGate;          // present only in the preview job
  timeout?: string;            // helm --timeout, default "600s"
};
export type PortForward = { name: "admin" | "metrics" | "taskStore" | "chat" | "mcp" | "ingress"; service: string; local: number; remote: number };

export const PREVIEW_DEPLOYMENTS: readonly string[];
export const PORT_FORWARDS: readonly PortForward[];   // locals: admin 13001, metrics 13460, taskStore 13002, chat 13003, mcp 13004, ingress 18080
export function generatePreviewSecrets(randomHex: (bytes: number) => string): PreviewSecrets;
export function buildPreviewCommands(opts: PreviewOpts, secrets: PreviewSecrets): Command[];
export function buildTargetsEnv(secrets: PreviewSecrets): Record<string, string>;
```

`buildTargetsEnv` returns `PREVIEW_ADMIN_URL`, `PREVIEW_METRICS_URL`, `PREVIEW_TASK_STORE_URL`, `PREVIEW_CHAT_URL`, `PREVIEW_MCP_URL` (each `http://127.0.0.1:<local>`), `PREVIEW_TASK_STORE_TOKEN`, `PREVIEW_MCP_TOKEN`.

CLI: `bun run scripts/preview-env.ts --context <ctx> --chart <dir> [--host <h>] [--htpasswd-file <f>] [--env-out <file>]`. It runs the commands, starts the port-forwards in the background, and appends `buildTargetsEnv` to `--env-out` as `KEY=value` lines.

- [ ] **Step 1: Write failing unit tests** in `preview-env.unit.test.ts`:
  - `buildPreviewCommands` never emits a `kind` or `minikube` command.
  - Every `kubectl` argv contains `--context <ctx>` and every `helm` argv contains `--kube-context <ctx>`.
  - Order: all three Secrets are created before `helm install`; the ingress controller's readiness wait is before `helm install`; `helm dependency build` is before `helm install`.
  - With `host: "abc.example"`, the install sets `networking.ingress.host=abc.example` and the admin base URL to `https://abc.example`.
  - Without `gate`, no command mentions `shipwright-preview-gate` and the install sets no auth annotation. (The `gate` branch is added and tested in Task 7.)
  - The last commands wait for every name in `PREVIEW_DEPLOYMENTS`.
  - `generatePreviewSecrets` returns two different values of at least 32 hex characters.
  - No `Command.label` contains either secret value.
- [ ] **Step 2: Run** `bun test scripts/preview-env.unit.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Secrets are created with `kubectl create secret generic --from-file` reading files the driver writes to a temp directory and deletes afterwards, so no secret value appears in an argv. The driver prints labels only.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Add `preview:up`** to `Taskfile.yml`, described as "Install the preview profile onto an existing kube context".
- [ ] **Step 6: Commit:** `feat: add preview environment bring-up script`.

### Task 4: Deployed-target canary suite

**Files:**
- Create: `preview/canary/targets.ts`, `preview/canary/targets.unit.test.ts`
- Create: `preview/canary/admin.canary.test.ts`, `task-store.canary.test.ts`, `metrics.canary.test.ts`, `chat.canary.test.ts`, `mcp-server.canary.test.ts`, `agent-provisioning.canary.test.ts`
- Modify: `Taskfile.yml` (add `preview:canary`)

**Interfaces:**
- Consumes: the env keys from `buildTargetsEnv` (Task 3).
- Produces: `export function readTargets(env: Record<string, string | undefined>): Targets`, where `Targets` has `adminUrl`, `metricsUrl`, `taskStoreUrl`, `chatUrl`, `mcpUrl`, `taskStoreToken`, `mcpToken`.

- [ ] **Step 1: Write failing unit tests** for `readTargets`: returns all seven fields when set; throws an error naming every missing variable when any are absent; rejects a URL that is not `http://127.0.0.1` or `http://localhost` unless `PREVIEW_ALLOW_REMOTE=true` (so the suite cannot be pointed at a real deployment by accident).
- [ ] **Step 2: Run, see FAIL, implement `targets.ts`, run, see PASS.**
- [ ] **Step 3: Write the canary tests.** Take each route and payload from the owning service's route definitions and OpenAPI spec, not from memory. Each test creates what it needs and deletes it in `afterAll`.
  - `admin`: health returns 200; readiness returns 200.
  - `task-store`: with the seeded token, create a task, read it back, update its status, delete it, and confirm a read then returns 404. Without a token, the create returns 401.
  - `metrics`: create a task in the task-store, then poll the metrics API (up to 30 s) until that task is reflected; delete the task.
  - `chat`: health returns 200.
  - `mcp-server`: with the mcp token, one call that lists tasks returns the task created for the test; without the token it is rejected.
  - `agent-provisioning`: create an agent through the admin API using the request shape from finding P4; its Deployment appears; the assertion on pod state follows finding P3 (Ready if P3 says so, otherwise scheduled); delete the agent and confirm the Deployment is gone.
- [ ] **Step 4: Add `preview:canary`** to `Taskfile.yml`, invoking the files in the way finding P7 shows works (explicit paths, or a dedicated bunfig).
- [ ] **Step 5: Verify locally** against a kind cluster: `task preview:up` then `task preview:canary`. Expected: all pass in under 60 s.
- [ ] **Step 6: Commit:** `test: add deployed-target canary suite for the preview environment`.

### Task 5: Composite action and automatic test workflow

**Files:**
- Create: `.github/actions/preview-env/action.yml`
- Create: `.github/workflows/preview-test.yml`
- Create: `preview-env-action.content.test.ts`, `preview-test-workflow.content.test.ts` (repo root)

**Interfaces:**
- Produces, action inputs: `source-path` (directory holding Dockerfiles and the chart to test), `trusted-path` (directory holding `scripts/preview-env.ts`), `host` (optional), `htpasswd-file` (optional). Output: `env-file`, the path written by `--env-out`. Cluster name and context are fixed: `preview` / `kind-preview`.

- [ ] **Step 1: Write failing content tests.**
  - Action: every `uses:` is SHA-pinned; the file contains no `secrets.` reference; every `docker build` uses `inputs.source-path` as context; the bring-up step runs `inputs.trusted-path`'s script; no `--build-arg` or `--secret` is passed to a build.
  - Workflow: triggers on `pull_request` only; top-level `permissions` is `contents: read`; no `secrets.` reference; no `environment:` key; the string `cloudflared` does not appear; concurrency group contains the PR number with `cancel-in-progress: true`; the test job is conditional on a `changes` job output.
- [ ] **Step 2: Run** `bun test preview-env-action.content.test.ts preview-test-workflow.content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the action.** Steps: set up Helm and Bun; add chart repos with `./.github/actions/helm-repos`; create the kind cluster; build the five images with layer caching to the GitHub Actions cache, one cache scope per service; `kind load` each; run the bring-up script.
- [ ] **Step 4: Write the workflow.** A `changes` job modelled on `ci.yml`'s, true when the diff touches `charts/`, `admin/`, `metrics/`, `task-store/`, `mcp-server/`, `agent/`, `preview/`, `scripts/preview-*`, `.github/actions/preview-env/`, either preview workflow, or the platform version pins (root and workspace `package.json`, `bun.lock`), so that the automated platform-release and chart-bump PRs are tested too. A `preview-test` job (30-minute timeout) that checks out the PR, calls the action with both paths set to `.`, runs `helm test`, then `task preview:canary`. On failure it uploads pod status, events and logs as an artifact, excluding Secret objects.
- [ ] **Step 5: Run** the content tests. Expected: PASS. Push the branch and confirm the workflow goes green on its own PR.
- [ ] **Step 6: Commit:** `ci: add preview-env action and automatic preview test workflow`.

### Task 6: Browser specs against the deployment

**Files:**
- Create: `preview/e2e/playwright.config.ts`, `preview/e2e/admin-loads.e2e.ts`, `preview/e2e/agents-page.e2e.ts`, `preview/e2e/metrics-dashboard.e2e.ts`
- Modify: `bunfig.toml` (add `**/preview/e2e/**` to `pathIgnorePatterns`), `Taskfile.yml` (add `preview:e2e`), `.github/workflows/preview-test.yml`

- [ ] **Step 1: Write the config.** `testMatch: "**/*.e2e.ts"`, Chromium only, `baseURL` from `PREVIEW_ADMIN_URL`, and it throws at load if that variable is unset. No `webServer` block.
- [ ] **Step 2: Write the three specs.**
  - `admin-loads`: the admin landing page renders its main navigation with no console errors.
  - `agents-page`: an agent created through the admin API in `beforeAll` appears by name on the agents page; it is deleted in `afterAll`.
  - `metrics-dashboard`: the dashboard at `PREVIEW_METRICS_URL` plus the profile's base path renders its heading.
- [ ] **Step 3: Verify locally** against the kind cluster from Task 4: `task preview:e2e`. Expected: 3 passed.
- [ ] **Step 4: Add the step** to `preview-test.yml` after the canary step, with a Playwright browser install, and extend `preview-test-workflow.content.test.ts` to assert the step exists.
- [ ] **Step 5: Run** `task ci`. Expected: PASS, and `bun test` does not try to execute the `.e2e.ts` files.
- [ ] **Step 6: Commit:** `test: add browser specs for the preview environment`.

### Task 7: Password gate

**Files:**
- Create: `scripts/preview-gate.ts`, `scripts/preview-gate.unit.test.ts`
- Modify: `scripts/preview-env.ts` (wire `gateIngressValues` in when `gate` is set)

**Interfaces:**
- Produces:

```ts
export const GATE_USER = "preview";
export const GATE_SECRET_NAME = "shipwright-preview-gate";
export type SelfCheck = { user: string; password: string };
export type GateCheck = { ok: true } | { ok: false; reason: string };

export function assertUsablePassword(raw: string): string;   // trims one trailing newline; throws on empty or whitespace-only
export function buildHtpasswd(lines: string[]): string;       // "user:hash" lines, newline-terminated, rejects a line without exactly one leading "user:"
export function gateIngressValues(): Record<string, string>;  // helm --set pairs for the basic-auth annotations
export function verifyGate(url: string, selfCheck: SelfCheck, fetchFn: typeof fetch): Promise<GateCheck>;
```

CLI: `bun run scripts/preview-gate.ts hash --out <file>` reads the password from stdin, hashes it in the format finding P5 says the ingress accepts, appends a second line for a freshly generated self-check user, writes the htpasswd content to `<file>` and the self-check credential to `<file>.selfcheck`. `... verify --url <u> --selfcheck <file>` runs `verifyGate` and exits non-zero on failure.

- [ ] **Step 1: Write failing unit tests.**
  - `assertUsablePassword("")` and `("   \n")` throw; `("p:a'ss\"\n")` returns `p:a'ss"`.
  - `buildHtpasswd` output has one line per entry and ends with a newline.
  - `verifyGate` with an injected `fetchFn`: returns `ok: false` when the request with no credentials gets anything other than 401; `ok: false` when wrong credentials get anything other than 401; `ok: false` when the self-check credential does not get 200; `ok: true` only when all three hold.
  - The `hash` command's stdout and stderr contain neither the password nor the self-check password.
  - In `scripts/preview-env.unit.test.ts`: with `gate` set, a `shipwright-preview-gate` Secret is created from the file before `helm install`, and the install carries every pair from `gateIngressValues()`.
- [ ] **Step 2: Run** `bun test scripts/preview-gate.unit.test.ts scripts/preview-env.unit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** If finding P5 says the admin rejects a forwarded `Basic` header, `gateIngressValues` also sets the annotation that strips it.
- [ ] **Step 4: Run** the tests and the Task 3 tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: add basic-auth gate for the preview environment`.

### Task 8: Hold loop and PR comment

**Files:**
- Create: `scripts/preview-hold.ts`, `scripts/preview-hold.unit.test.ts`

**Interfaces:**
- Produces:

```ts
export type StopReason = "window-expired" | "job-deadline" | "label-removed" | "pr-closed" | "new-commit" | "tunnel-died" | "poll-failed";
export type HoldState = {
  nowMs: number; windowEndsMs: number;
  labelPresent: boolean; prOpen: boolean;
  headSha: string; startedSha: string;
  tunnelAlive: boolean; consecutivePollFailures: number;
};
export const JOB_BUDGET_MINUTES = 345;       // stop this long after job start, inside the 6-hour limit
export const MAX_POLL_FAILURES = 3;
export function computeWindowEnd(nowMs: number, requestedMinutes: number, jobStartMs: number): number;
export function decideHold(state: HoldState): { continue: true } | { continue: false; reason: StopReason };
export function buildComment(input: { status: "live" | "expired"; url?: string; sha: string; expiresAtIso?: string; reason?: StopReason }): string;
```

CLI: `bun run scripts/preview-hold.ts --pr <n> --sha <sha> --window-minutes <n> --job-start <epoch-ms> --tunnel-pid <pid>` polls once a minute and exits 0 with the stop reason on stdout.

- [ ] **Step 1: Write failing unit tests**, using an injected clock and an injected PR-state fetcher (no network):
  - `computeWindowEnd` returns `now + 120 min` for a 120-minute request early in the job, and returns `jobStart + 345 min` when the request would run past it.
  - `decideHold` returns the matching reason for each of: time past the window; label absent; PR closed; `headSha !== startedSha`; `tunnelAlive: false`; `consecutivePollFailures === 3`. It continues at two failures.
  - `buildComment` for `live` contains the URL, the username `preview`, the short SHA and the expiry time, and never the word that is the password. For `expired` it contains no URL and names the reason.
- [ ] **Step 2: Run** `bun test scripts/preview-hold.unit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The comment starts with a hidden marker line `<!-- shipwright-preview -->` so the workflow can find and update the same comment.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: add preview hold loop and PR comment builder`.

### Task 9: Preview workflow

**Files:**
- Create: `.github/workflows/preview.yml`
- Create: `preview-workflow.content.test.ts` (repo root)

**Interfaces:**
- Consumes: the action (Task 5), `preview-gate.ts` CLI (Task 7), `preview-hold.ts` CLI (Task 8), `task preview:canary` and `task preview:e2e`.

- [ ] **Step 1: Write the failing content test.** Parse the workflow with `Bun.YAML.parse` and assert:
  - Triggers are exactly `pull_request_target` with `types: [labeled]`, and `workflow_dispatch` with inputs `pr_number` and `window_minutes`.
  - A `request` job runs first with no `environment:`. On a label event it stops unless the label is `preview`; on a manual run it resolves the PR from `pr_number`. In both cases it fails if the PR head repository differs from the base repository.
  - The `preview` job has `needs: request`, `environment: preview`, `timeout-minutes: 355`, and `permissions` of exactly `contents: read` and `pull-requests: write`.
  - `secrets.PREVIEW_PASSWORD` is referenced in exactly one step, and that step comes before the step that checks out the PR head.
  - There are two checkouts: the default branch into `trusted/`, and the PR head SHA into `pr/` with `persist-credentials: false`.
  - Every `uses: ./` value starts with `./trusted/`. No `run:` block executes a file under `pr/` (`bun run pr/`, `bash pr/`, `sh pr/`, `./pr/`, `task -d pr`).
  - `GITHUB_TOKEN` or `github.token` appears only in the steps that create or update the comment and the hold step.
  - The tunnel start step comes before the action step, and the comment step comes after the gate verify step.
  - A cleanup step with `if: always()` stops `cloudflared` before the step that marks the comment expired.
  - `concurrency.group` contains the PR number and `cancel-in-progress` is absent or false.
- [ ] **Step 2: Run** `bun test preview-workflow.content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the workflow**, in the spec's "Preview job order":
  1. `request` job: validate label and fork status; output the PR number and head SHA.
  2. Check out the default branch to `trusted/`.
  3. Preconditions: fail if `PREVIEW_PASSWORD` is empty. If finding P8 says the token can read environment protection rules, fail when `preview` has no required-reviewer rule; otherwise print a warning that points at the docs.
  4. Hash: pipe the secret into `bun run trusted/scripts/preview-gate.ts hash --out "$RUNNER_TEMP/htpasswd"`.
  5. Check out the PR head SHA to `pr/`.
  6. Install `cloudflared` at a pinned version, verify its SHA-256, start `cloudflared tunnel --url http://127.0.0.1:18080` in the background, and read the `trycloudflare.com` hostname from its log (fail after 60 s without one).
  7. Call `./trusted/.github/actions/preview-env` with `source-path: pr`, `trusted-path: trusted`, the hostname and the htpasswd file.
  8. Run `helm test`, `task preview:canary` and `task preview:e2e` from `trusted/`.
  9. `preview-gate.ts verify` against `https://<hostname>`.
  10. Create or update the marker comment with `buildComment({status: "live", ...})`.
  11. Run `preview-hold.ts`.
  12. Cleanup, `if: always()`: kill `cloudflared`, then update the comment to `expired` with the reason.
- [ ] **Step 4: Run** the content test and `task ci`. Expected: PASS.
- [ ] **Step 5: Commit:** `ci: add label-triggered preview workflow`.

Note: `pull_request_target` and `workflow_dispatch` only run once the workflow is on the default branch, so end-to-end verification happens in Task 10 after merge.

### Task 10: Adopter docs and live verification

**Files:**
- Create: `docs/preview-environment.md`
- Modify: `docs/README.md` (index entry), `CLAUDE.md` (one line under Commands for `task preview:*`)

- [ ] **Step 1: Write `docs/preview-environment.md`** with these sections: what it is and is not (copy the spec's non-goals in plain words); the two jobs and how they differ; one-time setup; requesting and ending a preview; how the password is protected; limits; troubleshooting (job fails with "password not configured", tunnel never produced a hostname, stack did not become Ready).
- [ ] **Step 2: One-time setup section must list, as browser steps:** create the `preview` label; create the `preview` environment; add required reviewers; set deployment branches to the default branch only; add the `PREVIEW_PASSWORD` environment secret. State that required reviewers on a private repository need a GitHub plan that includes them, and that without reviewers the approval gate does not exist.
- [ ] **Step 3: Run** `task ci` (covers `check-strings` and docs checks). Expected: PASS.
- [ ] **Step 4: Commit:** `docs: document the preview environment`.

## Human steps

These cannot be done by an agent and are all doable from a browser:

- After Task 9 merges: in the repository settings, create the `preview` label and the `preview` environment with required reviewers, default-branch-only deployment, and the `PREVIEW_PASSWORD` secret.
- Then, on a test PR from a branch in the repository: add the `preview` label, approve the run, open the URL from the PR comment, sign in as `preview`, confirm the admin UI and chat page load, remove the label, and confirm the comment changes to expired and the URL stops answering.
- Add the label to a PR from a fork and confirm no approval request appears.

## Order and dependencies

Task 1 gates everything. Then 2 → 3 → 4 → 5 → 6 form the automatic test job and can ship as one or more PRs with no secrets involved. Tasks 7 and 8 depend only on 3 and can be built in parallel with 4–6. Task 9 needs 5, 7 and 8. Task 10 is last.
