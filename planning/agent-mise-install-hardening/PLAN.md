# Plan Session: agent-mise-install-hardening

## Background

On 2026-09-28, all 6 Shipwright agent pods in the `vitals-os` GKE namespace were
`CrashLoopBackOff` on `Executable not found in $PATH: "mise"`.

Root cause: `agent/Dockerfile` (line 109) installs mise via
`RUN curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh`. Docker's
default `/bin/sh` (dash, in `oven/bun:1-slim`) has no `pipefail`, so a transient
`curl` failure (confirmed: `OpenSSL SSL_read: ...unexpected eof while reading`,
in shipwright `build-agent.yml` run 36463918262, which produced base tag
`agent-v1.320.0`) doesn't propagate — `sh` receives 0 bytes on stdin, runs
nothing, and exits 0. The Docker layer reports `DONE`/success and the image
ships with `/usr/local/bin/mise` silently missing. Verified directly: pulling
`ghcr.io/app-vitals/shipwright-agent:agent-v1.320.0` shows no
`/usr/local/bin/mise`; `agent-v1.300.0` and `agent-v1.321.0` both have it.

At runtime, `agent/src/setup.ts`'s `runMiseStartup()` calls
`execFn("mise", ["trust", ...])` with no try/catch around the spawn itself —
only the later `mise install` exit code is checked. A missing binary throws an
uncaught rejection that kills the whole entrypoint (plugin install and agent
server spawn never run), contradicting the function's own doc comment
("Non-fatal: mise failures are logged but do not abort startup").

The broken base tag (`agent-v1.320.0`) flowed automatically into
`vitals-os-agent:vitals-agent-v0.63.35` via the existing poll-driven chain
(`growth/src/shipwright-release-poller.ts` → `update-agent-base-tag.yml` →
`build-vitals-agent.yml` → `shipwright-agent-image-released` dispatch →
`bump-vitals-agent.yml`), which auto-merges without ever booting the image.
The Shipwright admin's reconcile loop
(`admin/src/agent-provisioner.ts:475-509`) then patched all 6 agent
Deployments to the new tag with no post-patch health check and no
"last known good" fallback. The outage ended only because the *next* base
build (`agent-v1.321.0`) happened not to hit the same transient TLS failure,
and the identical no-verification auto-merge chain shipped that fix too —
pure luck, not a designed recovery.

**Broadening check:** grepped every Dockerfile in the shipwright repo — this
`curl | sh` pattern exists nowhere else. `chat/Dockerfile`, `admin/Dockerfile`,
and `task-store/Dockerfile` explicitly don't install mise at all. No other
Dockerfile-level fix is needed beyond this one line.

**Scope note:** a more general rollback-safety-net (health-check-gated
reconcile + auto-revert to last-known-good image) is a materially larger,
separate problem — deploy safety infrastructure, not this specific silent-
build-failure bug — and is being planned in its own session rather than
bundled here.

## Design

1. **`agent/Dockerfile`** — download the mise installer to a file first so
   curl's own exit code gates the `RUN` step, plus an explicit post-install
   existence check:
   ```dockerfile
   RUN curl -fsSL -o /tmp/mise-install.sh https://mise.run \
       && MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/mise-install.sh \
       && rm /tmp/mise-install.sh \
       && test -x /usr/local/bin/mise
   ```
   No retry/backoff — a loud build-time failure is the desired outcome for a
   transient error, not something to paper over.

2. **`agent/src/setup.ts`'s `runMiseStartup`** — wrap the `mise trust` and
   `mise install` execFn calls so a thrown exec error (missing binary, spawn
   failure) is caught, logged via `console.warn`, and treated the same way a
   non-zero `install` exit code already is: skip the PATH prepend and return,
   without aborting the rest of entrypoint (plugin install, server spawn).
   This is defense-in-depth independent of fix #1.

3. **`build-agent.yml` (shipwright repo)** — add a post-build, pre-push smoke
   step that boots the built image and verifies `mise`, `claude`, `gh`,
   `node`, and `bun` all resolve on PATH via `command -v` (not by executing
   them — `claude --version` was observed to hang without network/auth in
   this sandboxed check). Catches this whole class of silent-build-failure
   at the base-image layer.

4. **`bump-vitals-agent.yml` (vitals-os repo)** — gate auto-merge on the same
   kind of boot-smoke-check, run against the actual final wrapper image
   (`vitals-os-agent:$VITALS_AGENT_TAG`) that's about to be pinned into prod —
   this is option (a) from the incident follow-up discussion: a cheap,
   high-leverage backstop that stops a broken tag from ever reaching the
   auto-merge/reconcile chain, independent of whether fixes #1–#3 land first.
   Requires adding GCP Workload Identity auth (`id-token: write` +
   `google-github-actions/auth`, mirroring `build-vitals-agent.yml`'s
   existing step — `WIF_PROVIDER`/`GCP_SA_EMAIL` are already used in that
   workflow in this repo, so this is not a net-new secret) since
   `bump-vitals-agent.yml` currently has no registry auth at all.

No renames or removals anywhere in this plan — all four tasks are
`Safe to deploy standalone: yes`.

## Tasks

