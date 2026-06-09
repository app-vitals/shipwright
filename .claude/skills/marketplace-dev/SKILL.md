---
name: marketplace-dev
description: >
  This skill MUST activate when creating, modifying, or reviewing the shipwright
  plugin or its marketplace entry. Triggers on: editing files under
  plugins/shipwright/, modifying plugin.json or .claude-plugin/marketplace.json,
  adding commands/skills/agents/hooks to the shipwright plugin, editing TESTING.md,
  reviewing or creating pull requests that touch plugins/shipwright/, or when user
  mentions "version bump", "release", "add command", "add skill", "add hook",
  "add agent", "marketplace update", "plugin checklist", "plugin.json", or
  "marketplace.json". This skill prevents version drift and enforces structural
  conventions for the shipwright plugin in this self-hosted marketplace.
---

# Marketplace Development Guide

This skill encodes the conventions and checklists for working with the `shipwright` plugin
in this self-hosted single-plugin marketplace. Follow it to prevent version drift and
maintain consistency.

## When This Activates

- Bumping the plugin version (new feature, bug fix, breaking change)
- Adding or modifying commands, skills, agents, or hooks
- Editing `plugins/shipwright/.claude-plugin/plugin.json`
- Editing `.claude-plugin/marketplace.json` (once it exists — see MKT-1.2)
- Updating plugin descriptions or README content
- Creating or reviewing PRs that touch `plugins/shipwright/`

---

## Version Ownership

**This is the most important section.** Version in this repo is owned by **semantic-release**
and **`scripts/sync-version.ts`** — do NOT manually bump version numbers.

### How Versioning Works

Versions are determined automatically on every merge to `main`:

1. **semantic-release** analyzes conventional commits since the last tag
2. It calls `scripts/sync-version.ts <nextVersion>` via `prepareCmd` in `.releaserc.json`
3. `sync-version.ts` writes the new version to **five locations**:

| # | File | Updated by |
|---|------|------------|
| 1 | `package.json` | `sync-version.ts` |
| 2 | `plugins/shipwright/package.json` | `sync-version.ts` |
| 3 | `metrics/package.json` | `sync-version.ts` |
| 4 | `agent/package.json` | `sync-version.ts` |
| 5 | `version.txt` | `sync-version.ts` |

A sixth location, `.claude-plugin/marketplace.json`, will also be auto-synced once MKT-1.2
lands (the file does not exist yet).

### What Developers Do Instead

Write correct **conventional commits** — semantic-release derives the bump type from them:

| Commit prefix | Bump type | Example |
|---|---|---|
| `fix:` | Patch (1.2.0 → 1.2.1) | `fix: correct hook timeout` |
| `feat:` | Minor (1.2.0 → 1.3.0) | `feat: add /audit command` |
| `feat!:` or `BREAKING CHANGE:` | Major (1.2.0 → 2.0.0) | `feat!: rename dev-task command` |
| `docs:`, `chore:`, `ci:`, `build:` | No release | Non-functional changes |
| `refactor:`, `test:`, `perf:` | No release | Non-functional changes |

**Never manually edit** the `"version"` field in any `package.json`, `plugin.json`, or
`marketplace.json`. The automation owns these.

For a post-release verification checklist, see `references/version-sync-checklist.md`.

---

## Plugin Structure

This repo is both the plugin source and the marketplace host. The single plugin is
`shipwright`, living at `plugins/shipwright/`:

```
plugins/shipwright/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (name, version, description, hooks)
├── commands/                # Slash commands (*.md files with YAML frontmatter)
├── skills/                  # Skill definitions
│   └── <skill-name>/
│       ├── SKILL.md
│       ├── references/      # On-demand guidance docs
│       └── assets/
│           └── templates/   # Output templates
├── hooks/                   # Hook implementations
│   ├── hooks.json           # Hook configuration (if not in plugin.json)
│   └── <hook-impl>.sh
├── agents/                  # Agent definitions (*.md)
├── scripts/                 # Utility and build scripts
├── README.md                # Plugin documentation
└── TESTING.md               # Manual test plan
```

