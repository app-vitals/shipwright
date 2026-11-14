# Preview environment: a throwaway Shipwright stack on a PR

Status: approved 2026-11-14. Revised once after an independent builder review.

## Intent

Today a Shipwright change is only ever seen running together, as a whole stack on Kubernetes, after it is released. This design adds a **preview environment**: a GitHub Actions job that brings the whole Shipwright stack up on a throwaway Kubernetes cluster inside the runner, runs a test fleet against it, and, on request, gives a person a password-protected public URL to try the PR in a browser.

It is for pre-release testing only. It is also the first building block for later work (upgrade tests, migration checks, release gates), so the bring-up must be callable by other workflows.

It ships in this public repo as a Shipwright feature. Anyone who runs Shipwright from their own copy can use it with one GitHub Environment and one secret, and nothing in it may depend on a particular cloud account, cluster or private repository.

## Goals

1. One reusable bring-up that installs `charts/shipwright` with every service on a kind cluster inside a GitHub-hosted runner, using images built from the PR's source.
2. A test fleet runs against that live stack on PRs that touch the chart or service code.
3. On request by a maintainer, the same stack is reachable in a browser at a public HTTPS URL for a limited window, behind a shared password, after a human approval.
4. Zero standing infrastructure and zero cost on a public repo.

## Non-goals

- A staging environment, or a target for a promotion tool. The cluster dies with the job.
- Testing any downstream wrapper chart or cloud-specific wiring (managed gateways, cloud secret sync, workload identity, managed databases).
- An agent doing real work. No model credential and no GitHub token go into the environment.
- Previews for PRs from forks.
- Per-person identity on the URL. One shared password is accepted.
- A stable URL. Each preview gets a new random address.
- API access through the public URL. The gate uses the `Authorization` header, so bearer-token APIs cannot be called through it. The public URL is for a browser.
- Running on a VM or an existing cluster. See "Later".

## Anti-goals

These would make the feature a failure even if it works:

- The admin UI reachable from the internet without the password. The preview runs with `auth.mode: open`, where anyone who reaches the service is signed in.
- Any real credential (model key, GitHub token, cloud key) present in the cluster.
- The preview password in plain text anywhere that code from the PR can read it.
- The preview password released to a run that no human approved.
- A tunnel left open after its window, or opened when the gate is not configured.

## Constraints

- **Runner size.** A standard GitHub-hosted Linux runner on a public repo has about 4 vCPU and 16 GB. `scripts/minikube.ts` documents 4 CPU / 6 Gi as the floor for the platform plus one agent, and the agent pod requests 500m / 2Gi. The full stack has not been measured on a runner; measuring it is the first task.
- **Job lifetime.** GitHub ends a job at 6 hours.
- **Fork PRs get no secrets and a read-only token** on `pull_request` runs. The design relies on the first and must live with the second (a fork run cannot comment on the PR).
- **Chart changes need a version bump.** Any change under `charts/shipwright/**`, including a new file in `examples/`, needs a `Chart.yaml` version bump, a chart CHANGELOG entry and the `artifacthub.io/changes` annotation, or `ct lint --check-version-increment` fails. The `render-parity` job also renders every `examples/*.yaml` on refactor PRs.
- **`charts/shipwright/ci/*-values.yaml` is special.** `ct install` in the existing `helm-e2e` job installs the chart once per file there. The preview values file must not live there.
- **Public repo.** No client names, organisation-internal details or credentials in code, docs, logs or PR comments.

## Approaches considered

| | 1. Runner + tunnel | 2. Throwaway VM per PR | 3. Virtual cluster in an existing cluster |
|---|---|---|---|
| How | kind inside the runner; a tunnel gives a public URL; the job stays alive for a window | Workflow creates a cloud VM, installs a small Kubernetes and the chart; deleted when the PR closes | A virtual cluster per PR inside a cluster the adopter already runs |
| URL lifetime | Hours, new address each time | Days, stable | Days, stable |
| Cost | Free on a public repo | Cloud bill per open PR, plus orphan clean-up | Uses existing cluster capacity |
| Adopter needs | One environment and one secret | A cloud account and cloud credentials in CI | A cluster and DNS |
| Main risk | Tight on 4 vCPU; the tunnel service is proprietary | Cloud credentials in a public repo | PR code runs next to production workloads |

