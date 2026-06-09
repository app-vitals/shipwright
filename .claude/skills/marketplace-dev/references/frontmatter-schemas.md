# Frontmatter Schemas

Complete YAML frontmatter schemas for every component type in the shipwright plugin.
These are sourced from our conventions and validated against Anthropic's official
example-plugin.

## Commands (`commands/<command-name>.md`)

```yaml
---
description: Short action-oriented description       # Required
argument-hint: <required-arg> [optional-arg]          # Optional — shown to user
allowed-tools: [Read, Glob, Grep, Bash]               # Optional — pre-approved tools
model: sonnet                                         # Optional — override model
---
```

**Notes**:
- The filename determines the command name: `plan-session.md` -> `/plan-session`
- `name` field is optional in commands — defaults to filename without extension
- `allowed-tools` reduces permission prompts for tools the command always needs
- For new work, Anthropic recommends the `skills/<name>/SKILL.md` layout instead

**Example** (from shipwright):
```yaml
---
description: Run a structured planning session
argument-hint: [path-to-input-docs]
allowed-tools: [Read, Glob, Grep, Bash, WebFetch, Agent, AskUserQuestion]
---
```

## Skills (`skills/<skill-name>/SKILL.md`)

```yaml
---
name: skill-name                                      # Required — must match directory name
description: >                                        # Required — ~100 words, trigger conditions
  This skill should be used when the user asks to
  "specific phrase", "another phrase", mentions
  "keyword", or discusses topic-area.
version: 1.0.0                                        # Optional — semantic version
---
```

**Notes**:
- The `description` is the primary triggering mechanism — be specific and aggressive
- Include both user phrases ("add a command") and file-path signals ("editing under plugins/")
- Skills that are also user-invocable slash commands can add:
  ```yaml
  argument-hint: <required-arg> [optional-arg]
  allowed-tools: [Read, Glob, Grep, Bash]
  ```
  > **Note:** In skill frontmatter, `allowed-tools` is **restrictive** (removes inherited tools, not additive). Sub-agents inherit all parent session tools by default; listing tools here *removes* anything not in the list. Omit `allowed-tools` unless you intentionally want to cap the skill's capabilities. For commands, `allowed-tools` pre-approves those tools and reduces permission prompts — a different effect.
- Keep SKILL.md under 500 lines; use `references/` for overflow

**Description writing tips**:
- List specific trigger phrases users might say
- Include keywords that indicate relevance
- Be "pushy" — undertriggering is worse than overtriggering
- Use "This skill should be used when..." or "This skill MUST activate when..."

## Agents (`agents/<agent-name>.md`)

```yaml
---
name: agent-name                                      # Required
description: >                                        # Required — when/why to use
  Detailed description of what this agent does
  and when it should be spawned.
model: sonnet                                         # Optional (sonnet, opus, haiku)
tools:                                                # Required — explicit tool list
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
  - WebSearch
  - WebFetch
  - AskUserQuestion
---
```

**Notes**:
- Agents are spawned by Claude, not invoked by users
- The `tools` list restricts what the agent can use — be explicit
- `model` defaults to the parent model if omitted
- Common tool sets:
  - Read-only research: `[Read, Glob, Grep, WebFetch, WebSearch]`
  - Code modification: `[Read, Edit, Glob, Grep, Bash]`
  - Full capability: all tools listed above

## Hooks

Hooks can be configured in two locations:

### Option A: Inline in plugin.json

For simple, single-matcher hooks:

```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/hook-name.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Option B: Separate hooks.json

For complex multi-matcher setups, use `hooks/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/hook-impl.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"
          }
        ]
      }
    ]
  }
}
```

### Hook Event Types

| Event | When It Fires |
|-------|---------------|
| `PreToolUse` | Before a tool executes — can allow, block, or modify |
| `PostToolUse` | After a tool executes |
| `UserPromptSubmit` | When the user submits a message |
| `SessionStart` | When a Claude Code session begins |
| `Stop` | When Claude finishes a response |

### Matcher Patterns

| Pattern | Matches |
|---------|---------|
| `"*"` | All events |
| `"Bash"` | Single tool |
| `"Edit\|Write"` | Multiple tools (pipe-separated) |

### Hook Implementation

Shell scripts receive JSON on stdin and must output JSON:

```bash
#!/bin/bash
set -e
input=$(cat)
# Parse with jq, make decisions
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
```

Always use `${CLAUDE_PLUGIN_ROOT}` for paths — it resolves to the plugin's root directory
at runtime.