| Task | Title | Repo | Files | Layer | Hours | Complexity | Model | HITL |
|---|---|---|---|---|---|---|---|---|
| MSE-1.1 | Fail mise install build step on transient curl error | app-vitals/shipwright | `agent/Dockerfile` | Shared | 1h | 1 | haiku | |
| MSE-1.2 | Make mise trust/install failures non-fatal at runtime | app-vitals/shipwright | `agent/src/setup.ts`, `agent/src/setup.integration.test.ts` | Shared | 2h | 2 | haiku | |
| MSE-1.3 | Add CI smoke check that built base image contains mise/claude/gh | app-vitals/shipwright | `.github/workflows/build-agent.yml` | Shared | 1h | 1 | haiku | |
| MSE-1.4 | Gate vitals-agent tag-bump auto-merge on an image boot-smoke-check | app-vitals/vitals-os | `.github/workflows/bump-vitals-agent.yml` | Shared | 2h | 3 | sonnet | |

No dependencies between any of the four — independent files, independent
repos, no ordering constraints.

```
[START]
  ├─ MSE-1.1: Fail mise install build step on transient curl error (no deps)
  ├─ MSE-1.2: Make mise trust/install failures non-fatal at runtime (no deps)
  ├─ MSE-1.3: Add CI smoke check that built base image contains mise/claude/gh (no deps)
  └─ MSE-1.4: Gate vitals-agent tag-bump auto-merge on an image boot-smoke-check (no deps)
```

### Acceptance criteria

**MSE-1.1**
- `RUN` step rewritten to `curl -fsSL -o /tmp/mise-install.sh ... && MISE_INSTALL_PATH=... sh ... && rm ... && test -x /usr/local/bin/mise`.
- Manually verified: `docker build -f agent/Dockerfile .` still succeeds end-to-end locally.
- Manually verified: pointing `MISE_INSTALL_PATH` at an unwritable location causes the `RUN` step to fail loudly (simulates "installer ran but binary didn't land").
- Test decision: no new automated test — this repo's suite doesn't build Docker images; acceptance is the explicit `test -x` check plus the CI smoke check added in MSE-1.3.

**MSE-1.2**
- `runMiseStartup`'s `mise trust` and `mise install` execFn calls are both wrapped so a thrown exec error is caught, logged via `console.warn`, and the function returns early (skipping the PATH prepend) without throwing.
- Test decision: add integration test(s) to `agent/src/setup.integration.test.ts`'s existing `describe("runMiseStartup", ...)` block (mirrors its existing injected-`mockExec` pattern) — a `mockExec` that rejects for the `trust` call must not make `runMiseStartup` throw; assert it resolves and a warning was logged. No existing tests are retired — this is additive coverage of a path (`mise trust` throwing) with zero current coverage.

**MSE-1.3**
- New step in `build-agent.yml`, after `docker build` and before `docker push`, runs `docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'for b in mise claude gh node bun; do command -v "$b" >/dev/null || { echo "missing: $b"; exit 1; }; done'`.
- Step failure fails the job before `docker push` runs — a broken image is never pushed to GHCR.
- Test decision: no unit test (GH Actions YAML); acceptance is `workflow_dispatch` on a feature branch confirming the step both passes against a known-good build and fails against a deliberately-broken one, per this repo's own stated convention for validating workflow changes before merging to main.

**MSE-1.4**
- Before either auto-merge path (existing-PR or newly-created-PR) in `bump-vitals-agent.yml`, pull `us-west1-docker.pkg.dev/vitals-os-prod/vitals-os/vitals-os-agent:$VITALS_AGENT_TAG` and run the same `command -v` boot-smoke-check as MSE-1.3, against the final wrapper image this time.
- Add `id-token: write` to the workflow's `permissions:` block and a `google-github-actions/auth` step mirroring `build-vitals-agent.yml`'s existing one, so the workflow can authenticate to pull from the private Artifact Registry.
- On smoke-check failure: the workflow step fails non-zero, and neither the "PR already open" nor "newly-created PR" branch calls `gh pr merge --auto` — the broken tag never gets auto-merged, and whatever tag is currently deployed stays pinned.
- Test decision: no unit test (GH Actions YAML); acceptance is `workflow_dispatch` against both a known-good tag and a deliberately-broken tag (e.g. an image missing one of the checked binaries), confirming pass/fail behavior both ways, before merging to main.

## Decision Log

- Retry/backoff for the mise curl install: rejected. A loud build-time failure
  is the correct behavior for a transient network error — retrying risks
  reintroducing a different silent-failure shape (e.g. succeeding on attempt 2
  but masking a real, persistent problem on attempt 1's logs).
- MSE-1.3's smoke check scope: widened from mise-only to
  {mise, claude, gh, node, bun} since the step already boots the image —
  cheap to make it a general base-image-sanity gate rather than single-tool.
- MSE-1.3 check method: `command -v` (PATH resolution only), not executing the
  binaries — `claude --version` was observed to hang (~2min, no network/auth)
  during this investigation's own manual image inspection; executing it in CI
  risks a hung job, not just a wrong-but-fast result.
- Rollback safety net (health-check-gated reconcile + auto-revert to
  last-known-good in `admin/src/agent-provisioner.ts`) explicitly excluded
  from this session's scope — planned separately as its own session, since it
  is deploy-safety infrastructure rather than a fix for this specific bug.
