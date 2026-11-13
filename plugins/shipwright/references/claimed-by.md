# `claimedBy` convention for claim calls

Every `POST /tasks/{id}/claim` and `POST /prs/claim` sends `claimedBy` in the JSON body, built with `jq -n --arg`:

```bash
--arg claimedBy "${SHIPWRIGHT_AGENT_ID:-local}"   # then include `claimedBy: $claimedBy` in the object
```

- **Agent token** (`SHIPWRIGHT_AGENT_ID` set): the task store pins `claimedBy` to the token's agent id and
  ignores the body value, so behaviour is unchanged.
- **Non-agent token** (e.g. minted by `scripts/local-store.sh`, `SHIPWRIGHT_AGENT_ID` unset): the server returns
  `400 claimedBy is required` unless the body carries it. The single fallback identity is `local`; never
  improvise other values.
- Heartbeat, release and complete (`/tasks/{id}/heartbeat|release|complete`, `/prs/{id}/release`) are matched by
  record id server-side and take no `claimedBy`, so they need no change.
