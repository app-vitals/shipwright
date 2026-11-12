# Plan: platform candidate image must boot a coding agent

Session: `platform-candidate-coding-boot`
Repos: `app-vitals/shipwright` (PCB-2.x, PCB-3.1), `app-vitals/agent` (PCB-1.1)
Originated from: the AGR-5.1 checkpoint (verify a derived image on the platform candidate).

## Problem

The platform-based candidate (`agent/Dockerfile.platform`, AGR-4.3a, published as
`ghcr.io/app-vitals/shipwright-agent:platform-candidate-e9c17c7b77fb`) crash-loops when a
derived image built FROM it runs a coding agent:

```
Missing workspace template: /app/runtime/workspace/CLAUDE.md.template
  at readTemplate (/app/runtime/setup.ts)  <- ensureAgentHome <- startAgent (boot.ts)
```

Exploration found two independent defects and one coverage gap:

1. **Missing coding templates.** The platform's `runtime/workspace/` has the platform
   templates but not `CLAUDE.md.template` or `CLAUDE-HITL.md.template`. Every template the
   two directories share is byte-identical, so these two are the only coding-owned files.
   `Dockerfile.platform` copies `specialties/` (manifests) but not these templates. For the
   default `coding` type `resolveTemplatesDir` returns the built-in directory directly, so
   no environment variable can supply them.
2. **Wrong repo root (latent, hidden behind 1).** `SHIPWRIGHT_REPO_ROOT` in `setup.ts` is
   `import.meta.dir/../../..`. In the old layout (`/app/agent/src/runtime`) that is `/app`;
   in the platform layout (`/app/runtime`) it is `/`. `installPlugins()` then runs
   `claude plugin marketplace add /`, which fails (`marketplace add exited 1` in the boot
   log; a healthy current-image pod does not log it), so the built-in `shipwright`
   marketplace never registers and `shipwright@shipwright` cannot install. Neither
   `boot.ts`, `entrypoint.ts` nor the extension interface can supply the root.
3. **Coverage gap.** `base-image-contract.smoke.test.ts` only registers a fixture marketplace
   and checks the entrypoint runs. It never calls `ensureAgentHome` with the default type
   and never registers the built-in marketplace, so the `agent platform docker build` job
   was green.

## Design

Ownership split: the platform owns platform files; Shipwright owns coding files.

- **Platform runtime (`app-vitals/agent`)** — `setup.ts` reads `SHIPWRIGHT_REPO_ROOT` from
  the environment and falls back to today's computation. Default behavior is unchanged.
  Shipped through the platform's semantic-release flow.
- **`agent/Dockerfile.platform`** — copy only the coding-owned templates
  (`CLAUDE.md.template`, `CLAUDE-HITL.md.template`) from `agent/workspace/` into
  `/app/runtime/workspace/`; set `ENV SHIPWRIGHT_REPO_ROOT=/app`; bump `PLATFORM_VERSION`
  and the `@app-vitals/agent-lib` pin in `agent/package.json` together to the release that
  contains the platform change. Nothing ships from this file today (`build-agent.yml` builds
  `agent/Dockerfile`), so the change is safe to deploy standalone.
- **CI** — a new image-level smoke test runs real code inside `shipwright-agent:ci-platform`
  (uid 1000, temp HOME): `ensureAgentHome` with the default type seeds `CLAUDE.md`, and the
  built-in marketplace registers and `shipwright@shipwright` installs. Wired into the
  `agent-platform-docker-build` job. Run once against the broken candidate to prove it fails.
- **Republish and re-verify** — a human republishes the candidate from main and AGR-5.1 is
  re-run against it.

Alternatives rejected:
- Symlinking `/.claude-plugin` and `/plugins` at the filesystem root so `/` resolves as a
  marketplace root: stays inside Shipwright but is hacky and fragile.
- Copying all of `agent/workspace/` over the platform's: would make Shipwright overwrite
  platform-owned files. A cleaner long-term end state (coding templates resolved through the
  coding manifest's `identity.templatesDir`) needs a platform change and is out of scope.

## Breaking change scan

Additions only: an optional env var whose default is unchanged, two new `COPY` lines, one new
`ENV`, a new CI test. `Dockerfile.platform` is candidate-only. The `PLATFORM_VERSION` bump
crosses 0.5.0 -> the new release, which brings other platform changes; PCB-2.1 requires the
full ci-platform checks to pass. Release-pipeline consumers (candidate publish workflow,
downstream derived-image builds) pin the candidate by tag and are unaffected until a new
candidate is published and deliberately adopted.

## Tasks

| Task | Repo | Title | Depends on | Layer | Hrs | Cx / model | HITL |
|---|---|---|---|---|---|---|---|
| PCB-1.1 | app-vitals/agent | fix: honor SHIPWRIGHT_REPO_ROOT in setup.ts | — | Shared | 2 | 2 / haiku | |
| PCB-2.1 | app-vitals/shipwright | fix: platform image ships coding templates, sets repo root, bumps platform version | PCB-1.1 | Shared | 3 | 3 / sonnet | |
| PCB-2.2 | app-vitals/shipwright | test: smoke-test a real coding boot of the platform candidate in CI | PCB-2.1 | Shared | 3 | 3 / sonnet | |
| PCB-3.1 | app-vitals/shipwright | chore: republish the platform candidate from main | PCB-2.1, PCB-2.2 | Shared | 1 | 1 / haiku | HITL |

```
[START] PCB-1.1 (agent repo)
  └─ PCB-2.1 (needs the released platform version)
        └─ PCB-2.2 (smoke test needs the fixed image)
              └─ PCB-3.1 HITL republish -> AGR-5.1 re-run
```

## Follow-on

AGR-5.1 gains `PCB-3.1` as a dependency and a note linking these findings; it stays pending
and HITL. Its remaining acceptance work (boot on a real agent, `gh` wrapper under App auth
in the agent run) happens on the republished candidate. The specialist half of AGR-5.1 is
waived by the owner (specialists are still experimental). The cgroup delegation probe
(PLD-1.2) is already recorded as procfs fallback in CI, in a local container run and in a
production pod.

## Decision Log

- Repo-root fix location: platform env override — no extension hook exists and the symlink
  alternative is fragile (owner-approved).
- Template split: Shipwright copies only coding-owned templates — platform owns platform
  files (owner-approved).
- AGR-5.1: add PCB-3.1 as a dependency and a findings note (owner-approved).