**Chosen: approach 1.** It is the only one that works for any adopter with no infrastructure, it costs nothing, and the existing `helm-e2e` job already proves kind plus the chart plus PostgreSQL on a runner. Its limit, accepted by the maintainers, is that a human gets a window of hours, not days. Approach 3 was ruled out because the brief was "no real cluster" and because it puts untested code beside production. Approach 2 stays open as a later target.

## What exists today

- `.github/workflows/helm.yml`, job `helm-e2e`: creates a kind cluster, builds and side-loads only the admin and metrics images, runs `ct install` per `ci/` values file, and runs `helm test`. It triggers on chart paths, `ct.yaml`, the render-parity script, the workflow itself and the `helm-repos` action.
- `scripts/minikube.ts` (`task minikube:up`): brings up admin, metrics, task-store, chat, PostgreSQL and agent provisioning on Minikube. Its header lists the ordering rules that matter. It is a pure command builder plus an injected exec, unit-tested in `scripts/minikube.unit.test.ts`. It does **not** enable mcp-server, so "every service" has no existing precedent.
- `charts/shipwright/examples/values-minikube.yaml`: the fullest local profile.
- Dockerfiles in this repo: `admin`, `metrics`, `task-store`, `mcp-server`, `agent`, `whisper`. The chat image (`ghcr.io/app-vitals/agent-chat`) is built in another repo.
- The chart's ingress routes only admin (`/`), the metrics dashboard and, optionally, the task-store. Chat and mcp-server are ClusterIP-only by design.
- `networking.ingress.annotations` exists, so basic auth on ingress-nginx needs no chart template change.
- The mcp-server Deployment always reads its two tokens from `mcpServer.auth.existingSecret`, and the chart cannot mint a task-store token. The task-store can seed an admin token from `TASK_STORE_SEED_ADMIN_TOKEN` (via `taskStore.extraEnv`).
- The metrics service has read routes only and two data modes: offline fixtures (`METRICS_OFFLINE=true`), or live, reading the task-store and admin APIs.
- Playwright suites (`admin/e2e`, `metrics/e2e`) are both fixture-based: each spec defines its own base URL, starts a `test-server.ts` and mints session cookies with a fixture secret. None of them can be pointed at a deployment.
- `*.smoke.test.ts` files run in-process. There is no suite today that targets a deployed Shipwright.

## Design

### Pieces

1. **Bring-up script**: `scripts/preview-env.ts`, following the `scripts/minikube.ts` pattern (pure builder, injected exec, unit tests). Given a kube context that already exists, it creates the throwaway Secrets the chart needs, installs the ingress controller, runs `helm dependency build`, installs the chart with the preview values, and waits for every workload to be Ready. It does not create the cluster and does not know about GitHub. That separation is what lets a VM or another cluster be the target later.
2. **Preview values**: `charts/shipwright/examples/values-preview.yaml`. Every service enabled (admin, metrics, task-store, chat, mcp-server, agent provisioning, bundled PostgreSQL), locally loaded images with `pullPolicy: Never`, no persistence, `auth.mode: open`, metrics in **live** mode reading the task-store and admin, small resource requests sized from the measurement task.
3. **Composite action**: `.github/actions/preview-env/action.yml`. It creates the kind cluster, builds and loads images, and calls the bring-up script. It is a composite action and not a reusable workflow, because a reusable workflow runs as its own job on its own runner: the cluster would be gone before the caller could use it, and the caller could not declare an environment.
4. **Test workflow**: runs the test fleet against the stack. No tunnel, no secrets.
5. **Preview workflow**: runs the same bring-up, adds the password gate and the tunnel, posts the URL on the PR, and holds the job open.
6. **Deployed-target test suite**: new tests that take service URLs. See "The test fleet".
7. **Adopter docs**: `docs/preview-environment.md`.

