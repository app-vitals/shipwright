# Agent Type authoring guide

> The public-facing spec for authoring **Agent Type manifests** — the `shipwright.dev/v1alpha1` / `AgentType` YAML documents that declare an agent type's identity, crons, plugins, tools, env contract, membership, repos, and chat/voice toggles.

This guide is written against the settled schema (`admin/src/agent-type-registry.ts`'s `AgentTypeManifestSchema`, ATS-1.1) and the worked coding-agent example (`agent-types/coding/manifest.yaml`, ATS-2.1). If this doc and the schema ever disagree, the schema wins — regenerate `docs/schemas/agent-type.schema.json` (see [Generated JSON Schema](#generated-json-schema) below) and update this doc to match.

## Concept

An Agent Type is **one shared image, config-only specialization.** Every agent — regardless of type — runs the same `agent/` container image and the same admin-managed runtime. What makes a "coding agent" different from a future "support agent" or "research agent" is entirely expressed in a manifest: which crons it runs, which plugins and tools it's granted, what env contract it declares, and whether chat/voice are enabled. There is no per-type forked binary and no per-type Dockerfile — an Agent Type is pure declarative config layered onto one runtime.

This has a direct consequence for authoring: a manifest is a **declaration of intent and contract**, not a bundle of executable code or secret material. It says *what* an agent type needs (tools, env keys, scheduled prompts) — the runtime is responsible for actually granting/injecting those things, and does so under rules that manifests cannot override (see [Rules](#rules)).

Manifests are also a **trust boundary**: they may originate from third-party contributors, so the schema is `.strict()` everywhere (unknown keys are rejected outright, not silently dropped) and env entries are deliberately keys-only.

## Field reference

Types below use the same shorthand as [`docs/configuration.md`](./configuration.md): `string`, `boolean`, `string[]`, or a nested object name. `Default` is `—` when the field is required (no default applies).

### Top level

| Name | Type | Default | Description |
|---|---|---|---|
| `apiVersion` | `string` (literal) | — | Must be exactly `shipwright.dev/v1alpha1`. |
| `kind` | `string` (literal) | — | Must be exactly `AgentType`. |
| `metadata` | object ([Metadata](#metadata)) | — | Identity/catalog info: name, display name, description, version, skills. |
| `identity` | object ([Identity](#identity)) | — | Where this type's workspace templates live. |
| `crons` | array ([Cron entry](#crons)) | — | Scheduled prompts this type ships. Can be an empty array. |
| `plugins` | `string[]` | — | Claude Code plugin package names installed for this type (e.g. `shipwright`). |
| `tools` | `string[]` | — | Additional tool names granted on top of the floor set — see [FLOOR_TOOLS](#floor_tools-are-outside-manifest-authority). |
| `env` | object ([Env contract](#env-contract)) | — | Required/optional env var keys this type declares — keys only, never values. |
| `members` | `string[]` | — | Default member emails/identifiers for agents of this type. Can be an empty array. |
| `repos` | `string[]` | — | Default `org/repo`-formatted repos for agents of this type. Can be an empty array. |
| `chat` | `boolean` | — | Whether agents of this type expose the chat surface. |
| `voice` | `boolean` | — | Whether agents of this type expose the voice surface. |
| `resources` | object ([Resources](#resources-optional)) | *(unset — runtime default applies)* | Optional override of the default agent container CPU/memory/ephemeral-storage requests and limits. |

A top-level `.superRefine()` check also applies: every `crons[].parentCron` must reference another cron's `name` **within the same manifest** — it cannot reference itself and cannot reference a name that doesn't exist in `crons[]`.

### Metadata

`metadata` fields:

| Name | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | — | RFC1123 label (`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`) — lowercase alphanumeric and hyphens, no leading/trailing hyphen. This is the type's unique id (e.g. `coding`). |
| `displayName` | `string` | — | Human-readable name shown in UIs (e.g. `Coding Agent`). Min length 1. |
| `description` | `string` | — | Prose description of what this agent type does. Min length 1. |
| `version` | `string` | — | Free-form version string for this manifest (e.g. `1.0.0`). Min length 1. |
| `skills` | array ([Skill entry](#metadataskills)) | — | A2A-aligned capability catalog for this type. Can be an empty array. |

#### `metadata.skills[]`

| Name | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | — | Stable skill identifier (e.g. `dev-task`). Min length 1. |
| `name` | `string` | — | Human-readable skill name (e.g. `Develop Task`). Min length 1. |
| `description` | `string` | — | Prose description of what the skill does. Min length 1. |
| `tags` | `string[]` | *(none)* | Optional free-form tags (e.g. `maintenance`, `scheduled`). |

### Identity

`identity` fields:

| Name | Type | Default | Description |
|---|---|---|---|
| `templatesDir` | `string` | — | Path to this type's workspace template directory (e.g. `agent/workspace/`). Min length 1. |

### `crons[]`

Each entry in the top-level `crons` array:

| Name | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | — | Unique cron name within this manifest (e.g. `shipwright-dev-task`). Min length 1. |
| `schedule` | `string` | — | Cron expression (e.g. `"* * * * *"`, `"0 6 * * *"`). Min length 1. |
| `prompt` | `string` | — | The prompt/command dispatched on schedule (e.g. `/shipwright:dev-task`). Min length 1. |
| `preCheck` | `string` | *(none)* | Optional script reference gating whether the cron fires this tick (e.g. `shipwright:check-test-readiness.ts`). |
| `silent` | `boolean` | `false` | Whether a no-op tick should skip posting (`[silent]` convention). |
| `enabled` | `boolean` | `true` | Whether the cron is active. See [crons ship disabled](#new-crons-in-published-types-ship-enabled-false) for the publishing rule. |
| `parentCron` | `string` | *(none)* | Name of another cron in this manifest that dispatches this one as a phase (e.g. `shipwright-loop`). Must reference an existing sibling cron name, not itself. |

### Env contract

`env` fields:

| Name | Type | Default | Description |
|---|---|---|---|
| `required` | array ([Env entry](#envrequired--envoptional)) | — | Env vars an agent of this type cannot function without. |
| `optional` | array ([Env entry](#envrequired--envoptional)) | — | Env vars that unlock optional functionality (e.g. voice, Slack) when present. |

#### `env.required[]` / `env.optional[]`

| Name | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | — | The env var name (e.g. `CLAUDE_CODE_OAUTH_TOKEN`). Min length 1. |
| `description` | `string` | — | Prose explaining what the var is for. Min length 1. |
| `secret` | `boolean` | — | Whether this key's value should be treated as sensitive (encrypted at rest, redacted in logs/UI) when actually configured on a real agent instance. |

This is deliberately **keys-only** — see [manifests never contain secret values](#manifests-never-contain-secret-values) below. There is no `value` or `default` field on an env entry; the schema is `.strict()` and rejects one if present.

### Resources (optional)

`resources` is the only optional top-level field. When present:

| Name | Type | Default | Description |
|---|---|---|---|
| `requests` | object ([Resource list](#resourcesrequests--resourceslimits)) | *(unset)* | Overrides the default container resource *requests*. |
| `limits` | object ([Resource list](#resourcesrequests--resourceslimits)) | *(unset)* | Overrides the default container resource *limits*. |

#### `resources.requests` / `resources.limits`

| Name | Type | Default | Description |
|---|---|---|---|
| `cpu` | `string` | *(unset)* | CPU quantity (Kubernetes resource string, e.g. `"500m"`). |
| `memory` | `string` | *(unset)* | Memory quantity (e.g. `"1Gi"`). |
| `ephemeral-storage` | `string` | *(unset)* | Ephemeral storage quantity (e.g. `"2Gi"`). |

All three fields are optional and independent — a manifest may override just one.

## Blank template

Copy-paste this as a starting point. It's the minimal valid manifest — every required field present with placeholder values, every optional section omitted. It validates against `AgentTypeManifestSchema` as-is.

```yaml
apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: my-agent-type
  displayName: My Agent Type
  description: One-sentence description of what this agent type does.
  version: 0.1.0
  skills: []
identity:
  templatesDir: agent/workspace/
crons: []
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: false
voice: false
```

To add `resources`, append a top-level `resources:` key with `requests:`/`limits:` sub-objects as shown in the [Resources](#resources-optional) reference above — omit it entirely (as this template does) to use the runtime default.

## Worked examples

Each surface below is pulled directly from the live coding-agent manifest, [`agent-types/coding/manifest.yaml`](../agent-types/coding/manifest.yaml) — the reference type shipped with Shipwright itself. Use it as a second, fuller reference alongside the blank template.

### Crons

A pipeline-phase cron dispatched by a parent orchestrator cron, plus a standalone maintenance cron:

```yaml
crons:
  - name: shipwright-dev-task
    schedule: "* * * * *"
    prompt: /shipwright:dev-task
    silent: true
    enabled: true
    parentCron: shipwright-loop
  - name: shipwright-docs-freshness
    schedule: "0 7 * * *"
    prompt: /shipwright:research-docs --auto
    preCheck: shipwright:check-docs-freshness.ts
    silent: true
    enabled: false
```

`shipwright-dev-task` is a phase dispatched by `shipwright-loop` (its `parentCron`), so it doesn't need its own `preCheck` — the orchestrator handles candidate selection. `shipwright-docs-freshness` is a standalone scheduled scan with a `preCheck` gate and ships `enabled: false` (see [crons ship disabled](#new-crons-in-published-types-ship-enabled-false)).

### Env contract

One required secret, one optional secret, one optional non-secret:

```yaml
env:
  required:
    - key: CLAUDE_CODE_OAUTH_TOKEN
      description: >-
        Claude Code OAuth token used to authenticate the agent's Claude
        sessions (alternative to ANTHROPIC_API_KEY).
      secret: true
  optional:
    - key: GH_TOKEN
      description: >-
        GitHub Personal Access Token, used as a fallback for GitHub API
        access when GitHub App credentials are not configured.
      secret: true
    - key: PIPER_VOICE
      description: >-
        Piper voice name to use for local (offline) speech synthesis when
        no cloud voice provider is configured.
      secret: false
```

Note there is no `value:` anywhere — see [manifests never contain secret values](#manifests-never-contain-secret-values).

### Plugins

```yaml
plugins:
  - shipwright
```

A list of Claude Code plugin package names to install for agents of this type. The coding type installs exactly the `shipwright` plugin itself.

### Members

```yaml
members: []
```

Default member list for agents provisioned from this type — usually empty (`[]`) in the manifest itself, with actual members added per-agent-instance after provisioning via the admin API (`AgentMember` rows), not baked into the shared type manifest.

### Tools

```yaml
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebSearch
  - WebFetch
  - Skill
  - Agent
```

This list is **additive on top of the floor set** — see [FLOOR_TOOLS are outside manifest authority](#floor_tools-are-outside-manifest-authority). Listing `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Skill` here is harmless (they're already floor-granted) but redundant; the fields that actually matter to declare are the high-privilege ones — `Bash`, `WebSearch`, `WebFetch`, `Agent` — since those are never floor-granted.

### Repos

```yaml
repos: []
```

Default `org/repo`-formatted repos for agents of this type — like `members`, usually empty in the shared type manifest, with real repos assigned per-agent-instance after provisioning.

## Rules

### FLOOR_TOOLS are outside manifest authority

The agent runtime always grants a fixed set of 7 **floor tools** — `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Skill`, `TodoWrite` (the `FLOOR_TOOLS` constant in `agent/src/claude.ts`) — regardless of what a manifest's `tools[]` array says. This is an architectural invariant, not a manifest option: floor tools are non-revocable, cannot be removed by omitting them from `tools[]`, and are not derived from manifest content at all.

A manifest's `tools[]` field is purely **additive on top of the floor set** — it's how a type requests the high-privilege tools that are *not* floor-granted (`Bash`, `WebSearch`, `WebFetch`, `Agent`). Listing a floor tool in `tools[]` is harmless but has no effect; omitting one has no effect either. See [`docs/agent-ops.md`](./agent-ops.md#tool-management-and-narrowing) for the full floor-tools vs. allowed-tools model.

### Manifests never contain secret values

The env contract (`env.required[]` / `env.optional[]`) is deliberately **keys-only**: each entry declares a `key`, a `description`, and whether the var is `secret` — never a `value` or `default`. The schema is `.strict()`, so an entry with a stray `value` key is rejected outright, not silently stripped. This matters because manifests are potential third-party input and are meant to be safely committed to a public repo: a manifest can declare *that* `CLAUDE_CODE_OAUTH_TOKEN` is needed without ever carrying a real token. Actual secret values are supplied out-of-band, per-agent-instance, via the admin service's encrypted `AgentEnv` store — never via the type manifest.

### New crons in published types ship `enabled: false`

Per the plugin constitution (`plugins/shipwright/CLAUDE.md`'s "System Cron Changes" section): any new cron added to a published Agent Type must ship with `enabled: false`. This avoids a new cron firing unexpectedly on existing agents of that type before they've opted in. Enable it per-agent once verified. The exception is a cron explicitly replacing a prior one — even then, add the replacement disabled, verify it, then flip it on and disable the old one, rather than swapping both in the same change.

The core shipwright loop has four phases — `dev-task`, `review`, `patch`, and `deploy`. Three of them (`dev-task`, `review`, `patch`) are a deliberate exception to "new crons ship disabled" — as pre-existing core phases (not new additions), they ship `enabled: true` by default in the reference coding manifest. `deploy` ships `enabled: false` as an explicit opt-in even though it's also a core phase. A brand-new maintenance cron (docs freshness, entropy patrol, etc.) always ships `enabled: false`.

### Resolution model

The schema, YAML parser (`parseAgentTypeManifest`), and JSON Schema generator (`buildAgentTypeJsonSchema`) live in `admin/src/agent-type-registry.ts`. Disk-loading and runtime resolution are implemented separately in `admin/src/agent-type-manifest-loader.ts`'s `AgentTypeRegistry` class, which resolves a `typeName` to `agent-types/{typeName}/manifest.yaml` (relative to the repo root) and validates it via `parseAgentTypeManifest`:

- **`getManifest(typeName)`** — used by cron reconciliation (`AgentCronJobService.reconcileSystemCrons()` in `admin/src/agent-cron-jobs.ts`). An unknown `typeName` falls back to the `coding` manifest with a logged warning rather than failing the boot-path call; if the `coding` fallback itself can't load, that's treated as a startup-time bug and the error propagates.
- **`tryGetManifest(typeName)`** — used by `POST /agents` (`admin/src/agents-api.ts`) to validate a requested `type`. Returns `undefined` for an unknown type (no fallback, no warning) so the route can reject with `400` instead of silently seeding a `coding` agent under a different label.
- **`listTypes()`** — discovers every directory under `agent-types/` and resolves each to `{name, displayName}` for the new-agent type picker (called from the `GET /admin/agents/new` handler in `admin/src/admin-ui.ts`, which passes the resolved types into `renderNewLocalAgentPage()` in `admin/src/admin-ui-pages.ts`). A directory whose manifest fails to load or parse is skipped rather than 500ing the whole page.

There is currently **no built-in-vs-custom distinction or shadow-rejection check** — every `typeName` is resolved the same way, by directory lookup under `agent-types/` on disk. The registry does not yet support loading a manifest from anywhere other than the local `agent-types/` directory (e.g. a GitHub source reference — see below), so the question of a custom manifest colliding with a shipped type's name does not yet arise in practice. Revisit this section once GitHub source references (below) land and introduce a second manifest source.

## GitHub source references

> **Specified, not implemented.** This section documents the intended design for plugging a custom Agent Type manifest in from a user's GitHub repo. No fetch logic, loader, or schema field described here exists yet — nothing in this section should be read as already-shipped behavior. It exists so the eventual implementation has an agreed contract to build against, and so reviewers have something concrete to hold that implementation to.

### Reference grammar and pinning

A GitHub source reference has the form:

```
github:owner/repo[/path]@ref
```

- `owner/repo` — the GitHub repository hosting the Agent Type manifest.
- `/path` — optional; a subdirectory within the repo where the manifest lives, for repos that host more than one Agent Type or that keep the manifest alongside unrelated code. Omitted, the manifest is expected at the repo root.
- `@ref` — **required, no exceptions.** `ref` must resolve to a tag or a commit SHA — **never a branch name**. A branch is a moving pointer; an Agent Type manifest controls what crons an agent runs and what tools it's granted, so a moving reference would let upstream repo activity silently change a running agent's crons/tools without any action on the agent owner's part. That is not acceptable, hence the grammar has no unpinned form and no branch tracking mode — branches are explicitly out of scope for `ref`. A future loader must reject a reference whose `ref` segment is missing or is not a tag or commit SHA.

### `owner/repo` validation

The `owner/repo` portion of the reference is validated with the same rule already used elsewhere in this codebase for org/repo strings: [`lib/org-repo.ts`](../lib/org-repo.ts)'s `isOrgRepo` — split on `/`, require exactly two non-empty parts. A future loader is expected to reuse `isOrgRepo` directly rather than reimplement the check.

### Conventional layout

At the referenced path (repo root, or `/path` when given), the loader expects a conventional layout:

- `manifest.yaml` — **required.** The `AgentType` manifest itself, in the same `shipwright.dev/v1alpha1` format documented above in this guide.
- an identity templates directory — **optional.** Workspace template files matching what `identity.templatesDir` in the manifest points at (see [Identity](#identity)). When absent, the referenced type is expected to fall back to a built-in default templates directory rather than fail to load.

No other files at the referenced path carry meaning to the loader; a repo is free to host other content alongside these.

### Private-repo auth

A source reference may point at a private repository. Fetching it is expected to reuse the **existing agent-env mechanism** — the same encrypted `AgentEnv` key/value store already used for every other per-agent credential (see [Env contract](#env-contract) above) — to supply a GitHub token, rather than inventing a new credential-storage path for this one feature.

The likely fetch mechanism is the GitHub App auth already implemented in [`agent/src/github-app-auth.ts`](../agent/src/github-app-auth.ts) (`createAppAuth` from `@octokit/auth-app`, installation-token caching with proactive refresh) — the same mechanism the agent runtime already uses to authenticate its own GitHub API calls. A future implementation should prefer that path over asking users to mint and store a separate personal access token, falling back to a PAT (mirroring the existing `GH_TOKEN` optional-env pattern in the worked env example above) only where a GitHub App installation isn't available for the target repo.

This guide reserves a single **optional**, reserved-but-unused top-level manifest field name, `source`, as the intended future hook for "this Agent Type's canonical manifest was fetched from this GitHub reference" — a string carrying the `github:owner/repo[/path]@ref` value. `source` is **not** present in `AgentTypeManifestSchema` today; it is named here only so a future schema change has an agreed field name to add, not to declare it live.

### Security requirements

A GitHub source reference is an **external-code-injection surface**: the referenced repo's `manifest.yaml` becomes an agent's live cron/tool/env configuration, and any markdown or prompt content it pulls in (workspace templates, skill/command bodies) becomes text an agent will treat as instructions. Both are attacker-controlled the moment a source reference points at a repo the agent owner doesn't fully trust or doesn't control the write access to. Before any implementation of this feature ships, it must include:

- **Ref pinning is mandatory, not advisory.** The grammar above already forbids branch tracking; the loader must enforce it (reject on load, not just recommend in docs) so a manifest's source can never silently drift to new upstream content.
- **Content review before first use.** A source reference must not be auto-fetched and auto-applied the first time it's configured without a human reviewing the manifest (and any templates it pulls in) at the pinned ref — analogous to reviewing a dependency before adding it, not just trusting a URL.
- **Allowlisting.** The set of `owner/repo` values a deployment is willing to fetch custom Agent Type manifests from must be explicitly allowlisted by an operator, not open to any public GitHub repo by default. An unlisted `owner/repo` must fail closed.

These three requirements are **required work for the future implementation pass** — none of them exist today because none of the fetch/load code exists today.

## Generated JSON Schema

The full JSON Schema for `AgentTypeManifestSchema` is generated from the Zod source of truth and committed at [`docs/schemas/agent-type.schema.json`](./schemas/agent-type.schema.json). Regenerate it after any schema change:

```bash
bun run scripts/generate-agent-type-schema.ts
```

A drift guard (`admin/src/agent-type-registry.schema.unit.test.ts`) fails CI if the committed artifact falls out of sync with the live schema.
