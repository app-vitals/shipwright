# Plugin Scaffolding Templates

Reference templates for the `shipwright` plugin files. Use these when adding new
components or when creating the marketplace manifest (MKT-1.2).

## Plugin Directory Structure

```
plugins/shipwright/
├── .claude-plugin/
│   └── plugin.json          # Required: plugin manifest
├── commands/                # Optional: slash commands (*.md)
├── skills/                  # Optional: skill definitions
│   └── <skill-name>/
│       ├── SKILL.md
│       ├── references/      # On-demand guidance docs
│       └── assets/
│           └── templates/   # Output templates
├── hooks/                   # Optional: hook implementations
│   ├── hooks.json           # Hook configuration (if not in plugin.json)
│   └── <hook-impl>.sh       # Shell or Python scripts
├── agents/                  # Optional: agent definitions (*.md)
├── scripts/                 # Optional: utility scripts
├── README.md                # Required: plugin documentation
└── TESTING.md               # Recommended: manual test plan
```

## plugin.json Template

The canonical author convention for this repo:

```json
{
  "name": "shipwright",
  "version": "0.1.0",
  "description": "<one-line description of what the plugin does>",
  "author": {
    "name": "App Vitals",
    "url": "https://github.com/app-vitals"
  },
  "keywords": ["claude-code", "<relevant>", "<keywords>"],
  "homepage": "https://github.com/app-vitals/shipwright",
  "repository": "https://github.com/app-vitals/shipwright",
  "license": "MIT"
}
```

**Notes**:
- `version` is managed by semantic-release + `sync-version.ts` — do not hand-edit it
- `description` should be concise — the long-form description goes in README.md
- `author.url` is the GitHub org URL (not an email address)
- Add a `hooks` section only if the plugin has hooks configured inline in plugin.json
  (vs. a separate `hooks/hooks.json`)

## marketplace.json Entry Template

This file does not exist yet — it will be created in MKT-1.2. When it does, the
`shipwright` plugin entry will look like:

```json
{
  "name": "shipwright",
  "description": "<one-line description matching plugin.json>",
  "source": "./plugins/shipwright"
}
```

**Do not add** a version field to the entry. Only `name`, `description`, and `source`.

## Plugin README.md Template

```markdown
# <Plugin Name>

<2-3 sentence description of what the plugin does and why.>

## Installation

```
/plugin install shipwright@app-vitals/shipwright
```

## Commands

### /<command-name>

<what the command does>

**Usage:**
```
/<command-name> [arguments]
```

## How It Works

<brief explanation of the plugin's behavior, hooks, or skills>
```

## TESTING.md Template

```markdown
# Testing: shipwright

Manual test plan for the shipwright plugin.

---

## <Feature/Command> Tests

### Test 1: <Scenario Name>

**Setup:** <prerequisites, files to create, state to configure>

**Command:** `/<command-name> [args]`

**Verify:**
- [ ] <expected behavior 1>
- [ ] <expected behavior 2>
- [ ] <expected output or file state>

---

### Test 2: <Next Scenario>

**Setup:** <prerequisites>

**Command:** `/<command-name> [args]`

**Verify:**
- [ ] <expected behavior>

---

## Regression Checklist

Before shipping:
- [ ] All test scenarios pass
- [ ] Plugin installs cleanly via `/plugin install`
- [ ] No version drift (all package.json files match version.txt)
```
