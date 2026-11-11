# Entropy Suppressions

How `entropy-scan` Step 3.5 maps findings onto `.shipwright/suppressions.yml` entries.
Schema, expiry and validation: `references/suppressions-schema.md` (plugin root).

An `entropy` entry matches on `file` + `symbol`, **exact string equality** — no globs, no
wildcards (`*` is just a literal character), no line numbers. A candidate for the shared
script is:

```json
{ "rule": "entropy", "file": "src/billing/invoice.ts", "symbol": "buildInvoice", "rule_id": "dead_exports", "line": 42 }
```

`rule` is always `entropy`. `rule_id` (the principle ID) and `line` are carried for
reporting only; the script ignores them when matching. Because `rule_id` is not part of the
key, one entry suppresses every principle that reports the same `file` + `symbol` — use
distinct symbols (below) when you need to suppress one principle only.

`file` is the repo-relative path exactly as it appears in the report. Rules that report no
named symbol use a **fixed convention** so entries stay stable across edits:

| `rule_id` | `file` | `symbol` |
|---|---|---|
| `dead_exports` | file containing the export | the exported name |
| `commented_out_blocks` | file containing the block | the file basename (all blocks in the file) |
| `unreferenced_files` | the unreferenced file | the file basename |
| `todo_fixme_hack` | file containing the comment | the comment text after the marker, trimmed |
| `stale_todo` | file containing the comment | the comment text after the marker, trimmed |
| `undocumented_exports` | file containing the export | the exported name |
| `missing_readme_section` | the directory's README path (`src/foo/README.md`), even if missing | the directory name (`foo`) |
| `hardcoded_secrets` | file containing the literal | the assigned identifier or key name (`apiKey`) |
| `webhook_signature_verification` | file containing the handler | the handler name |
| `workflow_job_timeout` | workflow file (`.github/workflows/ci.yml`) | the job name (the `jobs:` key) |
| `duplicated_utility` | file with the local copy | the local function name |
| `architecture_layering` | the handler/transport file | the handler name, or the file basename if anonymous |

Suppressing `hardcoded_secrets` is high stakes: only for confirmed non-secrets (fixtures,
public identifiers). Prefer rotating a real secret over suppressing it.
