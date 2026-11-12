# Coding Cron Guidance

Coding-specific cron notes for agents that run the Shipwright plugin. Generic cron, env var, tool,
token and plugin management lives in the platform's `agent-platform:agent-admin` skill; this file
carries only what that generic skill does not know about the coding specialty.

## Where the defaults live

System crons for the `coding` specialty are seeded from `CODING_SPECIALTY_DEFAULTS` in
`admin/src/coding/coding-specialty-defaults.ts`, supplied to the platform admin through the coding
extension's `specialtyDefaults()` hook. To change a system cron's schedule, prompt or `preCheck`,
edit that file in a PR, then call `POST /agents/{agentId}/crons/reconcile` to apply it. System crons
cannot be deleted (403) but can be enabled/disabled with `PATCH {"enabled": bool}`; the enabled state
survives reconcile.

## `shipwright:check-*` preCheck examples

A `preCheck` is a script whose stdout becomes the cron's live prompt; a non-zero exit or empty output
skips the tick. Plugin scripts use the `plugin:script.ts` form and resolve to the plugin's `scripts/` dir:

- `shipwright:check-docs-freshness.ts` — docs freshness guard
- `shipwright:check-site-docs-freshness.ts` — site docs freshness guard
- `shipwright:check-error-patrol.ts` — error patrol
- `shipwright:check-consolidation-patrol.ts` — consolidation patrol
- `shipwright:check-prompt-audit.ts` — prompt audit patrol
- `shipwright:check-learn-dream.ts` — learn-dream batch
- `shipwright:check-test-readiness.ts` — test-readiness pipeline

```bash
# Set a preCheck without touching schedule/prompt; pass null to clear it
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{"preCheck": "shipwright:check-docs-freshness.ts"}'
```

The delivery-loop phases (dev-task, review, patch, deploy) are not preCheck crons: the
`shipwright-loop` cron picks one candidate per tick and dispatches the matching command.
