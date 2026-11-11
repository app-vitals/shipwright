# Plan: chart-helm-repo-retry

shipwright#4741 (chart bump 1.32.27): the PR-time `package + index (dry run)` check went red on a transient 503 from https://app-vitals.github.io/agent/index.yaml during `helm repo add`; the same step passed 29s later on main. The identical `helm repo add ... && helm repo update` block is copy-pasted in chart-release.yml (x2), helm.yml (x2) and a variant in library-chart-release.yml.

## Tasks
| ID | Summary | Depends on |
|---|---|---|
| CDR-1.1 | one composite action with bounded retry for adding helm repos, used by all call sites | - |

## Decision Log
- Composite action over per-site retry loops: defaulted to a shared action - six copies of the block already drift-prone.
- Retries limited to repo add/update (network), never to helm lint/template/install results.
