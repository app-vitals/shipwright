# Extending Shipwright

> How a repo or team adds its own commands, skills, or scheduled automation on top of the shipwright plugin — without forking Shipwright itself.

## Overview

The `shipwright` plugin (artifact **A**, see [architecture.md](./architecture.md)) is repo-agnostic and ships one delivery loop: spec → plan → execute → review → deploy. A team that wants its own commands, skills, or repo-specific scheduled behavior on top of that loop has two supported paths, depending on how much they need:

- **A companion plugin** — a separate Claude Code marketplace plugin (their own repo, their own marketplace) installed alongside `shipwright` on the same agent, adding new commands/skills under their own namespace.
- **A custom cron** — a scheduled prompt on the agent that invokes a command from an installed plugin (shipwright's or a companion's), for autonomous behavior specific to their repo.

Neither path requires modifying `plugins/shipwright/` — that directory stays generic, shared, and upgradeable.

## Installing a companion plugin

`AgentPlugin` is a **list**, not a single-plugin slot: an agent can have any number of plugins installed side by side, including `shipwright` plus one or more companion plugins from your own repo or marketplace.

Install one via the admin CRUD API:

```
POST /agents/:id/plugins
```

Body: `{ name: string, version?: string, enabled?: boolean }`. See [agent-api.md](./agent-api.md#plugins) for the full request/response shape, plus `GET`/`PATCH`/`DELETE /agents/:id/plugins` for listing, updating, and removing plugins.

`name` follows the marketplace convention `plugin-name@marketplace-name` (e.g. `shipwright@shipwright`). Installing your own plugin (`mycompany-tools@mycompany-marketplace`) does not disturb the existing `shipwright@shipwright` install — both rows coexist on the agent, and the agent's Claude Code session loads commands and skills from every enabled plugin.

## Namespacing convention

Claude Code commands are namespaced by plugin name — `shipwright`'s commands are invoked as `/shipwright:dev-task`, `/shipwright:review`, etc. Give your companion plugin its own name (e.g. `mycompany`) so its commands land under a distinct prefix:

```
/mycompany:deploy-notify
/mycompany:changelog-sync
```

This avoids any collision with `/shipwright:*` commands, keeps it obvious at a glance which plugin owns which command, and lets you install, update, or remove your plugin independently of shipwright's own release cadence.

## Custom cron jobs for scheduled automation

Crons are how Shipwright runs autonomous, scheduled behavior — the `shipwright-loop` and maintenance crons (entropy patrol, docs freshness, etc.) are all system crons under the hood. You can add your own **non-system** cron the same way, via the same API:

```
POST /agents/:id/crons
```

A cron created through this endpoint is always a normal (non-system) cron — system crons are reserved for Shipwright's own built-in maintenance jobs, created internally via reconciliation, and cannot be created through this public route (see [agent-api.md](./agent-api.md#cron-jobs)). Non-system crons you create can be updated or deleted freely through the same CRUD routes; system crons cannot.

The cron's `prompt` field is a **plain string** — it is not scoped to any particular plugin. That means a custom cron's prompt can invoke any command from any plugin installed on the agent, including your own companion plugin's commands:

```json
{
  "schedule": "0 9 * * 1-5",
  "prompt": "/mycompany:changelog-sync",
  "channel": "C0123456789",
  "name": "changelog-sync-weekdays"
}
```

This is the mechanism for repo-specific scheduled/autonomous behavior — a nightly report, a weekly changelog sync, a custom compliance check — that doesn't belong in the shared `shipwright` plugin. See [agent-api.md](./agent-api.md#cron-jobs) for the full field reference (schedule validation, delivery-target rules, `preCheck`, etc.).

## Lightweight customization without a companion plugin

If all you need is to tweak config or data — not add a new command or skill — a full companion plugin is overkill. The `entropy-scan` skill supports a local override file under `.claude/shipwright/` in the target repo, checked before falling back to the plugin's shipped default — the reference pattern for this kind of lightweight customization:

- Default: `<plugin-dir>/references/principles.md`
- Override: `.claude/shipwright/principles.md` (project-local, used in its entirety when present — no merging with the default)

Run `/entropy-scan --init` to seed the override file from the plugin default, then edit it to match your project's norms (disable entries, change severity, add project-specific checks). See [`skills/entropy-scan/references/customization.md`](../plugins/shipwright/skills/entropy-scan/references/customization.md) for the full pattern.

Reach for this first if you just need different data or thresholds; reach for a companion plugin when you need genuinely new commands, skills, or scheduled behavior that doesn't fit inside shipwright's existing commands.

## See also

- **[agent-api.md](./agent-api.md)** — full request/response schemas for the Plugins and Cron jobs endpoints.
- **[architecture.md](./architecture.md)** — the four-artifact design and where the plugin fits.
- **[`skills/entropy-scan/references/customization.md`](../plugins/shipwright/skills/entropy-scan/references/customization.md)** — the `.claude/shipwright/principles.md` override pattern in full.