### Throwaway secrets

The bring-up script generates random values on every run and creates, before install: the mcp-server auth Secret (its inbound token and its task-store token), the task-store seed admin token, and the token metrics uses to read the task-store. These guard nothing outside the cluster and die with it. The script prints none of them; the test fleet reads them from the cluster.

### Images

- Built from the PR's source and side-loaded with `kind load`: admin, metrics, task-store, mcp-server, agent.
- Pulled from the registry at the version the chart pins: chat and PostgreSQL.
- Whisper is left out; the chart has it off by default.
- Builds use Docker layer caching through the GitHub Actions cache.

If the agent image proves too large or too slow to build on the runner, fall back to the published agent image for the chart's version and record that in the adopter docs as a known gap.

### When the test workflow runs

It triggers on every `pull_request` and uses an internal change detector, as `ci.yml` does with its `changes` job, to decide whether to do the work: changes under `charts/**`, a service directory (`admin/`, `metrics/`, `task-store/`, `mcp-server/`, `agent/`), the bring-up script, the composite action, the two workflows, or the agent-platform version pins (`package.json`, `bun.lock`). The last group matters because a release of the agent platform reaches this repo as an automated version-bump PR, and that PR is where a platform change first meets the rest of the stack. On other PRs it finishes green in seconds. This shape lets it become a required check later; it is **not** required at first, until its flake rate is known.

It runs for fork PRs too, since it needs no secrets. A new push cancels the previous run for that PR.

### When the preview workflow runs

Only when a developer asks for it, from the pull request: someone with triage rights or above adds the `preview` label. No URL and no public access is ever created otherwise. The test workflow above never opens a tunnel.

- **Trigger.** `pull_request_target` on `labeled`, filtered to the `preview` label. This event runs the workflow file from the default branch, not the copy in the PR, so a PR cannot rewrite the steps that handle the password, and the environment can be restricted to the default branch.
- **Trusted code and PR code are kept apart.** `pull_request_target` is dangerous when a privileged job runs PR code carelessly. The rule here: the workflow, the composite action and the scripts that drive the job are taken from the default-branch checkout. The PR head is checked out to a separate path, without credentials, and is used only as the source to build images from and the chart to install. No step executes a script or action from the PR checkout on the runner. The tests that run in the preview job are the default branch's tests.
- **Token scope.** The job's `GITHUB_TOKEN` is limited to reading contents and writing PR comments, and is passed only to the steps that post or update the comment.
- It refuses a PR whose head is in a fork.
- A manual `workflow_dispatch` with a PR number is also offered, from the default branch only, with the same checks.
- One preview per PR at a time (a concurrency group keyed on the PR number and scoped to this workflow, without cancel-in-progress).

### The password gate and approval

Three layers, so that no single mistake exposes the password or the stack:

1. **Approval.** The preview job declares `environment: preview`. The adopter creates that GitHub Environment with required reviewers, restricts its deployment branches to the default branch, and stores one secret in it, `PREVIEW_PASSWORD`. Because the preview workflow always runs from the default branch, the branch restriction means the secret can only be released to the workflow file as merged, never to a modified copy on a branch.
2. **Preconditions, checked before anything else.** The job fails immediately if `PREVIEW_PASSWORD` is empty, or if it can determine that the `preview` environment has no required-reviewer rule. (A job that names a missing environment makes GitHub create it with no protection, so the empty secret is what catches that case.)
3. **The plain-text password never coexists with PR code.** The first step of the job, before the PR is checked out, turns the password into a bcrypt htpasswd entry and keeps only the hash. The secret is passed to that one step and to no other. Everything after it (checkout, image builds, the bring-up script, tests) sees only the hash.

The gate itself is HTTP basic auth enforced at the ingress controller inside the cluster, in front of every route, username `preview`. The tunnel connects to the ingress controller and to nothing else, so no path skips the gate. So that the job can prove the gate works without holding the password, the htpasswd file carries a second entry: a random user and password generated for that run and discarded with it.

### The tunnel and the hostname