The marketplace manifest lives at `.claude-plugin/marketplace.json` (root of repo). It
does not exist yet — it is created in MKT-1.2.

---

## Plugin Modification Checklist

When modifying the `shipwright` plugin:

### Adding a New Component (command, skill, agent, hook)

1. Create the component file following conventions (see `references/frontmatter-schemas.md`)
2. If the plugin has a TESTING.md, add test scenarios for the new component
3. Update `plugins/shipwright/README.md` if it lists available commands
4. Write a `feat:` commit — semantic-release will derive the minor version bump on merge

### Modifying Existing Behavior

1. Make the change
2. Update TESTING.md if test scenarios are affected
3. Write a `fix:` or `feat:` commit as appropriate — do not manually bump the version

### Breaking Changes

1. Use `feat!:` as the commit prefix (or add `BREAKING CHANGE:` to the footer)
2. Document the breaking change in the commit body
3. semantic-release will cut a major version bump on merge

### Changing the Plugin Description

If you change the description in `plugin.json`, also sync it to:
- The `description` field in `.claude-plugin/marketplace.json` (once it exists)
- The opening paragraph in `plugins/shipwright/README.md`

---

## Component Conventions

### Commands (`commands/*.md`)

```yaml
---
description: Short action-oriented description     # Required
argument-hint: <required-arg> [optional-arg]        # Optional
allowed-tools: [Read, Glob, Grep, Bash]             # Optional
---
```

- Filename = command name + `.md` (e.g., `plan-session.md` -> `/plan-session`)
- Kebab-case filenames only
- For new work, consider the `skills/<name>/SKILL.md` layout instead (preferred by Anthropic)

### Skills (`skills/<name>/SKILL.md`)

```yaml
---
name: skill-name                                    # Required, matches directory name
description: >                                      # Required, ~100 words
  When to trigger and what it does...
---
```

- Directory name = skill name, kebab-case
- Use `references/` subdirectory for detailed guidance loaded on-demand
- Use `assets/templates/` for output templates
- Keep SKILL.md under 500 lines; split to references if exceeding

### Agents (`agents/*.md`)

```yaml
---
name: agent-name                                    # Required
description: >                                      # Required
  When to use this agent...
model: sonnet                                       # Optional (sonnet, opus, haiku)
tools:                                              # Required
  - Read
  - Edit
  - Grep
---
```

### Hooks

Hooks can be configured in `plugin.json` directly (simple cases) or in `hooks/hooks.json`
(complex multi-matcher setups). Use shell scripts (`.sh`) or Python (`.py`) for
implementation.

For complete schemas and examples, see `references/frontmatter-schemas.md`.

---

## Naming & Consistency Standards

### Author Field (Standardized)

```json
"author": {
  "name": "App Vitals",
  "url": "https://github.com/app-vitals"
}
```

Use `"url"` (not `"email"`), and `"App Vitals"` (capitalized, with space).

### Repository and Homepage

```json
"homepage": "https://github.com/app-vitals/shipwright",
"repository": "https://github.com/app-vitals/shipwright"
```

### License

```json
"license": "MIT"
```

---

## Description Sync Points

The plugin description appears in multiple places. When changing it, update all:

| Location | Format |
|----------|--------|
| `plugins/shipwright/.claude-plugin/plugin.json` | `"description"` field (canonical source) |
| `.claude-plugin/marketplace.json` | `"description"` in plugin entry (once it exists) |
| `plugins/shipwright/README.md` | Opening paragraph (may be longer form) |

---

## References

Load these for detailed guidance when needed:

- **`references/version-sync-checklist.md`** — Post-release verification and a primer on semantic-release ownership
- **`references/plugin-scaffolding.md`** — Templates for plugin component files (plugin.json, README, TESTING.md)
- **`references/frontmatter-schemas.md`** — Complete YAML frontmatter schemas for all component types