- Cloudflare quick tunnel (`cloudflared tunnel --url ...`): no account, free, HTTPS, random `trycloudflare.com` hostname. The client is open source; the service is not. The maintainers accepted that.
- The `cloudflared` binary is pinned to a version and verified by checksum.
- The chart's Ingress matches on host, and `admin.appBaseUrl` is set at install, so the hostname must be known first. **The tunnel starts before the chart is installed**, pointing at the ingress controller's port; the chart is then installed with that hostname as the ingress host and the admin base URL, with the gate annotations already in place. Nothing is ever served through the tunnel ungated.

### Preview job order

1. Check out the default branch (trusted). Check preconditions; hash the password.
2. Check out the PR head to a separate path, without persisting credentials, and record its commit SHA for the PR comment.
3. Create the cluster, build and load images.
4. Start the tunnel and read the hostname.
5. Create the gate Secret from the hash; run the bring-up with the hostname and gate annotations.
6. Run the test fleet over in-cluster port-forwards.
7. Through the public URL, confirm: no credentials gets 401, wrong credentials gets 401, the per-run credential reaches the admin UI.
8. Post the URL on the PR and hold.
9. On any exit: stop the tunnel first, then mark the comment expired.

### The preview window

- One comment on the PR with the URL, the username, the expiry time, and a note that the maintainers hold the password. The same comment is updated when the preview ends.
- Default window: 120 minutes, settable by a workflow input. The hold is capped by elapsed job time, not by a fixed number: the job stops the preview with a safe margin before the 6-hour limit however long the build took.
- The preview ends early when the `preview` label is removed, the PR is closed, a new commit is pushed to it, or a maintainer cancels the run. The hold loop polls for the first three. A new commit never updates a live preview; the label has to be removed and added again, which needs a fresh approval.

### The test fleet

The fleet reaches each service through its own `kubectl port-forward`, not through the ingress. Chat and mcp-server have no ingress route, and the gate would block bearer-token calls anyway. The suite therefore takes one URL per service from the environment, plus the throwaway tokens.

Run in this order by the test workflow, and by the preview workflow before the URL is posted:

1. **Workloads Ready.** Every Deployment available, database migrations completed.
2. **`helm test`.** The chart's existing test hooks.
3. **Deployed-target suite (new, Bun tests).**
   - Admin: health and readiness.
   - Task-store: create, read, update, delete round trip with the seeded token.
   - Metrics, live mode: create a task in the task-store and see it reflected in the metrics API. This replaces "ingest an event", which the metrics service does not have.
   - Chat: health.
   - Mcp-server: a call that reaches the task-store through it.
   - Agent provisioning: create an agent through the admin API, see its workload appear, then delete it.
   - Every test cleans up after itself.
4. **Browser specs against the deployment (new, Playwright).** A separate Playwright config whose base URL comes from the environment. At minimum: the admin UI loads, the agents page lists an agent created through the API, the metrics dashboard renders. The existing fixture-based suites are left exactly as they are.

On any failure, pod status, events and logs are uploaded as a workflow artifact. The collection step skips Secret objects.

### Relationship to `helm-e2e`

`helm-e2e` stays as it is. It answers "does the chart install under each values variant"; the preview environment answers "does the whole stack work together".

## Decisions made by the maintainers

- No URL or public access is created unless a developer specifically asks for it, and they ask from the pull request. The test fleet still runs on its own.

- Approach 1: kind inside the runner, plus a tunnel.
- Ships in this repo as an open-source feature.
- No real agent work; pre-release testing only.
- Public URL protected by one shared password.
- The password lives in a GitHub Environment with required approval, because bots and apps with push access could otherwise read a plain repo secret.
- The fleet covers the smoke, browser and deployed-target (canary-style) layers.

## Calls made in this document (not yet confirmed)

- The request is a `preview` label, handled by `pull_request_target` with trusted code kept apart from PR code. A plain `pull_request` label trigger was rejected because it runs the PR's own copy of the workflow.
- The preview job runs the default branch's test fleet, not the PR's, as a consequence of that separation. The PR's own version of the tests is exercised by the test workflow.
- The public URL is browser-only; APIs are tested inside the runner, not through the gate.
- Metrics runs in live mode, and its test is "a task shows up in metrics".
- The test workflow always triggers and self-skips by changed paths; it is not a required check at first.
- Fork PRs get tests only and no explanatory comment (a fork run cannot comment).
- A 120-minute default window, capped by elapsed job time; early end on label removal, close, push or cancel.
- Fail closed when the password is missing or the environment has no reviewers.
- Cloudflare quick tunnel.
- Basic auth at the ingress, username `preview`, plus a per-run self-check credential.
- All deployed browser specs are new; existing Playwright suites are untouched.
- An agent is provisioned with no credentials so provisioning is covered.
- Chat is pulled as a published image; whisper is left out.
- A composite action, with the bring-up as a script that takes an existing kube context.
- `helm-e2e` is left unchanged.

## Left to the builder

- Which ingress controller carries the gate: ingress-nginx with basic-auth annotations (the Minikube path uses it, and it needs no chart change) or Traefik with a basic-auth Middleware.
- How far the agent provisioning test can go. Step 1 of the work finds out whether an agent pod reaches Ready with no model credential. If it does, assert Ready. If it crash-loops, assert that the workload is created and the pod is scheduled, and say so in the docs.
- How the deployed suite authenticates to the admin API under `auth.mode: open`, and whether the admin tolerates the forwarded `Basic` header behind the gate. Both live in the external admin package; step 1 checks them. If the admin rejects the header, strip it at the ingress.
- How the job checks the environment's reviewer rule, and what it does if the token cannot read it (fall back to the empty-secret check and a clear docs warning).
- Exact resource requests in the preview values, from the measurement.
- Layer-cache layout and whether image builds run in parallel.
- File layout and task names for the deployed suite and browser specs.

## Order of work

1. **Measure and probe.** Bring the full stack up on a standard runner with a rough workflow. Record time and peak memory, whether an agent reaches Ready without a credential, how the admin API authenticates in open mode, and whether a quick tunnel serves the admin UI correctly. If the stack does not fit, stop and come back with numbers before building anything else.
2. Bring-up script, throwaway secrets, preview values (with the chart version bump), composite action.
3. Deployed-target suite and the test workflow.
4. Browser specs against the deployment.
5. Password gate, tunnel, hold loop, PR comment, preview workflow.
6. Adopter docs, including: create the environment, add reviewers, restrict it to the default branch, add the secret; and the note that required reviewers on a private repository need a paid GitHub plan that includes them.

## Risks

- **It may not fit on 4 vCPU.** Step 1 measures first. Fallbacks, in order: trim resource requests, pull the agent image instead of building it, drop the provisioned agent from the default run.
- **Run time.** Five image builds on a cold cache could be slow enough that people stop waiting. Mitigation: layer caching and the change detector. Target for a warm run: stack Ready inside 10 minutes.
- **Flakiness.** A job this close to the runner's limits will sometimes fail for reasons unrelated to the PR, which is why it is not a required check at first.
- **Quick tunnels carry no uptime promise** and have request limits. Acceptable for a rare, short, human-only preview. If one fails to start, the job fails and says so.
- **A preview ties up one runner for its window.** Acceptable because previews are rare and approval-gated.
- **Shared password.** Removing a person means rotating the secret.
- **`pull_request_target` is easy to get wrong.** One step that runs a script from the PR checkout would hand PR code a privileged job. Mitigation: the separation rule above, a unit or content test that fails if the preview workflow references the PR checkout path in a `run` or `uses` step, and the password being hashed before the PR is checked out, so even a mistake does not expose it in plain text.
- **The approval gate depends on the adopter's settings.** The workflow cannot create the protection; it can only refuse to run without it.

## Later

- A VM or existing-cluster target for a longer-lived preview, reusing the bring-up script.
- Upgrade tests: install the last released chart, then upgrade to the PR's.
- An opt-in mode with a named tunnel on the adopter's own domain and real sign-in.
