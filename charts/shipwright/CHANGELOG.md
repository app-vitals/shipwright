# Changelog

All notable changes to the **shipwright** Helm chart are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this chart adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The chart `version` (in `Chart.yaml`) is bumped on **every** chart change,
independent of `appVersion`. CI enforces this with
`ct lint --check-version-increment`. Each release here must mirror the
`artifacthub.io/changes` annotation in `Chart.yaml`.

## [1.19.125] - 2026-09-05

### Changed

- auto-bump to chart v1.19.125 triggered by release tag(s): `admin-v1.151.0`, `agent-v1.257.1`, `chat-v1.84.0`, `metrics-v1.87.0`, `task-store-v1.112.0`

## [1.19.124] - 2026-09-05

### Changed

- auto-bump to chart v1.19.124 triggered by release tag(s): `agent-v1.257.0`

## [1.19.123] - 2026-09-05

### Changed

- auto-bump to chart v1.19.123 triggered by release tag(s): `admin-v1.150.0`

## [1.19.122] - 2026-09-05

### Changed

- auto-bump to chart v1.19.122 triggered by release tag(s): `task-store-v1.111.0`

## [1.19.121] - 2026-09-05

### Changed

- auto-bump to chart v1.19.121 triggered by release tag(s): `task-store-v1.110.1`

## [1.19.120] - 2026-09-05

### Changed

- auto-bump to chart v1.19.120 triggered by release tag(s): `admin-v1.149.1`, `metrics-v1.86.0`, `task-store-v1.110.0`

## [1.19.119] - 2026-09-05

### Changed

- auto-bump to chart v1.19.119 triggered by release tag(s): `agent-v1.256.0`

## [1.19.118] - 2026-09-05

### Changed

- auto-bump to chart v1.19.118 triggered by release tag(s): `admin-v1.149.0`

## [1.19.117] - 2026-09-05

### Changed

- auto-bump to chart v1.19.117 triggered by release tag(s): `admin-v1.148.0`

## [1.19.116] - 2026-09-05

### Changed

- auto-bump to chart v1.19.116 triggered by release tag(s): `agent-v1.255.0`

## [1.19.115] - 2026-09-05

### Changed

- auto-bump to chart v1.19.115 triggered by release tag(s): `admin-v1.147.0`, `agent-v1.254.0`, `chat-v1.83.0`, `metrics-v1.85.0`, `task-store-v1.109.0`

## [1.19.114] - 2026-09-05

### Changed

- auto-bump to chart v1.19.114 triggered by release tag(s): `admin-v1.146.0`

## [1.19.113] - 2026-09-05

### Changed

- auto-bump to chart v1.19.113 triggered by release tag(s): `admin-v1.145.0`

## [1.19.112] - 2026-09-05

### Changed

- auto-bump to chart v1.19.112 triggered by release tag(s): `agent-v1.253.0`

## [1.19.111] - 2026-09-05

### Changed

- auto-bump to chart v1.19.111 triggered by release tag(s): `admin-v1.144.0`

## [1.19.110] - 2026-09-05

### Changed

- auto-bump to chart v1.19.110 triggered by release tag(s): `admin-v1.143.1`, `agent-v1.252.0`, `chat-v1.82.0`, `metrics-v1.84.0`, `task-store-v1.108.0`

## [1.19.109] - 2026-09-05

### Changed

- bump traefik subchart dependency to 41.4.0 and pin the Whisper ASR image back to v1.3.0 (#2920)

## [1.19.106] - 2026-09-05

### Changed

- auto-bump to chart v1.19.106 triggered by release tag(s): `admin-v1.143.0`

## [1.19.105] - 2026-09-05

### Changed

- auto-bump to chart v1.19.105 triggered by release tag(s): `agent-v1.251.0`

## [1.19.104] - 2026-09-04

### Changed

- auto-bump to chart v1.19.104 triggered by release tag(s): `agent-v1.250.0`

## [1.19.103] - 2026-09-04

### Changed

- auto-bump to chart v1.19.103 triggered by release tag(s): `admin-v1.142.1`, `chat-v1.81.0`, `metrics-v1.83.0`, `task-store-v1.107.0`

## [1.19.102] - 2026-09-04

### Changed

- auto-bump to chart v1.19.102 triggered by release tag(s): `admin-v1.142.0`

## [1.19.101] - 2026-09-04

### Changed

- auto-bump to chart v1.19.101 triggered by release tag(s): `admin-v1.141.0`, `chat-v1.80.0`, `metrics-v1.82.0`, `task-store-v1.106.0`

## [1.19.100] - 2026-09-04

### Changed

- auto-bump to chart v1.19.100 triggered by release tag(s): `admin-v1.140.1`, `agent-v1.249.1`, `chat-v1.79.0`, `metrics-v1.81.0`, `task-store-v1.105.0`

## [1.19.99] - 2026-09-04

### Fixed

- Raise admin readinessProbe successThreshold to 2 to prevent premature Ready flip during pod initialization. Single successful DB-aware probes no longer allow still-stabilizing pods to enter Ready state, preventing traffic routing before Cloud SQL proxy sidecar connection stabilizes (prevents transient 500s bursts observed via Sentry during admin restarts).

## [1.19.98] - 2026-09-04

### Changed

- auto-bump to chart v1.19.98 triggered by release tag(s): `agent-v1.249.0`

## [1.19.97] - 2026-09-04

### Changed

- auto-bump to chart v1.19.97 triggered by release tag(s): `admin-v1.140.0`

## [1.19.96] - 2026-09-04

### Changed

- auto-bump to chart v1.19.96 triggered by release tag(s): `agent-v1.248.0`

## [1.19.95] - 2026-09-04

### Changed

- auto-bump to chart v1.19.95 triggered by release tag(s): `admin-v1.139.0`, `agent-v1.247.0`, `chat-v1.78.0`, `metrics-v1.80.0`, `task-store-v1.104.0`

## [1.19.94] - 2026-09-04

### Changed

- auto-bump to chart v1.19.94 triggered by release tag(s): `admin-v1.138.0`

## [1.19.93] - 2026-09-04

### Changed

- auto-bump to chart v1.19.93 triggered by release tag(s): `admin-v1.137.0`, `agent-v1.246.0`, `chat-v1.77.0`, `metrics-v1.79.0`, `task-store-v1.103.0`

## [1.19.92] - 2026-09-04

### Changed

- auto-bump to chart v1.19.92 triggered by release tag(s): `admin-v1.133.0`, `admin-v1.134.0`, `admin-v1.134.1`, `admin-v1.135.0`, `admin-v1.136.0`, `agent-v1.242.0`, `agent-v1.243.0`, `agent-v1.244.0`, `agent-v1.245.0`, `chat-v1.76.0`, `metrics-v1.78.0`, `task-store-v1.102.0`

## [1.19.91] - 2026-09-04

### Removed

- `admin.taskStorePublicUrl` and the `SHIPWRIGHT_TASK_STORE_PUBLIC_URL` env var it
  injected into the admin container. The admin service no longer reads this value —
  its only consumer, `resolveTaskStoreBaseUrl()`, was removed alongside the
  `/admin/tokens` task-store token UI.

## [1.19.90] - 2026-09-04

### Changed

- auto-bump to chart v1.19.90 triggered by release tag(s): `agent-v1.241.0`

## [1.19.89] - 2026-09-04

### Changed

- auto-bump to chart v1.19.89 triggered by release tag(s): `agent-v1.240.0`

## [1.19.88] - 2026-09-04

### Changed

- auto-bump to chart v1.19.88 triggered by release tag(s): `agent-v1.239.0`

## [1.19.87] - 2026-09-04

### Changed

- auto-bump to chart v1.19.87 triggered by release tag(s): `agent-v1.238.2`

## [1.19.86] - 2026-09-04

### Changed

- auto-bump to chart v1.19.86 triggered by release tag(s): `agent-v1.238.1`

## [1.19.85] - 2026-09-04

### Changed

- auto-bump to chart v1.19.85 triggered by release tag(s): `agent-v1.238.0`

## [1.19.84] - 2026-09-04

### Changed

- auto-bump to chart v1.19.84 triggered by release tag(s): `agent-v1.237.0`

## [1.19.83] - 2026-09-03

### Changed

- auto-bump to chart v1.19.83 triggered by release tag(s): `agent-v1.236.0`

## [1.19.82] - 2026-09-03

### Changed

- auto-bump to chart v1.19.82 triggered by release tag(s): `admin-v1.131.0`, `agent-v1.235.0`, `chat-v1.74.0`, `metrics-v1.76.0`, `task-store-v1.100.0`

## [1.19.81] - 2026-09-03

### Changed

- auto-bump to chart v1.19.81 triggered by release tag(s): `admin-v1.130.1`, `agent-v1.234.0`

## [1.19.80] - 2026-09-03

### Changed

- auto-bump to chart v1.19.80 triggered by release tag(s): `admin-v1.130.0`

## [1.19.79] - 2026-09-03

### Changed

- auto-bump to chart v1.19.79 triggered by release tag(s): `agent-v1.233.0`

## [1.19.78] - 2026-09-03

### Changed

- auto-bump to chart v1.19.78 triggered by release tag(s): `admin-v1.129.0`, `agent-v1.232.0`, `chat-v1.73.0`, `metrics-v1.75.0`, `task-store-v1.99.0`

## [1.19.77] - 2026-09-03

### Changed

- auto-bump to chart v1.19.77 triggered by release tag(s): `admin-v1.128.0`, `agent-v1.231.0`, `chat-v1.72.0`, `metrics-v1.74.0`, `task-store-v1.98.0`

## [1.19.76] - 2026-09-03

### Changed

- auto-bump to chart v1.19.76 triggered by release tag(s): `agent-v1.230.0`

## [1.19.75] - 2026-09-03

### Changed

- auto-bump to chart v1.19.75 triggered by release tag(s): `admin-v1.127.0`, `agent-v1.229.0`, `chat-v1.71.0`, `metrics-v1.73.0`, `task-store-v1.97.0`

## [1.19.74] - 2026-09-03

### Changed

- auto-bump to chart v1.19.74 triggered by release tag(s): `agent-v1.228.2`

## [1.19.73] - 2026-09-03

### Changed

- auto-bump to chart v1.19.73 triggered by release tag(s): `agent-v1.228.1`

## [1.19.72] - 2026-09-03

### Changed

- auto-bump to chart v1.19.72 triggered by release tag(s): `admin-v1.126.0`, `agent-v1.228.0`, `chat-v1.70.0`, `metrics-v1.72.0`, `task-store-v1.96.0`

## [1.19.71] - 2026-09-03

### Changed

- auto-bump to chart v1.19.71 triggered by release tag(s): `agent-v1.227.2`

## [1.19.70] - 2026-09-03

### Changed

- auto-bump to chart v1.19.70 triggered by release tag(s): `agent-v1.227.1`

## [1.19.69] - 2026-09-03

### Changed

- auto-bump to chart v1.19.69 triggered by release tag(s): `agent-v1.227.0`

## [1.19.68] - 2026-09-03

### Changed

- auto-bump to chart v1.19.68 triggered by release tag(s): `agent-v1.226.0`

## [1.19.67] - 2026-09-03

### Changed

- auto-bump to chart v1.19.67 triggered by release tag(s): `agent-v1.225.0`

## [1.19.66] - 2026-09-03

### Changed

- auto-bump to chart v1.19.66 triggered by release tag(s): `admin-v1.124.0`, `agent-v1.224.0`, `chat-v1.69.0`, `metrics-v1.71.0`, `task-store-v1.95.0`

## [1.19.65] - 2026-09-03

### Changed

- auto-bump to chart v1.19.65 triggered by release tag(s): `agent-v1.223.0`

## [1.19.64] - 2026-09-03

### Changed

- auto-bump to chart v1.19.64 triggered by release tag(s): `agent-v1.222.1`

## [1.19.63] - 2026-09-03

### Changed

- auto-bump to chart v1.19.63 triggered by release tag(s): `agent-v1.222.0`

## [1.19.62] - 2026-09-03

### Changed

- auto-bump to chart v1.19.62 triggered by release tag(s): `admin-v1.123.0`

## [1.19.61] - 2026-09-03

### Changed

- auto-bump to chart v1.19.61 triggered by release tag(s): `admin-v1.122.0`

## [1.19.60] - 2026-09-03

### Changed

- auto-bump to chart v1.19.60 triggered by release tag(s): `admin-v1.121.0`, `agent-v1.221.0`, `chat-v1.68.0`, `metrics-v1.70.0`, `task-store-v1.94.0`

## [1.19.59] - 2026-09-03

### Changed

- auto-bump to chart v1.19.59 triggered by release tag(s): `agent-v1.220.1`

## [1.19.58] - 2026-09-02

### Changed

- auto-bump to chart v1.19.58 triggered by release tag(s): `agent-v1.220.0`

## [1.19.57] - 2026-09-02

### Changed

- auto-bump to chart v1.19.57 triggered by release tag(s): `admin-v1.120.0`

## [1.19.56] - 2026-09-02

### Changed

- auto-bump to chart v1.19.56 triggered by release tag(s): `admin-v1.119.1`, `agent-v1.219.0`, `chat-v1.67.0`, `metrics-v1.69.0`, `task-store-v1.93.0`

## [1.19.55] - 2026-09-02

### Changed

- auto-bump to chart v1.19.55 triggered by release tag(s): `admin-v1.119.0`

## [1.19.54] - 2026-09-02

### Changed

- auto-bump to chart v1.19.54 triggered by release tag(s): `admin-v1.118.1`

## [1.19.53] - 2026-09-02

### Changed

- auto-bump to chart v1.19.53 triggered by release tag(s): `admin-v1.118.0`

## [1.19.52] - 2026-09-02

### Changed

- auto-bump to chart v1.19.52 triggered by release tag(s): `admin-v1.117.0`

## [1.19.51] - 2026-09-02

### Changed

- auto-bump to chart v1.19.51 triggered by release tag(s): `agent-v1.218.0`

## [1.19.50] - 2026-09-02

### Changed

- auto-bump to chart v1.19.50 triggered by release tag(s): `chat-v1.66.0`

## [1.19.49] - 2026-09-02

### Changed

- auto-bump to chart v1.19.49 triggered by release tag(s): `admin-v1.115.0`

## [1.19.48] - 2026-09-02

### Changed

- auto-bump to chart v1.19.48 triggered by release tag(s): `agent-v1.217.0`

## [1.19.47] - 2026-09-02

### Changed

- auto-bump to chart v1.19.47 triggered by release tag(s): `admin-v1.114.0`

## [1.19.46] - 2026-09-02

### Changed

- auto-bump to chart v1.19.46 triggered by release tag(s): `admin-v1.113.3`

## [1.19.45] - 2026-09-02

### Changed

- auto-bump to chart v1.19.45 triggered by release tag(s): `admin-v1.113.1`, `admin-v1.113.2`, `agent-v1.216.0`, `chat-v1.65.0`, `chat-v1.65.1`, `metrics-v1.67.0`, `metrics-v1.67.1`, `task-store-v1.91.0`, `task-store-v1.91.1`

## [1.19.44] - 2026-09-02

### Changed

- auto-bump to chart v1.19.44 triggered by release tag(s): `admin-v1.113.0`

## [1.19.43] - 2026-09-02

### Changed

- auto-bump to chart v1.19.43 triggered by release tag(s): `agent-v1.215.3`

## [1.19.42] - 2026-09-02

### Changed

- auto-bump to chart v1.19.42 triggered by release tag(s): `agent-v1.215.2`

## [1.19.41] - 2026-09-01

### Changed

- auto-bump to chart v1.19.41 triggered by release tag(s): `agent-v1.215.1`

## [1.19.40] - 2026-09-01

### Changed

- auto-bump to chart v1.19.40 triggered by release tag(s): `agent-v1.215.0`

## [1.19.39] - 2026-09-01

### Changed

- auto-bump to chart v1.19.39 triggered by release tag(s): `agent-v1.214.0`

## [1.19.38] - 2026-09-01

### Changed

- auto-bump to chart v1.19.38 triggered by release tag(s): `admin-v1.111.0`

## [1.19.37] - 2026-09-01

### Changed

- auto-bump to chart v1.19.37 triggered by release tag(s): `agent-v1.213.0`

## [1.19.36] - 2026-09-01

### Changed

- auto-bump to chart v1.19.36 triggered by release tag(s): `agent-v1.212.0`

## [1.19.35] - 2026-09-01

### Changed

- auto-bump to chart v1.19.35 triggered by release tag(s): `metrics-v1.64.0`

## [1.19.34] - 2026-09-01

### Changed

- auto-bump to chart v1.19.34 triggered by release tag(s): `agent-v1.211.1`

## [1.19.33] - 2026-09-01

### Changed

- auto-bump to chart v1.19.33 triggered by release tag(s): `agent-v1.211.0`

## [1.19.32] - 2026-09-01

### Changed

- auto-bump to chart v1.19.32 triggered by release tag(s): `task-store-v1.88.0`

## [1.19.31] - 2026-09-01

### Changed

- auto-bump to chart v1.19.31 triggered by release tag(s): `task-store-v1.87.0`

## [1.19.30] - 2026-09-01

### Changed

- auto-bump to chart v1.19.30 triggered by release tag(s): `task-store-v1.86.0`

## [1.19.29] - 2026-09-01

### Changed

- auto-bump to chart v1.19.29 triggered by release tag(s): `admin-v1.108.0`, `chat-v1.61.0`, `metrics-v1.62.0`, `task-store-v1.85.0`

## [1.19.28] - 2026-09-01

### Changed

- auto-bump to chart v1.19.28 triggered by release tag(s): `admin-v1.107.0`, `agent-v1.210.0`, `chat-v1.60.0`, `metrics-v1.61.0`, `task-store-v1.84.0`

## [1.19.27] - 2026-09-01

### Changed

- auto-bump to chart v1.19.27 triggered by release tag(s): `agent-v1.209.0`

## [1.19.26] - 2026-09-01

### Changed

- auto-bump to chart v1.19.26 triggered by release tag(s): `agent-v1.208.0`

## [1.19.25] - 2026-09-01

### Changed

- auto-bump to chart v1.19.25 triggered by release tag(s): `agent-v1.207.1`

## [1.19.24] - 2026-09-01

### Changed

- auto-bump to chart v1.19.24 triggered by release tag(s): `agent-v1.207.0`

## [1.19.23] - 2026-09-01

### Changed

- auto-bump to chart v1.19.23 triggered by release tag(s): `task-store-v1.82.0`

## [1.19.22] - 2026-09-01

### Changed

- auto-bump to chart v1.19.22 triggered by release tag(s): `admin-v1.105.0`, `agent-v1.206.0`

## [1.19.21] - 2026-09-01

### Changed

- auto-bump to chart v1.19.21 triggered by release tag(s): `task-store-v1.81.0`

## [1.19.20] - 2026-08-31

### Changed

- auto-bump to chart v1.19.20 triggered by release tag(s): `agent-v1.205.0`

## [1.19.19] - 2026-08-31

### Changed

- auto-bump to chart v1.19.19 triggered by release tag(s): `agent-v1.204.0`

## [1.19.18] - 2026-08-31

### Changed

- auto-bump to chart v1.19.18 triggered by release tag(s): `agent-v1.203.0`

## [1.19.17] - 2026-08-31

### Changed

- auto-bump to chart v1.19.17 triggered by release tag(s): `admin-v1.104.0`, `agent-v1.202.0`, `chat-v1.58.0`

## [1.19.16] - 2026-08-31

### Changed

- auto-bump to chart v1.19.16 triggered by release tag(s): `admin-v1.103.0`, `agent-v1.201.0`, `chat-v1.57.0`, `metrics-v1.59.0`, `task-store-v1.80.0`

## [1.19.15] - 2026-08-31

### Changed

- auto-bump to chart v1.19.15 triggered by release tag(s): `metrics-v1.58.0`

## [1.19.14] - 2026-08-31

### Changed

- auto-bump to chart v1.19.14 triggered by release tag(s): `admin-v1.102.0`

## [1.19.13] - 2026-08-31

### Changed

- auto-bump to chart v1.19.13 triggered by release tag(s): `admin-v1.101.0`

## [1.19.12] - 2026-08-31

### Changed

- auto-bump to chart v1.19.12 triggered by release tag(s): `agent-v1.200.0`

## [1.19.11] - 2026-08-30

### Changed

- auto-bump to chart v1.19.11 triggered by release tag(s): `chat-v1.56.0`

## [1.19.10] - 2026-08-29

### Changed

- auto-bump to chart v1.19.10 triggered by release tag(s): `admin-v1.100.1`

## [1.19.9] - 2026-08-29

### Changed

- auto-bump to chart v1.19.9 triggered by release tag(s): `admin-v1.100.0`, `agent-v1.199.0`, `chat-v1.55.0`, `metrics-v1.57.0`, `task-store-v1.79.0`

## [1.19.8] - 2026-08-29

### Changed

- auto-bump to chart v1.19.8 triggered by release tag(s): `admin-v1.99.3`

## [1.19.7] - 2026-08-29

### Changed

- auto-bump to chart v1.19.7 triggered by release tag(s): `admin-v1.99.2`

## [1.19.6] - 2026-08-29

### Changed

- auto-bump to chart v1.19.6 triggered by release tag(s): `admin-v1.99.1`, `agent-v1.198.3`, `chat-v1.54.1`

## [1.19.5] - 2026-08-29

### Changed

- auto-bump to chart v1.19.5 triggered by release tag(s): `admin-v1.99.0`, `agent-v1.198.2`, `chat-v1.54.0`

## [1.19.4] - 2026-08-28

### Changed

- auto-bump to chart v1.19.4 triggered by release tag(s): `agent-v1.198.1`

## [1.19.3] - 2026-08-28

### Changed

- auto-bump to chart v1.19.3 triggered by release tag(s): `agent-v1.198.0`

## [1.19.2] - 2026-08-28

### Changed

- Derive `admin.appBaseUrl` from the public host (CNH-9.1). New `shipwright.admin.appBaseUrl` helper: an explicit `admin.appBaseUrl` value always wins; when empty and `networking.type` is `ingress` or `gateway`, `SHIPWRIGHT_ADMIN_APP_BASE_URL` is derived as `<scheme>://<public host>`; otherwise the env var is omitted (ClusterIP/NodePort/LoadBalancer installs unchanged). `NOTES.txt` and `README.md` updated to reflect the new precedence.

## [1.19.1] - 2026-08-28

### Changed

- auto-bump to chart v1.19.1 triggered by release tag(s): `admin-v1.98.0`, `agent-v1.197.0`, `chat-v1.53.0`, `metrics-v1.56.0`, `task-store-v1.78.0`

## [1.19.0] - 2026-08-27

### Changed

- Cloud-native docs and release (CNH-8.4). `README.md` gains Values rows for `ingress-nginx.enabled`/`traefik.enabled`/`cert-manager.enabled`, a Dependencies table listing all four vendored subcharts (`postgresql`, `ingress-nginx`, `traefik`, `cert-manager`) with versions/repositories/conditions, and a new "Cloud-native install (single chart)" section with a warning against bundling cert-manager on a cluster that already has it. `docs/deploy-kubernetes.md` gains a new "Cloud-native (any cluster)" deployment-target section (install commands for both the ingress-nginx and Traefik bundled variants, the same cert-manager-collision warning, and cross-links to the existing Bundled ingress controllers reference and Minikube profiles). `docs/helm-repo.md` now states the chart vendors four optional subcharts up front.

### Note

- This release closes out the cloud-native profiles milestone (CNH-8.1, CNH-8.2, CNH-8.3). Per the merge gate on this task, the PR is left open at reviewed/approved + CI green rather than auto-merged — a human merges it via the paired HITL task CNH-8.6, since the downstream `bump-shipwright-chart.yml` poller auto-merges chart bumps with no branch gate of its own.

## [1.18.3] - 2026-08-27

### Changed

- auto-bump to chart v1.18.3 triggered by release tag(s): `admin-v1.97.0`, `agent-v1.196.1`, `chat-v1.52.0`, `metrics-v1.55.0`, `task-store-v1.77.0`

## [1.18.2] - 2026-08-27

### Changed

- auto-bump to chart v1.18.2 triggered by release tag(s): `agent-v1.196.0`

## [1.18.1] - 2026-08-27

### Added

- Minikube cloud-native profile examples (CNH-8.2): new `examples/values-minikube-cloud-native-nginx.yaml` (bundles ingress-nginx + cert-manager with a selfsigned Issuer, `auth.mode: open`, `admin.appBaseUrl` on `https://shipwright.local:8443`) and `examples/values-minikube-cloud-native-traefik.yaml` (bundles Traefik, plain HTTP on `http://shipwright.local:8080`, no cert-manager) — dev-friendly variants of `values-cloud-native.yaml`/`values-cloud-native-traefik.yaml` tuned to run standalone on a fresh local Minikube VM with no external OAuth creds or pre-existing ClusterIssuer required.

## [1.18.0] - 2026-08-26

### Added

- Cloud-native profiles: examples, CI variants, kind e2e assertions (CNH-8.1). `examples/values-cloud-native.yaml` now sets `admin.appBaseUrl` (`https://shipwright.local:8443`) for OAuth redirects, and its `networking.ingress.host` moved to the `shipwright.local` placeholder (matching the selfsigned cert this profile issues); `examples/values-cloud-native-traefik.yaml` gains the same `admin.appBaseUrl` treatment (`https://shipwright.example.com`, matching its real `letsencrypt-prod` issuer). Two new `ct`-discovered `ci/` values variants — `ci/cloud-native-nginx-values.yaml` (ingress-nginx ClusterIP + small resources, cert-manager with `crds.keep=false` + small resources, `tls.certManager.enabled` + `issuer.create` selfsigned, task-store exposed — the only `ci/` variant that bundles cert-manager) and `ci/cloud-native-traefik-values.yaml` (traefik ClusterIP + small resources, no cert-manager, plain HTTP) — extend the `helm-e2e` kind matrix from three to five variants. `templates/tests/test-connection.yaml` gains an ingress-nginx-gated HTTPS retry-loop block (curls THROUGH the bundled ingress-nginx controller Service via `--connect-to`, asserting the served cert is not ingress-nginx's default "Kubernetes Ingress Controller Fake Certificate" placeholder, then checks `/task-store/health` -> 200) and a traefik-gated block (Host-header curl through the bundled traefik Service, plain HTTP, `/task-store/health` -> 200). New `templates/tests/test-cert-issuer.yaml` — gated identically to `templates/cert-manager-bootstrap-job.yaml` (`shipwright.certManager.viaHook`) with its own dedicated ServiceAccount/Role/RoleBinding (+ ClusterRole/Binding for a ClusterIssuer) — `kubectl wait`s for the chart-managed Issuer and the cert-manager-ingress-shim-created Certificate (`<fullname>-tls`) to reach Ready. New `.github/workflows/helm.yml` + `Taskfile.yml` `helm:validate` kubeconform step validates `examples/values-cloud-native.yaml` with `-skip CustomResourceDefinition` (cert-manager ships its CRDs as regular templates, unlike ingress-nginx/traefik's Helm `crds/` directory convention which `helm template` never renders). `templates/NOTES.txt` now prints a Public URL line (`admin.appBaseUrl` when set, else constructed from `shipwright.publicScheme`/`publicHost`), one line per bundled optional subchart (ingress-nginx/traefik/cert-manager), and a Let's Encrypt STAGING warning when `tls.certManager.issuer.server` points at the ACME staging endpoint. New `tests/cloud_native_profile_test.yaml` (helm-unittest) asserts, per profile: Ingress `spec.tls` (nginx only), the cert-manager bootstrap Job (nginx only), the bundled controller Deployment renders, no inline Issuer/Certificate document, `ingressClassName` matches the bundled class, and the new test hooks' gating.
### Fixed

- Bundled Traefik profile routed nothing (every request through the bundled controller 404'd, failing the CNH-8.1 `helm test` traefik block): the traefik subchart names its IngressClass after the release fullname (`<release>-traefik`) by default, while this chart's Ingress carries `ingressClassName: traefik` — and Traefik's ingress provider silently skips an Ingress whose explicit `ingressClassName` matches no IngressClass by exact name. `values.yaml` now pins `traefik.ingressClass.name: traefik` so the bundled subchart and the umbrella Ingress agree out of the box; `tests/cloud_native_profile_test.yaml` asserts the subchart's IngressClass name with only the profile's own values (no explicit override).

## [1.17.7] - 2026-08-27

### Changed

- auto-bump to chart v1.17.7 triggered by release tag(s): `admin-v1.96.0`, `agent-v1.195.0`, `chat-v1.51.0`, `metrics-v1.54.0`, `task-store-v1.76.0`

## [1.17.6] - 2026-08-27

### Added

- Add a DB-aware readinessProbe (`/health/ready`) for task-store — backed by a lightweight `SELECT 1` — so Kubernetes no longer routes traffic to a task-store pod before Postgres is reachable. `livenessProbe` is unchanged and stays on `/health` (DB-independent), matching the admin liveness/readiness split. Also raises the readinessProbe `successThreshold` to 2 to prevent a single-lucky-probe premature Ready flip during pod initialization (mirroring PLR-1.2's admin fix).

## [1.17.5] - 2026-08-27

### Changed

- auto-bump to chart v1.17.5 triggered by release tag(s): `agent-v1.194.0`

## [1.17.4] - 2026-08-27

### Changed

- auto-bump to chart v1.17.4 triggered by release tag(s): `agent-v1.193.0`

## [1.17.3] - 2026-08-27

### Changed

- auto-bump to chart v1.17.3 triggered by release tag(s): `agent-v1.192.0`

## [1.17.2] - 2026-08-27

### Changed

- auto-bump to chart v1.17.2 triggered by release tag(s): `agent-v1.191.0`

## [1.17.1] - 2026-08-26

### Changed

- auto-bump to chart v1.17.1 triggered by release tag(s): `agent-v1.190.0`

## [1.17.0] - 2026-08-26

### Added

- cert-manager bootstrap hook for the bundled cert-manager path (CNH-7.1): when cert-manager is bundled in the same release (`cert-manager.enabled=true`), its CRDs are templates in this release and do not exist at first-install apply time, so the chart-managed Issuer/Certificate can no longer be plain inline manifests. New `templates/cert-manager-bootstrap-job.yaml` ships a ConfigMap `<fullname>-cert-manager-bootstrap` (`10-issuer.yaml` if `issuer.create`, `20-certificate.yaml` if `networking.type=gateway` — both from the existing `shipwright.certManager.issuerManifest`/`certificateManifest` helpers) applied by a `post-install,post-upgrade` Job (`hook-weight` `"10"`, after cert-manager's `startupapicheck` at `1` and `db-bootstrap` at `-5`, `hook-delete-policy` `before-hook-creation,hook-succeeded`) whose initContainer `kubectl wait`s for the cert-manager/webhook/cainjector Deployments to be `Available` (300s timeout) before the main container `kubectl apply --server-side --field-manager=shipwright-chart --force-conflicts`s the ConfigMap. A pre-delete cleanup Job (`tls.certManager.bootstrap.cleanupOnDelete`, default `true`) deletes the applied CRs on uninstall, intentionally keeping the issued TLS Secret and ACME account Secret. New `templates/cert-manager-bootstrap-rbac.yaml` adds the ServiceAccount/Role/RoleBinding (regular, non-hook resources so the token survives upgrades) plus a ClusterRole/Binding only when `issuer.kind=ClusterIssuer`. `templates/cert-manager-issuer.yaml` and `templates/certificate.yaml` now render nothing when the new `shipwright.certManager.viaHook` guard is true, so this is the sole render path for those CRs in the bundled-cert-manager case; `helm template` output with default values is byte-identical to before this change.

## [1.16.3] - 2026-08-26

### Changed

- auto-bump to chart v1.16.3 triggered by release tag(s): `agent-v1.189.0`

## [1.16.2] - 2026-08-26

### Changed

- auto-bump to chart v1.16.2 triggered by release tag(s): `agent-v1.188.0`

## [1.16.1] - 2026-08-26

### Changed

- auto-bump to chart v1.16.1 triggered by release tag(s): `agent-v1.187.0`

## [1.16.0] - 2026-08-26

### Added

- Bundle optional ingress-nginx/traefik/cert-manager subcharts, default off (CNH-6.1): `Chart.yaml` grows three new dependencies alongside the existing `postgresql` one — `ingress-nginx` (`4.15.1`, `https://kubernetes.github.io/ingress-nginx`, condition `ingress-nginx.enabled`), `traefik` (`41.3.0`, `https://traefik.github.io/charts`, condition `traefik.enabled`), and `cert-manager` (`v1.21.1`, `https://charts.jetstack.io`, condition `cert-manager.enabled`) — each vendored as a `.tgz` under `charts/shipwright/charts/` with `Chart.lock` pinning exact versions (no ranges, matching the existing `postgresql` pin discipline). All three default to disabled (`values.yaml` top-level `ingress-nginx.enabled` / `traefik.enabled` / `cert-manager.enabled: false`), so `helm template` output with default values is byte-identical to before this change (aside from chart-version-tagged labels and randomly-generated Secret material, as with prior additive releases). `values.yaml` also sets `ingress-nginx.controller.admissionWebhooks.enabled=false` (the admission webhook path installs a Job that must reach a running Kubernetes API server at install time — unsafe to force on by default) and, within the `cert-manager:` block, `crds.enabled=true` / `crds.keep=true` / `startupapicheck.enabled=true` (enabling `cert-manager.enabled=true` renders the CRDs inline, per the jetstack chart's v1.15+ convention of an in-chart `crds.enabled` flag rather than a separate CRD chart; `crds.keep=true` preserves cert-manager's CRDs — and any Certificates/Issuers depending on them — across `helm uninstall`). `traefik.enabled` here is the Chart.yaml dependency-condition flag (whether the subchart is installed at all) and is unrelated to the pre-existing `networking.ingress.controller=traefik` dialect selector in `templates/ingress.yaml` — bundling AND selecting Traefik end-to-end requires setting both. `values.schema.json` documents the three new hyphenated top-level keys (`"ingress-nginx"`, `"traefik"`, `"cert-manager"`) with loose (`additionalProperties: true`) `enabled`-focused shapes, matching the existing `postgresql` entry's documentary style — these are not meant to fully validate the upstream subcharts' own schemas, which the subcharts enforce themselves via their own vendored `values.schema.json` (traefik and cert-manager's root schemas are strict `additionalProperties: false`, so `values.yaml`'s defaults were verified against the real upstream schema/keys before being added). New `templates/_validation.tpl` check (item 6, `shipwright.validate`, invoked from `NOTES.txt`): `ingress-nginx.enabled=true` together with `traefik.enabled=true` fails the render — two bundled ingress controller subcharts installed simultaneously is almost certainly unintentional and would deploy two competing controllers into the same cluster; this is a distinct, independent check from the pre-existing controller-dialect contradiction checks (1/2/4), which cover `networking.ingress.controller`/`className` mismatches, not subchart bundling. New `tests/bundled_subcharts_test.yaml` (helm-unittest) covers the enabled/disabled render matrix for each subchart's key resource (ingress-nginx's `controller-deployment.yaml`, traefik's `deployment.yaml`, cert-manager's Certificate CRD template) via `documentSelector`/`skipEmptyTemplates` for the disabled case (mirroring the PostgreSQL subchart's existing test pattern) plus the new both-bundled-controllers validation failure. `tests/ingress_traefik_test.yaml` grows a case asserting the bundled traefik subchart's own `IngressClass` (name pinned via `traefik.ingressClass.name`, since the subchart's own IngressClass otherwise defaults to the release fullname, not `"traefik"`) and this chart's own Ingress `spec.ingressClassName` resolve to the same effective class name when `networking.ingress.controller=traefik` — proving the independently-wired subchart-bundling and dialect-selection pieces agree, without adding any new render helper. New `examples/values-cloud-native.yaml` demonstrates a fully self-contained install (bundled `ingress-nginx` + `cert-manager`, no external ingress controller or cert-manager dependency); `examples/values-cloud-native-traefik.yaml` is extended to also set `traefik.enabled: true`, bundling the Traefik subchart itself rather than assuming an externally-installed Traefik (its existing controller-dialect/TLS/task-store-exposure configuration is unchanged). Both example files pass `helm lint -f <file>` cleanly, proving `values.yaml`'s new defaults use only real subchart keys. `ct.yaml` gains `helm-extra-args: [--timeout, 600s]` since cert-manager's `startupapicheck` (a post-install readiness Job) can exceed Helm's default install timeout on CI's kind cluster once these subcharts are exercised. `charts/shipwright/CONTRIBUTING.md` documents the subchart-pin-bump procedure (how to re-verify and bump a vendored subchart's exact version, run `helm dependency update`, and commit the regenerated `Chart.lock`/`.tgz` files) for future maintenance of all four now-vendored dependencies.

## [1.15.0] - 2026-08-26

### Added

- Chart-created cert-manager Issuer for external cert-manager (CNH-5.1): implements the body of `shipwright.certManager.issuerManifest` (declared as unused groundwork in CNH-2.1) and adds a new `templates/cert-manager-issuer.yaml` that renders it when `shipwright.certManager.createIssuer` is true — i.e. `tls.certManager.issuer.create=true` AND no explicit `tls.certManager.issuerRef.name` is set (an explicit `issuerRef.name` always means bring-your-own-Issuer and suppresses chart-managed creation, even if `issuer.create` is also true; `shipwright.certManager.createIssuer` itself is fixed to account for this — previously it ignored `issuerRef.name` entirely). `issuer.type=letsencrypt` (default) renders `spec.acme.{email (required, enforced by the existing shipwright.validate check — now also invoked from this new template), server, privateKeySecretRef.name: <issuer>-acme-account, solvers[0].http01.ingress.ingressClassName: <effective ingress class via shipwright.ingress.className>}`; `server` defaults to the Let's Encrypt production endpoint when unset. `issuer.type=selfsigned` (new) renders `spec.selfSigned: {}` with no ACME block. Kind `Issuer` (the new default, changed from `ClusterIssuer`) renders an explicit `metadata.namespace: <release namespace>`; `ClusterIssuer` renders none. Name is always `<fullname>-issuer`. `values.schema.json`'s `tls.certManager.issuer.type` enum grows `"selfsigned"` alongside `"letsencrypt"`. New `tests/cert_manager_issuer_test.yaml` (helm-unittest) covers the letsencrypt/selfsigned/Issuer/ClusterIssuer matrix, the missing-email failure, `issuerRef.name` suppressing creation, and — as a forward-compat guard for CNH-7.1 — that `tls.certManager.enabled=true` alone (without `issuer.create`) renders nothing. Manually verified against the datreeio `cert-manager.io/{issuer,clusterissuer}_v1.json` schemas via kubeconform. No render-output change for existing users: default `tls.certManager.issuer.create=false` means this template never renders (`helm template` output is byte-identical, aside from chart-version-tagged labels and randomly-generated Secret material unrelated to this change).

## [1.14.0] - 2026-08-25

### Added

- Traefik ingress controller support (CNH-4.1): `templates/ingress.yaml` grows a traefik dialect branch (guarded on `shipwright.bundled.traefik`, nothing changes for `controller=nginx`) adding `traefik.ingress.kubernetes.io/router.entrypoints` (`websecure` when TLS is on, else `web`, using the configurable `networking.ingress.traefik.entrypoints` names), `router.tls: "true"` when TLS is on, and `router.middlewares` (`<ns>-<fullname>-task-store-strip@kubernetescrd`) when the task-store route is exposed; traefik paths are always plain `Prefix` (`/dashboard`, the configured `taskStore.expose.pathPrefix`, `/`) with no capture-group regex and no `nginx.ingress.kubernetes.io/rewrite-target` annotation, since prefix-stripping is delegated to a Middleware instead. New `templates/ingress-traefik-middleware.yaml` renders a StripPrefix Middleware (`<fullname>-task-store-strip`) when task-store is exposed and a redirectScheme Middleware (`<fullname>-redirect-https`) when TLS + redirect are on, both `traefik.io/v1alpha1` and controller-gated. New `templates/ingress-http-redirect.yaml` renders a separate plain-HTTP Ingress (`<fullname>-http-redirect`, no `spec.tls`, entrypoint `web`) bound to the redirect-https Middleware, needed because a TLS-enabled Ingress is a TLS-only router in Traefik's model. New `tests/ingress_traefik_test.yaml` and `tests/ingress_traefik_middleware_test.yaml` (helm-unittest) cover the full traefik x {TLS off/on} x {task-store exposed off/on} matrix plus the zero-render cases for nginx/ClusterIP. New `examples/values-cloud-native-traefik.yaml` plus a matching kubeconform CI step (`.github/workflows/helm.yml`) and `Taskfile.yml` `helm:validate` command validate the `traefik.io/v1alpha1` Middleware CRD schema via the existing datreeio CRDs-catalog schema-location. No `values.yaml`/`values.schema.json` changes — this consumes `controller`/`tls`/`traefik.entrypoints` keys already added in CNH-2.1/CNH-3.1. Default-values (nginx) render output is unchanged.

## [1.13.1] - 2026-08-25

### Added

- Wire ingress TLS + cert-manager ingress-shim (nginx) into `templates/ingress.yaml` (CNH-3.1): renders `spec.tls: [{hosts: [host], secretName: <fullname>-tls | override}]` when `networking.ingress.tls.enabled` or `tls.certManager.enabled` is set; adds the `nginx.ingress.kubernetes.io/ssl-redirect: "true"` annotation when TLS is on, `networking.ingress.tls.redirect` is true, and the controller is nginx; adds the cert-manager ingress-shim annotation (`cert-manager.io/issuer` or `cert-manager.io/cluster-issuer`, controller-agnostic) keyed by the effective issuer kind/name (`shipwright.certManager.issuerName`/`issuerKind`) when `tls.certManager.enabled=true`. No chart-rendered Certificate CR on the ingress path — cert-manager itself watches the annotations, so TLS works on first install regardless of cert-manager readiness. Broadened `shipwright.ingress.tlsEnabled` (`_helpers.tpl`) to `networking.ingress.tls.enabled OR tls.certManager.enabled`; this helper had no callers before this change. Existing plain-HTTP Ingress output (nginx, TLS off) is unchanged — the annotations-block predicate keeps `networking.ingress.annotations`/task-store-exposure as its first two disjuncts.

## [1.13.0] - 2026-08-25

### Added

- Ingress TLS/cert-manager helpers, validation, and values/schema groundwork (CNH-2.1): new `templates/_validation.tpl` (`shipwright.validate`, invoked from `NOTES.txt`) catching contradictory bundled-ingress-controller config, a `className`/`controller` mismatch, and a missing Let's Encrypt issuer email; new `_helpers.tpl` entries (`shipwright.bundled.*`, `shipwright.bundledIngressClass`, `shipwright.ingress.{className,controller,tlsEnabled,tlsSecretName}`, `shipwright.publicHost`, `shipwright.publicScheme`, `shipwright.certManager.{issuerName,issuerKind,createIssuer,viaHook,issuerManifest,certificateManifest}`); new `values.yaml` keys `networking.ingress.{controller,tls.{enabled,secretName,redirect},traefik.entrypoints.{web,websecure}}` and `tls.certManager.issuer.{create,kind,type,email,server}`, extended additively into `values.schema.json` (`additionalProperties: false` preserved); the root cross-field schema guard is relaxed from `networking.type const gateway` to `enum [ingress, gateway]` when `tls.certManager.enabled=true`, and the `tls.certManager` guard now accepts either `issuerRef.name` or `issuer.create: true`. `templates/certificate.yaml`'s body moved into the new `shipwright.certManager.certificateManifest` helper — no render-output change for existing Gateway users. This is groundwork only: nothing new is wired into `templates/ingress.yaml` yet.

## [1.12.32] - 2026-08-25

### Changed

- default the bundled PostgreSQL image to the bitnamilegacy mirror so a fresh install with default values pulls successfully

## [1.12.31] - 2026-08-25

### Changed

- auto-bump to chart v1.12.31 triggered by release tag(s): `agent-v1.186.0`

## [1.12.30] - 2026-08-25

### Changed

- auto-bump to chart v1.12.30 triggered by release tag(s): `agent-v1.185.0`

## [1.12.29] - 2026-08-25

### Changed

- auto-bump to chart v1.12.29 triggered by release tag(s): `admin-v1.95.0`

## [1.12.28] - 2026-08-25

### Changed

- auto-bump to chart v1.12.28 triggered by release tag(s): `agent-v1.184.0`

## [1.12.27] - 2026-08-25

### Changed

- auto-bump to chart v1.12.27 triggered by release tag(s): `agent-v1.183.2`

## [1.12.26] - 2026-08-24

### Changed

- auto-bump to chart v1.12.26 triggered by release tag(s): `admin-v1.94.0`, `agent-v1.183.1`, `chat-v1.50.0`, `metrics-v1.53.0`, `task-store-v1.75.0`

## [1.12.25] - 2026-08-22

### Changed

- auto-bump to chart v1.12.25 triggered by release tag(s): `agent-v1.183.0`

## [1.12.24] - 2026-08-22

### Changed

- auto-bump to chart v1.12.24 triggered by release tag(s): `agent-v1.182.0`

## [1.12.23] - 2026-08-22

### Changed

- auto-bump to chart v1.12.23 triggered by release tag(s): `agent-v1.181.0`

## [1.12.22] - 2026-08-22

### Changed

- auto-bump to chart v1.12.22 triggered by release tag(s): `admin-v1.93.0`, `agent-v1.180.0`, `chat-v1.49.0`, `metrics-v1.52.0`, `task-store-v1.74.0`

## [1.12.21] - 2026-08-22

### Changed

- auto-bump to chart v1.12.21 triggered by release tag(s): `agent-v1.179.0`

## [1.12.20] - 2026-08-22

### Changed

- auto-bump to chart v1.12.20 triggered by release tag(s): `admin-v1.92.2`, `agent-v1.178.0`, `chat-v1.48.0`, `metrics-v1.51.0`, `task-store-v1.73.0`

## [1.12.19] - 2026-08-21

### Fixed

- `admin-secret.yaml` now generates `SHIPWRIGHT_ENCRYPTION_KEY` as a 64-char-hex string (`randAlphaNum 32 | sha256sum | b64enc`) so admin's AES-256-GCM encryption doesn't fail with "Invalid key length"

## [1.12.18] - 2026-08-21

### Changed

- auto-bump to chart v1.12.18 triggered by release tag(s): `admin-v1.92.1`

## [1.12.17] - 2026-08-21

### Changed

- auto-bump to chart v1.12.17 triggered by release tag(s): `admin-v1.92.0`

## [1.12.16] - 2026-08-21

### Changed

- auto-bump to chart v1.12.16 triggered by release tag(s): `admin-v1.91.0`

## [1.12.15] - 2026-08-21

### Changed

- auto-bump to chart v1.12.15 triggered by release tag(s): `admin-v1.90.1`, `chat-v1.47.0`, `metrics-v1.50.0`, `task-store-v1.72.0`

## [1.12.14] - 2026-08-21

### Changed

- auto-bump to chart v1.12.14 triggered by release tag(s): `admin-v1.90.0`

## [1.12.13] - 2026-08-21

### Changed

- auto-bump to chart v1.12.13 triggered by release tag(s): `agent-v1.177.0`

## [1.12.12] - 2026-08-21

### Changed

- auto-bump to chart v1.12.12 triggered by release tag(s): `admin-v1.89.0`, `agent-v1.177.0`

## [1.12.11] - 2026-08-21

### Changed

- auto-bump to chart v1.12.11 triggered by release tag(s): `agent-v1.176.0`

## [1.12.10] - 2026-08-21

### Changed

- auto-bump to chart v1.12.10 triggered by release tag(s): `admin-v1.88.0`, `agent-v1.175.1`, `chat-v1.46.0`, `metrics-v1.49.0`, `task-store-v1.71.0`

## [1.12.9] - 2026-08-21

### Changed

- auto-bump to chart v1.12.9 triggered by release tag(s): `agent-v1.175.0`

## [1.12.8] - 2026-08-21

### Changed

- auto-bump to chart v1.12.8 triggered by release tag(s): `agent-v1.174.0`

## [1.12.7] - 2026-08-20

### Changed

- auto-bump to chart v1.12.7 triggered by release tag(s): `admin-v1.87.0`

## [1.12.6] - 2026-08-20

### Changed

- auto-bump to chart v1.12.6 triggered by release tag(s): `admin-v1.86.0`, `agent-v1.173.1`, `chat-v1.45.0`, `metrics-v1.48.0`, `task-store-v1.70.0`

## [1.12.5] - 2026-08-20

### Changed

- auto-bump to chart v1.12.5 triggered by release tag(s): `agent-v1.173.0`

## [1.12.4] - 2026-08-20

### Changed

- auto-bump to chart v1.12.4 triggered by release tag(s): `agent-v1.172.1`

## [1.12.3] - 2026-08-20

### Changed

- auto-bump to chart v1.12.3 triggered by release tag(s): `task-store-v1.69.1`

## [1.12.2] - 2026-08-20

### Changed

- auto-bump to chart v1.12.2 triggered by release tag(s): `admin-v1.85.1`

## [1.12.1] - 2026-08-20

### Changed

- auto-bump to chart v1.12.1 triggered by release tag(s): `admin-v1.84.0`, `admin-v1.85.0`, `agent-v1.171.0`, `agent-v1.172.0`, `chat-v1.43.0`, `chat-v1.44.0`, `metrics-v1.46.0`, `metrics-v1.47.0`, `task-store-v1.68.0`, `task-store-v1.69.0`

## [1.12.0] - 2026-08-20

### Added

- `auth.mode=okta` — Okta OIDC **chart-side plumbing** mirroring `auth.mode=google`
  (new `auth.okta.*` values block with `existingSecret` support, `values.schema.json`
  enum + conditional required fields, `OKTA_ISSUER`/`OKTA_CLIENT_ID`/
  `OKTA_CLIENT_SECRET`/`SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` wiring in the admin
  Secret and Deployment, and `NOTES.txt` messaging). ⚠️ Chart-only — the admin
  application does not yet implement Okta OIDC login; `auth.mode=okta` will
  lock deployers out of the admin UI until application-side support ships.
  Use `auth.mode=google` for a working production login today.

## [1.11.64] - 2026-08-19

### Changed

- auto-bump to chart v1.11.64 triggered by release tag(s): `agent-v1.170.0`

## [1.11.63] - 2026-08-18

### Changed

- auto-bump to chart v1.11.63 triggered by release tag(s): `agent-v1.166.0`

## [1.11.62] - 2026-08-18

### Changed

- auto-bump to chart v1.11.62 triggered by release tag(s): `agent-v1.165.0`

## [1.11.61] - 2026-08-18

### Changed

- auto-bump to chart v1.11.61 triggered by release tag(s): `agent-v1.164.0`

## [1.11.60] - 2026-08-18

### Changed

- auto-bump to chart v1.11.60 triggered by release tag(s): `task-store-v1.64.0`

## [1.11.59] - 2026-08-18

### Changed

- auto-bump to chart v1.11.59 triggered by release tag(s): `admin-v1.81.0`, `agent-v1.163.0`

## [1.11.57] - 2026-08-18

### Changed

- auto-bump to chart v1.11.57 triggered by release tag(s): `task-store-v1.63.0`

## [1.11.56] - 2026-08-17

### Changed

- auto-bump to chart v1.11.56 triggered by release tag(s): `task-store-v1.62.0`

## [1.11.55] - 2026-08-17

### Fixed

- `auth.mode=open`/`none` deployments no longer have dev auth blocked by the admin image's baked-in `NODE_ENV=production` default — set explicitly in `admin-deployment.yaml`

## [1.11.54] - 2026-08-15

### Changed

- auto-bump to chart v1.11.54 triggered by release tag(s): `admin-v1.80.0`, `agent-v1.162.0`, `chat-v1.40.0`, `metrics-v1.43.0`, `task-store-v1.61.0`

## [1.11.53] - 2026-08-15

### Changed

- auto-bump to chart v1.11.53 triggered by release tag(s): `agent-v1.161.0`

## [1.11.52] - 2026-08-15

### Changed

- auto-bump to chart v1.11.52 triggered by release tag(s): `admin-v1.79.0`, `agent-v1.160.0`, `chat-v1.39.0`, `metrics-v1.42.0`, `task-store-v1.60.0`

## [1.11.51] - 2026-08-15

### Changed

- auto-bump to chart v1.11.51 triggered by release tag(s): `admin-v1.78.0`, `agent-v1.159.0`, `chat-v1.38.0`, `metrics-v1.41.0`, `task-store-v1.59.0`

## [1.11.50] - 2026-08-15

### Changed

- auto-bump to chart v1.11.50 triggered by release tag(s): `agent-v1.158.0`

## [1.11.49] - 2026-08-15

### Changed

- auto-bump to chart v1.11.49 triggered by release tag(s): `agent-v1.157.0`

## [1.11.48] - 2026-08-15

### Changed

- auto-bump to chart v1.11.48 triggered by release tag(s): `agent-v1.156.1`

## [1.11.47] - 2026-08-15

### Changed

- auto-bump to chart v1.11.47 triggered by release tag(s): `admin-v1.77.0`, `agent-v1.156.0`, `chat-v1.37.0`, `metrics-v1.40.0`, `task-store-v1.58.0`

## [1.11.46] - 2026-08-14

### Changed

- auto-bump to chart v1.11.46 triggered by release tag(s): `admin-v1.76.0`, `agent-v1.155.0`, `chat-v1.36.0`, `metrics-v1.39.0`, `task-store-v1.57.0`

## [1.11.45] - 2026-08-14

### Changed

- auto-bump to chart v1.11.45 triggered by release tag(s): `agent-v1.154.0`

## [1.11.44] - 2026-08-14

### Changed

- auto-bump to chart v1.11.44 triggered by release tag(s): `agent-v1.153.0`

## [1.11.43] - 2026-08-14

### Changed

- auto-bump to chart v1.11.43 triggered by release tag(s): `agent-v1.152.2`

## [1.11.42] - 2026-08-14

### Changed

- auto-bump to chart v1.11.42 triggered by release tag(s): `agent-v1.152.1`

## [1.11.41] - 2026-08-13

### Changed

- auto-bump to chart v1.11.41 triggered by release tag(s): `admin-v1.75.0`, `agent-v1.152.0`, `chat-v1.35.0`, `metrics-v1.38.0`, `task-store-v1.56.0`

## [1.11.40] - 2026-08-13

### Changed

- auto-bump to chart v1.11.40 triggered by release tag(s): `agent-v1.151.0`

## [1.11.39] - 2026-08-13

### Added

- `mcpServer.*` renders the mcp-server Deployment/Service/ServiceAccount (TSM-3.2), mirroring task-store. Disabled by default (`mcpServer.enabled=false`) — safe to merge, changes nothing in any live cluster. Both `SHIPWRIGHT_MCP_SERVER_TOKEN` and `SHIPWRIGHT_TASK_STORE_TOKEN` are always sourced via `secretKeyRef` from `mcpServer.auth.existingSecret`, never plaintext env

## [1.11.38] - 2026-08-13

### Changed

- auto-bump to chart v1.11.38 triggered by release tag(s): `admin-v1.74.0`, `agent-v1.150.0`, `chat-v1.34.0`, `metrics-v1.37.0`, `task-store-v1.55.0`

## [1.11.37] - 2026-08-13

### Changed

- auto-bump to chart v1.11.37 triggered by release tag(s): `agent-v1.149.0`

## [1.11.36] - 2026-08-13

### Changed

- auto-bump to chart v1.11.36 triggered by release tag(s): `agent-v1.148.0`

## [1.11.35] - 2026-08-13

### Changed

- auto-bump to chart v1.11.35 triggered by release tag(s): `agent-v1.147.3`

## [1.11.34] - 2026-08-13

### Changed

- auto-bump to chart v1.11.34 triggered by release tag(s): `agent-v1.147.2`

## [1.11.33] - 2026-08-12

### Changed

- auto-bump to chart v1.11.33 triggered by release tag(s): `agent-v1.147.1`

## [1.11.31] - 2026-08-12

### Changed

- auto-bump to chart v1.11.31 triggered by release tag(s): `agent-v1.147.0`

## [1.11.30] - 2026-08-12

### Changed

- auto-bump to chart v1.11.30 triggered by release tag(s): `agent-v1.146.0`

## [1.11.29] - 2026-08-12

### Changed

- auto-bump to chart v1.11.29 triggered by release tag(s): `agent-v1.145.0`

## [1.11.28] - 2026-08-12

### Changed

- auto-bump to chart v1.11.28 triggered by release tag(s): `agent-v1.144.0`

## [1.11.27] - 2026-08-12

### Changed

- auto-bump to chart v1.11.27 triggered by release tag(s): `agent-v1.143.2`

## [1.11.26] - 2026-08-12

### Changed

- auto-bump to chart v1.11.26 triggered by release tag(s): `agent-v1.143.1`

## [1.11.25] - 2026-08-12

### Changed

- auto-bump to chart v1.11.25 triggered by release tag(s): `agent-v1.143.0`

## [1.11.24] - 2026-08-11

### Changed

- auto-bump to chart v1.11.24 triggered by release tag(s): `task-store-v1.54.0`

## [1.11.23] - 2026-08-11

### Changed

- auto-bump to chart v1.11.23 triggered by release tag(s): `agent-v1.142.0`

## [1.11.22] - 2026-08-11

### Changed

- auto-bump to chart v1.11.22 triggered by release tag(s): `admin-v1.71.0`

## [1.11.21] - 2026-08-11

### Changed

- auto-bump to chart v1.11.21 triggered by release tag(s): `task-store-v1.51.0`

## [1.11.20] - 2026-08-11

### Changed

- auto-bump to chart v1.11.20 triggered by release tag(s): `task-store-v1.50.0`

## [1.11.19] - 2026-08-11

### Changed

- auto-bump to chart v1.11.19 triggered by release tag(s): `admin-v1.70.0`, `agent-v1.138.0`

## [1.11.18] - 2026-08-10

### Changed

- auto-bump to chart v1.11.18 triggered by release tag(s): `agent-v1.136.4`

## [1.11.17] - 2026-08-10

### Changed

- auto-bump to chart v1.11.17 triggered by release tag(s): `admin-v1.69.1`, `agent-v1.136.3`, `chat-v1.31.1`, `metrics-v1.34.1`, `task-store-v1.49.2`

## [1.11.16] - 2026-08-10

### Changed

- auto-bump to chart v1.11.16 triggered by release tag(s): `admin-v1.69.0`, `agent-v1.136.2`, `chat-v1.31.0`, `metrics-v1.34.0`, `task-store-v1.49.1`

## [1.11.15] - 2026-08-10

### Changed

- auto-bump to chart v1.11.15 triggered by release tag(s): `agent-v1.136.1`

## [1.11.14] - 2026-08-10

### Changed

- auto-bump to chart v1.11.14 triggered by release tag(s): `task-store-v1.49.0`

## [1.11.13] - 2026-08-09

### Changed

- auto-bump to chart v1.11.13 triggered by release tag(s): `agent-v1.136.0`

## [1.11.12] - 2026-08-09

### Changed

- auto-bump to chart v1.11.12 triggered by release tag(s): `agent-v1.135.0`

## [1.11.11] - 2026-08-09

### Changed

- auto-bump to chart v1.11.11 triggered by release tag(s): `task-store-v1.48.0`

## [1.11.10] - 2026-08-09

### Changed

- auto-bump to chart v1.11.10 triggered by release tag(s): `agent-v1.134.0`

## [1.11.9] - 2026-08-09

### Changed

- auto-bump to chart v1.11.9 triggered by release tag(s): `agent-v1.133.0`

## [1.11.8] - 2026-08-09

### Changed

- auto-bump to chart v1.11.8 triggered by release tag(s): `agent-v1.132.2`

## [1.11.7] - 2026-08-09

### Changed

- auto-bump to chart v1.11.7 triggered by release tag(s): `admin-v1.68.0`, `agent-v1.132.1`, `chat-v1.30.0`, `metrics-v1.33.0`, `task-store-v1.47.1`

## [1.11.6] - 2026-08-09

### Changed

- auto-bump to chart v1.11.6 triggered by release tag(s): `agent-v1.132.0`, `task-store-v1.47.0`

## [1.11.5] - 2026-08-08

### Changed

- auto-bump to chart v1.11.5 triggered by release tag(s): `admin-v1.67.0`, `agent-v1.131.0`, `chat-v1.29.0`, `metrics-v1.32.0`, `task-store-v1.46.0`

## [1.11.4] - 2026-08-08

### Changed

- auto-bump to chart v1.11.4 triggered by release tag(s): `task-store-v1.45.1`

## [1.11.3] - 2026-08-08

### Changed

- auto-bump to chart v1.11.3 triggered by release tag(s): `admin-v1.66.0`, `agent-v1.130.0`, `chat-v1.28.0`, `metrics-v1.31.0`, `task-store-v1.45.0`

## [1.11.2] - 2026-08-08

### Added

- **`examples/values-minikube.yaml`** — the full local stack in one values file:
  admin + metrics + task-store + chat + bundled PostgreSQL + runtime agent
  provisioning, with **no hand-created Secrets**. Paired with `task minikube:up` /
  `task minikube:down` in the repo root, which handle the four ordering traps
  (VM sizing, ingress addon before install, `helm dependency build` before
  install, `/etc/hosts` after the VM has an IP).
- **`helm test` now covers task-store and chat `/health`.** These are the checks
  that actually prove the chart-managed database wiring worked — both services run
  `prisma migrate deploy` as a boot preflight and refuse to serve if their database
  is missing or unmigrated, so a green `helm test` means the databases exist and
  are reachable.

### Changed

- **NOTES.txt and README corrected.** Both claimed "the agent workload is added in
  a later task and is NOT yet rendered", and NOTES advertised an agent service port
  that nothing listens on. Agents are provisioned at runtime by the admin service
  and are not a chart Deployment; NOTES now says so and points at
  `/admin/agents/new`, warning when no deployment-wide Claude credential is set.
- NOTES lists task-store and chat ports and access lines when those are enabled,
  and no longer claims an unset `METRICS_DATABASE_URL` falls back to a working
  local SQLite store (it crashes on boot with `SQLITE_CANTOPEN`).
- `values.yaml` header no longer describes the chart as a skeleton whose workloads
  "land in a later task".

## [1.11.1] - 2026-08-08

### Changed

- auto-bump to chart v1.11.1 triggered by release tag(s): `admin-v1.65.1`

## [1.11.0] - 2026-08-08

### Removed

- **Reverted the inter-service token mesh (#2484) and deployment-wide Claude
  credentials (#2485).** Both broke the production Helm upgrade: `helm upgrade`
  failed patching `shipwright-admin`'s Deployment with a `$setElementOrder`
  conflict on its `env:` list, aborting the release mid-way and leaving
  `task-store` and `shipwright-admin` on split config generations. Task-store's
  scope-resolver calls to admin then failed against admin's stale credentials,
  forcing every agent-scoped token into the `repos: []` fail-safe
  (`scopeDegraded: true`) fleet-wide. Neither change had been validated against
  a real cluster before merging — see #2494 for the full incident writeup.
- All chart surface added by those two releases: `agent.credentials.*`,
  `internal.*`, the `agent-credentials-secret.yaml` / `internal-secret.yaml`
  templates, and the `*_AGENTS_URL` / `*_AGENTS_API_KEY` scope-resolver env
  vars on task-store/chat.

## [1.10.1] - 2026-08-07

### Changed

- auto-bump to chart v1.10.1 triggered by release tag(s): `admin-v1.65.0`

## [1.8.3] - 2026-08-07

### Changed

- auto-bump to chart v1.8.3 triggered by release tag(s): `agent-v1.129.0`

## [1.8.2] - 2026-08-07

### Changed

- auto-bump to chart v1.8.2 triggered by release tag(s): `task-store-v1.44.0`

## [1.8.1] - 2026-08-07

### Changed

- chart version bump to 1.8.1 — rebase past main's chart v1.8.0 (originally targeted 1.7.196, superseded by an intervening chart release)

## [1.8.0] - 2026-08-07

### Added

- **task-store and chat can use the bundled PostgreSQL.** Both previously required
  a hand-created Secret (default `shipwright-secrets`) holding their
  `DATABASE_URL_*`. Set `taskStore.database.existingSecret: ""` (or
  `chat.database.existingSecret: ""`) with `postgresql.enabled=true` and the chart
  now creates a dedicated database and assembles the connection string into its
  own Secret, matching how admin and metrics already worked.
- `taskStore.database.name` / `chat.database.name` — override the bundled database
  names (default `shipwright_task_store` / `shipwright_chat`). Each service keeps
  its **own** database; sharing one breaks `prisma migrate deploy` (Prisma P3005).
- `dbBootstrap` — a `post-install,post-upgrade` hook Job that ensures every
  per-service database exists. PostgreSQL runs `/docker-entrypoint-initdb.d`
  scripts **only** on the first boot of an empty volume, so the init path alone
  could never provision databases on an existing release. Disable with
  `dbBootstrap.enabled=false`.
- `wait-for-postgres` initContainer for task-store and chat, on the bundled path
  only (an external database is the operator's to make reachable).

### Fixed

- **Bundled-PostgreSQL password resolution.** `admin-secret.yaml` and
  `metrics-secret.yaml` looked the password up under a `postgresql-password` key.
  Bitnami postgresql 16.7.27 emits `postgres-password`, `password`,
  `replication-password` and `ldap-password` — never `postgresql-password` — so
  that branch could never fire and an install relying on an auto-generated
  password rendered an **empty-password DSN**. Corrected to `password`.
  **Upgrade note:** on any release that was relying on the broken fallback, the
  rendered DSN changes from empty-password to the real password, so the admin and
  metrics pods restart once on upgrade. This is the fix taking effect.

### Changed

- `templates/metrics-postgres-initdb-configmap.yaml` renamed to
  `templates/postgres-initdb-configmap.yaml` and now creates all three
  per-service databases. **The rendered ConfigMap name is unchanged**
  (`<release>-metrics-initdb`) — `values.yaml` references it statically via
  `postgresql.primary.initdb.scriptsConfigMap`, and renaming it would leave a
  dangling volume reference and a PostgreSQL pod that never starts. Its labels
  drop the `component: metrics` label, as it is no longer metrics-specific.
- Password/DSN assembly consolidated into shared `shipwright.postgresql.password`
  and `shipwright.postgresql.dsn` helpers.

### Compatibility

- **No defaults changed.** `taskStore.database.existingSecret` and
  `chat.database.existingSecret` still default to `"shipwright-secrets"`, so every
  existing install keeps its bring-your-own Secret path byte-for-byte. The
  bundled-database path is strictly opt-in.
- `taskStore.extraEnv` / `chat.extraEnv` still render **last**, so hand-wired
  overrides continue to win over anything the chart emits.

## [1.7.195] - 2026-08-07

### Changed

- auto-bump to chart v1.7.195 triggered by release tag(s): `agent-v1.125.0`

## [1.7.194] - 2026-08-07

### Changed

- auto-bump to chart v1.7.194 triggered by release tag(s): `agent-v1.124.3`

## [1.7.193] - 2026-08-07

### Changed

- auto-bump to chart v1.7.193 triggered by release tag(s): `agent-v1.124.2`

## [1.7.192] - 2026-08-05

### Changed

- auto-bump to chart v1.7.192 triggered by release tag(s): `agent-v1.124.1`

## [1.7.191] - 2026-08-05

### Changed

- auto-bump to chart v1.7.191 triggered by release tag(s): `agent-v1.124.0`

## [1.7.190] - 2026-08-04

### Changed

- auto-bump to chart v1.7.190 triggered by release tag(s): `agent-v1.123.0`

## [1.7.189] - 2026-08-04

### Changed

- auto-bump to chart v1.7.189 triggered by release tag(s): `agent-v1.122.2`

## [1.7.188] - 2026-08-01

### Changed

- auto-bump to chart v1.7.188 triggered by release tag(s): `admin-v1.62.0`

## [1.7.187] - 2026-08-01

### Changed

- auto-bump to chart v1.7.187 triggered by release tag(s): `agent-v1.121.0`

## [1.7.186] - 2026-08-01

### Changed

- auto-bump to chart v1.7.186 triggered by release tag(s): `agent-v1.120.0`

## [1.7.185] - 2026-08-01

### Changed

- auto-bump to chart v1.7.185 triggered by release tag(s): `agent-v1.119.0`

## [1.7.184] - 2026-08-01

### Changed

- auto-bump to chart v1.7.184 triggered by release tag(s): `agent-v1.118.0`

## [1.7.183] - 2026-07-31

### Changed

- auto-bump to chart v1.7.183 triggered by release tag(s): `agent-v1.117.0`

## [1.7.182] - 2026-07-31

### Changed

- auto-bump to chart v1.7.182 triggered by release tag(s): `admin-v1.61.0`

## [1.7.181] - 2026-07-31

### Changed

- auto-bump to chart v1.7.181 triggered by release tag(s): `admin-v1.60.0`, `chat-v1.25.0`, `metrics-v1.27.0`, `task-store-v1.41.0`

## [1.7.180] - 2026-07-31

### Changed

- auto-bump to chart v1.7.180 triggered by release tag(s): `task-store-v1.40.0`

## [1.7.179] - 2026-07-31

### Changed

- auto-bump to chart v1.7.179 triggered by release tag(s): `admin-v1.59.0`

## [1.7.178] - 2026-07-31

### Changed

- auto-bump to chart v1.7.178 triggered by release tag(s): `admin-v1.58.0`, `agent-v1.116.0`, `chat-v1.24.0`, `metrics-v1.26.0`, `task-store-v1.39.0`

## [1.7.177] - 2026-07-31

### Changed

- auto-bump to chart v1.7.177 triggered by release tag(s): `agent-v1.115.0`

## [1.7.176] - 2026-07-31

### Changed

- auto-bump to chart v1.7.176 triggered by release tag(s): `admin-v1.57.0`

## [1.7.175] - 2026-07-31

### Changed

- auto-bump to chart v1.7.175 triggered by release tag(s): `task-store-v1.38.0`

## [1.7.174] - 2026-07-31

### Changed

- auto-bump to chart v1.7.174 triggered by release tag(s): `task-store-v1.37.0`

## [1.7.173] - 2026-07-31

### Changed

- auto-bump to chart v1.7.173 triggered by release tag(s): `task-store-v1.36.0`

## [1.7.172] - 2026-07-31

### Changed

- auto-bump to chart v1.7.172 triggered by release tag(s): `admin-v1.56.0`

## [1.7.171] - 2026-07-31

### Changed

- auto-bump to chart v1.7.171 triggered by release tag(s): `agent-v1.114.0`

## [1.7.170] - 2026-07-31

### Changed

- auto-bump to chart v1.7.170 triggered by release tag(s): `agent-v1.113.0`

## [1.7.169] - 2026-07-31

### Changed

- auto-bump to chart v1.7.169 triggered by release tag(s): `task-store-v1.35.0`

## [1.7.168] - 2026-07-31

### Changed

- auto-bump to chart v1.7.168 triggered by release tag(s): `task-store-v1.34.0`

## [1.7.167] - 2026-07-31

### Changed

- auto-bump to chart v1.7.167 triggered by release tag(s): `agent-v1.112.1`

## [1.7.166] - 2026-07-30

### Fixed

- `agent.voice.provider` README row corrected: TTS defaults to self-hosted Piper (in-image), ElevenLabs is opt-in via `agent.voice.elevenlabs.apiKey`, not always-on.
- `agent.voice.whisper.image` README default corrected to `v1.3.0`, matching the pinned tag in `values.yaml`.
- Stale `values.yaml` inline comment claiming "TTS is always ElevenLabs" corrected to match actual dispatch order.

## [1.7.165] - 2026-07-30

### Changed

- auto-bump to chart v1.7.165 triggered by release tag(s): `agent-v1.112.0`

## [1.7.164] - 2026-07-29

### Changed

- auto-bump to chart v1.7.164 triggered by release tag(s): `admin-v1.55.0`, `agent-v1.111.0`, `chat-v1.23.0`, `metrics-v1.25.0`, `task-store-v1.33.0`

## [1.7.163] - 2026-07-29

### Changed

- auto-bump to chart v1.7.163 triggered by release tag(s): `agent-v1.110.0`

## [1.7.162] - 2026-07-29

### Changed

- auto-bump to chart v1.7.162 triggered by release tag(s): `agent-v1.109.0`

## [1.7.161] - 2026-07-29

### Changed

- auto-bump to chart v1.7.161 triggered by release tag(s): `agent-v1.108.1`

## [1.7.160] - 2026-07-29

### Changed

- auto-bump to chart v1.7.160 triggered by release tag(s): `agent-v1.108.0`

## [1.7.159] - 2026-07-29

### Changed

- auto-bump to chart v1.7.159 triggered by release tag(s): `task-store-v1.32.0`

## [1.7.158] - 2026-07-29

### Changed

- auto-bump to chart v1.7.158 triggered by release tag(s): `admin-v1.51.0`, `admin-v1.52.0`, `admin-v1.53.0`, `admin-v1.54.0`

## [1.7.157] - 2026-07-29

### Changed

- auto-bump to chart v1.7.157 triggered by release tag(s): `agent-v1.107.0`

## [1.7.156] - 2026-07-29

### Changed

- auto-bump to chart v1.7.156 triggered by release tag(s): `agent-v1.106.0`

## [1.7.155] - 2026-07-29

### Changed

- auto-bump to chart v1.7.155 triggered by release tag(s): `agent-v1.105.0`

## [1.7.154] - 2026-07-29

### Changed

- auto-bump to chart v1.7.154 triggered by release tag(s): `agent-v1.104.2`

## [1.7.153] - 2026-07-28

### Changed

- auto-bump to chart v1.7.153 triggered by release tag(s): `agent-v1.102.0`

## [1.7.152] - 2026-07-28

### Changed

- auto-bump to chart v1.7.152 triggered by release tag(s): `agent-v1.101.1`

## [1.7.151] - 2026-07-28

### Changed

- auto-bump to chart v1.7.151 triggered by release tag(s): `agent-v1.101.0`

## [1.7.150] - 2026-07-28

### Changed

- auto-bump to chart v1.7.150 triggered by release tag(s): `agent-v1.94.0`

## [1.7.149] - 2026-07-28

### Changed

- auto-bump to chart v1.7.149 triggered by release tag(s): `metrics-v1.21.0`

## [1.7.148] - 2026-07-28

### Changed

- auto-bump to chart v1.7.148 triggered by release tag(s): `admin-v1.50.0`, `chat-v1.19.0`, `metrics-v1.21.0`, `task-store-v1.28.0`

## [1.7.147] - 2026-07-28

### Changed

- auto-bump to chart v1.7.147 triggered by release tag(s): `agent-v1.93.1`

## [1.7.146] - 2026-07-28

### Changed

- auto-bump to chart v1.7.146 triggered by release tag(s): `agent-v1.93.0`

## [1.7.145] - 2026-07-28

### Changed

- auto-bump to chart v1.7.145 triggered by release tag(s): `agent-v1.92.0`

## [1.7.144] - 2026-07-28

### Changed

- auto-bump to chart v1.7.144 triggered by release tag(s): `agent-v1.91.0`

## [1.7.143] - 2026-07-28

### Changed

- auto-bump to chart v1.7.143 triggered by release tag(s): `admin-v1.49.1`, `agent-v1.90.2`, `chat-v1.18.0`, `metrics-v1.20.1`, `task-store-v1.27.0`

## [1.7.142] - 2026-07-28

### Changed

- auto-bump to chart v1.7.142 triggered by release tag(s): `metrics-v1.20.0`

## [1.7.141] - 2026-07-28

### Changed

- auto-bump to chart v1.7.141 triggered by release tag(s): `agent-v1.90.1`

## [1.7.140] - 2026-07-28

### Changed

- auto-bump to chart v1.7.140 triggered by release tag(s): `admin-v1.49.0`

## [1.7.139] - 2026-07-28

### Changed

- auto-bump to chart v1.7.139 triggered by release tag(s): `agent-v1.90.0`

## [1.7.138] - 2026-07-28

### Changed

- auto-bump to chart v1.7.138 triggered by release tag(s): `admin-v1.48.1`, `agent-v1.89.0`, `chat-v1.17.1`, `metrics-v1.19.1`, `task-store-v1.26.1`

## [1.7.137] - 2026-07-28

### Changed

- auto-bump to chart v1.7.137 triggered by release tag(s): `metrics-v1.19.0`

## [1.7.136] - 2026-07-28

### Changed

- auto-bump to chart v1.7.136 triggered by release tag(s): `admin-v1.47.1`

## [1.7.135] - 2026-07-28

### Changed

- auto-bump to chart v1.7.135 triggered by release tag(s): `admin-v1.47.0`, `agent-v1.88.1`, `chat-v1.16.0`, `metrics-v1.18.0`, `task-store-v1.25.0`

## [1.7.134] - 2026-07-28

### Changed

- auto-bump to chart v1.7.134 triggered by release tag(s): `agent-v1.88.0`

## [1.7.133] - 2026-07-28

### Changed

- auto-bump to chart v1.7.133 triggered by release tag(s): `agent-v1.87.0`

## [1.7.132] - 2026-07-28

### Changed

- auto-bump to chart v1.7.132 triggered by release tag(s): `admin-v1.46.0`, `agent-v1.86.0`, `chat-v1.15.0`, `metrics-v1.17.0`, `task-store-v1.24.0`

## [1.7.131] - 2026-07-28

### Changed

- auto-bump to chart v1.7.131 triggered by release tag(s): `agent-v1.85.0`

## [1.7.130] - 2026-07-28

### Changed

- auto-bump to chart v1.7.130 triggered by release tag(s): `agent-v1.84.0`

## [1.7.129] - 2026-07-27

### Changed

- auto-bump to chart v1.7.129 triggered by release tag(s): `admin-v1.45.0`, `agent-v1.83.0`

## [1.7.128] - 2026-07-27

### Changed

- auto-bump to chart v1.7.128 triggered by release tag(s): `agent-v1.82.0`

## [1.7.127] - 2026-07-27

### Changed

- auto-bump to chart v1.7.127 triggered by release tag(s): `agent-v1.81.2`

## [1.7.126] - 2026-07-27

### Changed

- auto-bump to chart v1.7.126 triggered by release tag(s): `agent-v1.81.1`

## [1.7.125] - 2026-07-27

### Changed

- auto-bump to chart v1.7.125 triggered by release tag(s): `agent-v1.81.0`

## [1.7.124] - 2026-07-27

### Changed

- auto-bump to chart v1.7.124 triggered by release tag(s): `agent-v1.80.0`

## [1.7.123] - 2026-07-23

### Changed

- auto-bump to chart v1.7.123 triggered by release tag(s): `agent-v1.71.0`

## [1.7.122] - 2026-07-23

### Changed

- auto-bump to chart v1.7.122 triggered by release tag(s): `chat-v1.9.0`

## [1.7.121] - 2026-07-23

### Changed

- auto-bump to chart v1.7.121 triggered by release tag(s): `admin-v1.33.0`, `chat-v1.9.0`, `metrics-v1.11.0`, `task-store-v1.18.0`

## [1.7.120] - 2026-07-23

### Changed

- auto-bump to chart v1.7.120 triggered by release tag(s): `agent-v1.68.0`

## [1.7.119] - 2026-07-23

### Changed

- auto-bump to chart v1.7.119 triggered by release tag(s): `agent-v1.64.0`

## [1.7.118] - 2026-07-23

### Changed

- auto-bump to chart v1.7.118 triggered by release tag(s): `agent-v1.63.1`

## [1.7.117] - 2026-07-23

### Changed

- auto-bump to chart v1.7.117 triggered by release tag(s): `agent-v1.63.0`

## [1.7.116] - 2026-07-22

### Changed

- auto-bump to chart v1.7.116 triggered by release tag(s): `admin-v1.32.0`, `agent-v1.62.0`, `chat-v1.8.0`, `metrics-v1.10.0`, `task-store-v1.17.0`

## [1.7.115] - 2026-07-22

### Changed

- auto-bump to chart v1.7.115 triggered by release tag(s): `agent-v1.61.0`

## [1.7.114] - 2026-07-22

### Changed

- auto-bump to chart v1.7.114 triggered by release tag(s): `admin-v1.31.1`

## [1.7.113] - 2026-07-22

### Changed

- auto-bump to chart v1.7.113 triggered by release tag(s): `admin-v1.31.0`

## [1.7.112] - 2026-07-22

### Changed

- auto-bump to chart v1.7.112 triggered by release tag(s): `agent-v1.60.0`

## [1.7.111] - 2026-07-22

### Changed

- auto-bump to chart v1.7.111 triggered by release tag(s): `admin-v1.30.0`

## [1.7.110] - 2026-07-22

### Changed

- auto-bump to chart v1.7.110 triggered by release tag(s): `agent-v1.59.0`

## [1.7.109] - 2026-07-22

### Changed

- auto-bump to chart v1.7.109 triggered by release tag(s): `admin-v1.29.0`

## [1.7.108] - 2026-07-22

### Changed

- auto-bump to chart v1.7.108 triggered by release tag(s): `agent-v1.58.0`

## [1.7.107] - 2026-07-22

### Changed

- auto-bump to chart v1.7.107 triggered by release tag(s): `agent-v1.57.0`

## [1.7.106] - 2026-07-22

### Changed

- auto-bump to chart v1.7.106 triggered by release tag(s): `admin-v1.28.0`, `agent-v1.56.1`, `chat-v1.7.0`, `metrics-v1.9.0`, `task-store-v1.16.0`

## [1.7.105] - 2026-07-22

### Changed

- manual chart version bump to v1.7.105 required by `ct lint --check-version-increment`: `taskStore.extraEnv` now defaults to populating `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` (previously shipped as `[]` with a commented-out example)

## [1.7.104] - 2026-07-22

### Changed

- auto-bump to chart v1.7.104 triggered by release tag(s): `agent-v1.56.0`

## [1.7.103] - 2026-07-22

### Changed

- auto-bump to chart v1.7.103 triggered by release tag(s): `agent-v1.55.0`

## [1.7.102] - 2026-07-22

### Changed

- auto-bump to chart v1.7.102 triggered by release tag(s): `admin-v1.27.0`

## [1.7.101] - 2026-07-22

### Changed

- auto-bump to chart v1.7.101 triggered by release tag(s): `admin-v1.26.1`, `agent-v1.54.1`, `chat-v1.6.1`, `metrics-v1.8.1`, `task-store-v1.15.1`

## [1.7.100] - 2026-07-22

### Changed

- auto-bump to chart v1.7.100 triggered by release tag(s): `agent-v1.54.0`

## [1.7.99] - 2026-07-22

### Changed

- auto-bump to chart v1.7.99 triggered by release tag(s): `admin-v1.25.0`, `chat-v1.5.0`, `metrics-v1.7.0`, `task-store-v1.14.0`

## [1.7.98] - 2026-07-22

### Changed

- manual chart version bump to v1.7.98 required by `ct lint --check-version-increment` (no chart content change in #2059)

## [1.7.97] - 2026-07-22

### Changed

- auto-bump to chart v1.7.97 triggered by release tag(s): `agent-v1.53.0`

## [1.7.96] - 2026-07-22

### Changed

- auto-bump to chart v1.7.96 triggered by release tag(s): `agent-v1.52.0`

## [1.7.95] - 2026-07-22

### Changed

- auto-bump to chart v1.7.95 triggered by release tag(s): `task-store-v1.13.0`

## [1.7.94] - 2026-07-21

### Changed

- auto-bump to chart v1.7.94 triggered by release tag(s): `agent-v1.51.0`

## [1.7.93] - 2026-07-21

### Changed

- auto-bump to chart v1.7.93 triggered by release tag(s): `agent-v1.50.0`

## [1.7.92] - 2026-07-21

### Changed

- auto-bump to chart v1.7.92 triggered by release tag(s): `admin-v1.24.0`

## [1.7.91] - 2026-07-21

### Changed

- auto-bump to chart v1.7.91 triggered by release tag(s): `metrics-v1.6.0`

## [1.7.90] - 2026-07-21

### Changed

- auto-bump to chart v1.7.90 triggered by release tag(s): `task-store-v1.12.0`

## [1.7.89] - 2026-07-21

### Changed

- auto-bump to chart v1.7.89 triggered by release tag(s): `metrics-v1.5.0`

## [1.7.88] - 2026-07-21

### Changed

- auto-bump to chart v1.7.88 triggered by release tag(s): `agent-v1.49.0`

## [1.7.87] - 2026-07-21

### Changed

- auto-bump to chart v1.7.87 triggered by release tag(s): `agent-v1.48.0`

## [1.7.86] - 2026-07-21

### Changed

- auto-bump to chart v1.7.86 triggered by release tag(s): `agent-v1.47.0`

## [1.7.85] - 2026-07-21

### Changed

- auto-bump to chart v1.7.85 triggered by release tag(s): `agent-v1.46.1`

## [1.7.84] - 2026-07-21

### Changed

- auto-bump to chart v1.7.84 triggered by release tag(s): `admin-v1.23.0`

## [1.7.83] - 2026-07-21

### Changed

- auto-bump to chart v1.7.83 triggered by release tag(s): `task-store-v1.11.0`

## [1.7.82] - 2026-07-21

### Changed

- auto-bump to chart v1.7.82 triggered by release tag(s): `agent-v1.46.0`

## [1.7.81] - 2026-07-21

### Changed

- auto-bump to chart v1.7.81 triggered by release tag(s): `agent-v1.45.0`

## [1.7.80] - 2026-07-21

### Changed

- auto-bump to chart v1.7.80 triggered by release tag(s): `admin-v1.22.4`, `agent-v1.44.6`, `chat-v1.4.4`, `metrics-v1.4.4`, `task-store-v1.10.4`

## [1.7.79] - 2026-07-21

### Changed

- auto-bump to chart v1.7.79 triggered by release tag(s): `admin-v1.22.3`, `agent-v1.44.5`, `chat-v1.4.3`, `metrics-v1.4.3`, `task-store-v1.10.3`

## [1.7.78] - 2026-07-21

### Changed

- auto-bump to chart v1.7.78 triggered by release tag(s): `agent-v1.44.4`

## [1.7.77] - 2026-07-21

### Changed

- auto-bump to chart v1.7.77 triggered by release tag(s): `agent-v1.44.3`

## [1.7.76] - 2026-07-21

### Changed

- auto-bump to chart v1.7.76 triggered by release tag(s): `chat-v1.4.2`

## [1.7.75] - 2026-07-21

### Changed

- auto-bump to chart v1.7.75 triggered by release tag(s): `task-store-v1.10.1`

## [1.7.74] - 2026-07-21

### Changed

- auto-bump to chart v1.7.74 triggered by release tag(s): `agent-v1.44.2`

## [1.7.73] - 2026-07-21

### Changed

- auto-bump to chart v1.7.73 triggered by release tag(s): `admin-v1.22.0`, `agent-v1.44.1`, `chat-v1.4.0`, `metrics-v1.4.0`, `task-store-v1.10.0`

## [1.7.72] - 2026-07-21

### Changed

- auto-bump to chart v1.7.72 triggered by release tag(s): `agent-v1.44.0`

## [1.7.71] - 2026-07-20

### Changed

- auto-bump to chart v1.7.71 triggered by release tag(s): `admin-v1.21.2`, `agent-v1.43.1`, `chat-v1.3.1`, `metrics-v1.3.1`, `task-store-v1.9.1`

## [1.7.70] - 2026-07-20

### Changed

- auto-bump to chart v1.7.70 triggered by release tag(s): `admin-v1.21.1`, `agent-v1.43.0`, `chat-v1.3.0`, `metrics-v1.3.0`, `task-store-v1.9.0`

## [1.7.69] - 2026-07-20

### Changed

- auto-bump to chart v1.7.69 triggered by release tag(s): `admin-v1.21.0`

## [1.7.68] - 2026-07-20

### Changed

- auto-bump to chart v1.7.68 triggered by release tag(s): `agent-v1.42.0`

## [1.7.67] - 2026-07-20

### Changed

- auto-bump to chart v1.7.67 triggered by release tag(s): `admin-v1.20.0`

## [1.7.66] - 2026-07-20

### Changed

- auto-bump to chart v1.7.66 triggered by release tag(s): `agent-v1.41.0`

## [1.7.65] - 2026-07-20

### Changed

- auto-bump to chart v1.7.65 triggered by release tag(s): `agent-v1.40.0`

## [1.7.64] - 2026-07-20

### Changed

- auto-bump to chart v1.7.64 triggered by release tag(s): `agent-v1.39.0`

## [1.7.63] - 2026-07-20

### Changed

- auto-bump to chart v1.7.63 triggered by release tag(s): `admin-v1.19.0`

## [1.7.62] - 2026-07-20

### Changed

- auto-bump to chart v1.7.62 triggered by release tag(s): `admin-v1.18.0`, `agent-v1.38.0`

## [1.7.61] - 2026-07-20

### Changed

- auto-bump to chart v1.7.61 triggered by release tag(s): `agent-v1.37.0`

## [1.7.60] - 2026-07-20

### Changed

- auto-bump to chart v1.7.60 triggered by release tag(s): `agent-v1.36.0`

## [1.7.59] - 2026-07-20

### Changed

- auto-bump to chart v1.7.59 triggered by release tag(s): `agent-v1.35.0`

## [1.7.58] - 2026-07-20

### Changed

- auto-bump to chart v1.7.58 triggered by release tag(s): `agent-v1.34.0`

## [1.7.57] - 2026-07-20

### Changed

- auto-bump to chart v1.7.57 triggered by release tag(s): `task-store-v1.8.0`

## [1.7.56] - 2026-07-20

### Changed

- auto-bump to chart v1.7.56 triggered by release tag(s): `agent-v1.33.0`

## [1.7.55] - 2026-07-20

### Changed

- auto-bump to chart v1.7.55 triggered by release tag(s): `task-store-v1.7.0`

## [1.7.54] - 2026-07-20

### Changed

- auto-bump to chart v1.7.54 triggered by release tag(s): `agent-v1.32.0`

## [1.7.53] - 2026-07-20

### Changed

- auto-bump to chart v1.7.53 triggered by release tag(s): `agent-v1.31.0`

## [1.7.52] - 2026-07-20

### Changed

- auto-bump to chart v1.7.52 triggered by release tag(s): `agent-v1.30.0`

## [1.7.51] - 2026-07-20

### Changed

- auto-bump to chart v1.7.51 triggered by release tag(s): `agent-v1.29.1`

## [1.7.50] - 2026-07-20

### Changed

- auto-bump to chart v1.7.50 triggered by release tag(s): `agent-v1.29.0`

## [1.7.49] - 2026-07-20

### Changed

- auto-bump to chart v1.7.49 triggered by release tag(s): `agent-v1.28.0`

## [1.7.48] - 2026-07-20

### Changed

- auto-bump to chart v1.7.48 triggered by release tag(s): `agent-v1.27.0`, `task-store-v1.6.0`

## [1.7.47] - 2026-07-20

### Changed

- auto-bump to chart v1.7.47 triggered by release tag(s): `agent-v1.26.0`

## [1.7.46] - 2026-07-19

### Changed

- auto-bump to chart v1.7.46 triggered by release tag(s): `agent-v1.25.0`

## [1.7.45] - 2026-07-19

### Changed

- auto-bump to chart v1.7.45 triggered by release tag(s): `agent-v1.24.0`

## [1.7.44] - 2026-07-19

### Changed

- auto-bump to chart v1.7.44 triggered by release tag(s): `admin-v1.17.5`, `agent-v1.23.1`, `chat-v1.2.1`, `metrics-v1.2.1`, `task-store-v1.5.1`

## [1.7.43] - 2026-07-19

### Changed

- auto-bump to chart v1.7.43 triggered by release tag(s): `admin-v1.17.4`

## [1.7.42] - 2026-07-19

### Changed

- auto-bump to chart v1.7.42 triggered by release tag(s): `admin-v1.17.3`

## [1.7.41] - 2026-07-19

### Changed

- auto-bump to chart v1.7.41 triggered by release tag(s): `admin-v1.17.2`, `agent-v1.23.0`, `chat-v1.2.0`, `metrics-v1.2.0`, `task-store-v1.5.0`

## [1.7.40] - 2026-07-19

### Changed

- auto-bump to chart v1.7.40 triggered by release tag(s): `admin-v1.17.1`

## [1.7.39] - 2026-07-19

### Changed

- auto-bump to chart v1.7.39 triggered by release tag(s): `admin-v1.17.0`

## [1.7.38] - 2026-07-19

### Changed

- auto-bump to chart v1.7.38 triggered by release tag(s): `admin-v1.16.0`

## [1.7.37] - 2026-07-19

### Changed

- auto-bump to chart v1.7.37 triggered by release tag(s): `admin-v1.15.0`

## [1.7.36] - 2026-07-19

### Changed

- auto-bump to chart v1.7.36 triggered by release tag(s): `admin-v1.14.0`

## [1.7.35] - 2026-07-19

### Changed

- auto-bump to chart v1.7.35 triggered by release tag(s): `agent-v1.22.0`

## [1.7.34] - 2026-07-19

### Changed

- auto-bump to chart v1.7.34 triggered by release tag(s): `admin-v1.13.1`

## [1.7.33] - 2026-07-18

### Changed

- auto-bump to chart v1.7.33 triggered by release tag(s): `agent-v1.21.0`

## [1.7.32] - 2026-07-18

### Changed

- auto-bump to chart v1.7.32 triggered by release tag(s): `admin-v1.13.0`

## [1.7.31] - 2026-07-18

### Changed

- auto-bump to chart v1.7.31 triggered by release tag(s): `admin-v1.12.0`

## [1.7.30] - 2026-07-18

### Changed

- auto-bump to chart v1.7.30 triggered by release tag(s): `agent-v1.20.0`

## [1.7.29] - 2026-07-18

### Changed

- auto-bump to chart v1.7.29 triggered by release tag(s): `admin-v1.11.0`

## [1.7.28] - 2026-07-18

### Changed

- auto-bump to chart v1.7.28 triggered by release tag(s): `admin-v1.10.0`

## [1.7.27] - 2026-07-18

### Changed

- auto-bump to chart v1.7.27 triggered by release tag(s): `agent-v1.19.0`

## [1.7.26] - 2026-07-18

### Changed

- auto-bump to chart v1.7.26 triggered by release tag(s): `agent-v1.18.0`

## [1.7.25] - 2026-07-18

### Changed

- auto-bump to chart v1.7.25 triggered by release tag(s): `admin-v1.9.0`

## [1.7.24] - 2026-07-18

### Changed

- auto-bump to chart v1.7.24 triggered by release tag(s): `agent-v1.17.2`

## [1.7.23] - 2026-07-18

### Changed

- auto-bump to chart v1.7.23 triggered by release tag(s): `agent-v1.17.1`

## [1.7.22] - 2026-07-18

### Changed

- auto-bump to chart v1.7.22 triggered by release tag(s): `admin-v1.8.0`, `agent-v1.17.0`

## [1.7.21] - 2026-07-18

### Changed

- auto-bump to chart v1.7.21 triggered by release tag(s): `agent-v1.16.0`

## [1.7.20] - 2026-07-18

### Changed

- auto-bump to chart v1.7.20 triggered by release tag(s): `agent-v1.15.2`

## [1.7.19] - 2026-07-18

### Changed

- auto-bump to chart v1.7.19 triggered by release tag(s): `agent-v1.15.1`

## [1.7.18] - 2026-07-18

### Changed

- auto-bump to chart v1.7.18 triggered by release tag(s): `agent-v1.15.0`

## [1.7.17] - 2026-07-18

### Changed

- auto-bump to chart v1.7.17 triggered by release tag(s): `admin-v1.7.0`

## [1.7.16] - 2026-07-18

### Changed

- auto-bump to chart v1.7.16 triggered by release tag(s): `agent-v1.14.2`

## [1.7.15] - 2026-07-18

### Changed

- auto-bump to chart v1.7.15 triggered by release tag(s): `agent-v1.14.1`

## [1.7.14] - 2026-07-18

### Changed

- auto-bump to chart v1.7.14 triggered by release tag(s): `agent-v1.14.0`

## [1.7.13] - 2026-07-18

### Changed

- auto-bump to chart v1.7.13 triggered by release tag(s): `agent-v1.13.0`

## [1.7.12] - 2026-07-18

### Changed

- auto-bump to chart v1.7.12 triggered by release tag(s): `agent-v1.12.1`

## [1.7.11] - 2026-07-18

### Changed

- auto-bump to chart v1.7.11 triggered by release tag(s): `agent-v1.12.0`

## [1.7.10] - 2026-07-18

### Changed

- auto-bump to chart v1.7.10 triggered by release tag(s): `admin-v1.6.0`, `chat-v1.1.0`, `metrics-v1.1.0`, `task-store-v1.4.0`

## [1.7.9] - 2026-07-18

### Changed

- auto-bump to chart v1.7.9 triggered by release tag(s): `admin-v1.5.0`

## [1.7.8] - 2026-07-18

### Changed

- auto-bump to chart v1.7.8 triggered by release tag(s): `agent-v1.11.0`

## [1.7.7] - 2026-07-18

### Changed

- auto-bump to chart v1.7.7 triggered by release tag(s): `admin-v1.4.0`

## [1.7.6] - 2026-07-18

### Changed

- auto-bump to chart v1.7.6 triggered by release tag(s): `agent-v1.10.1`

## [1.7.5] - 2026-07-18

### Changed

- docs: remove remaining edge-tts references from Piper docstring and Helm chart comments/README (PPR-1.4)

## [1.7.4] - 2026-07-18

### Changed

- auto-bump to chart v1.7.4 triggered by release tag(s): `agent-v1.10.0`

## [1.7.3] - 2026-07-18

### Changed

- auto-bump to chart v1.7.3 triggered by release tag(s): `agent-v1.9.0`

## [1.7.2] - 2026-07-17

### Changed

- auto-bump to chart v1.7.2 triggered by release tag(s): `agent-v1.8.0`

## [1.7.1] - 2026-07-17

### Changed

- auto-bump to chart v1.7.1 triggered by release tag(s): `admin-v1.3.0`, `task-store-v1.3.0`

## [1.7.0] - 2026-07-17

### Added

- **Whisper ASR model configurability** (`agent.voice.whisper.model`, PPR-2.1): set the ASR model used by the self-hosted Whisper pod (`onerahmet/openai-whisper-asr-webservice`) via a new `ASR_MODEL` env var, e.g. `tiny`, `base`, `small`, `medium`, `large-v3`, or a language-suffixed variant like `tiny.en`. Empty (default) → no `ASR_MODEL` env var is rendered and the image falls back to its own built-in default model, preserving today's behaviour on upgrade. The `resources: {}` example in `values.yaml` was also expanded into a concrete CPU/memory sizing example for a small model.

## [1.6.458] - 2026-07-17

### Changed

- auto-bump to chart v1.6.458 triggered by release tag(s): `agent-v1.7.0`

## [1.6.457] - 2026-07-17

### Changed

- auto-bump to chart v1.6.457 triggered by release tag(s): `agent-v1.6.0`

## [1.6.456] - 2026-07-17

### Changed

- auto-bump to chart v1.6.456 triggered by release tag(s): `task-store-v1.2.0`

## [1.6.455] - 2026-07-17

### Changed

- auto-bump to chart v1.6.455 triggered by release tag(s): `agent-v1.5.0`

## [1.6.454] - 2026-07-17

### Changed

- auto-bump to chart v1.6.454 triggered by release tag(s): `agent-v1.4.0`

## [1.6.453] - 2026-07-17

### Changed

- auto-bump to chart v1.6.453 triggered by release tag(s): `admin-v1.2.0`

## [1.6.452] - 2026-07-17

### Changed

- auto-bump to chart v1.6.452 triggered by release tag(s): `admin-v1.1.0`

## [1.6.451] - 2026-07-17

### Changed

- auto-bump to chart v1.6.451 triggered by release tag(s): `agent-v1.3.0`

## [1.6.450] - 2026-07-17

### Changed

- auto-bump to chart v1.6.450 triggered by release tag(s): `admin-v1.0.0`, `chat-v1.0.0`, `metrics-v1.0.0`, `task-store-v1.1.0`

## [1.6.449] - 2026-07-17

### Changed

- auto-bump to chart v1.6.449 triggered by release tag(s): `agent-v1.2.0`

## [1.6.448] - 2026-07-17

### Changed

- docs: document opt-in claim TTL buffer var (`taskStore.extraEnv` example) and N:1 agents-to-task-store TTL requirement (CTB-3.1)

## [1.6.447] - 2026-07-17

### Changed

- auto-bump to chart v1.6.447 triggered by release tag(s): `task-store-v1.0.0`

## [1.6.446] - 2026-07-17

### Changed

- auto-bump to chart v1.6.446 triggered by release tag(s): `agent-v1.1.0`

## [1.6.445] - 2026-07-17

### Changed

- auto-bump to chart v1.6.445 triggered by release tag(s): `agent-v1.0.0`

## [1.6.444] - 2026-07-17

### Changed

- auto-bump to chart v1.6.444 triggered by release tag(s): `admin-v0.222.0`

## [1.6.443] - 2026-07-17

### Changed

- auto-bump to chart v1.6.443 triggered by release tag(s): `agent-v0.221.1`

## [1.6.442] - 2026-07-17

### Changed

- auto-bump to chart v1.6.442 triggered by release tag(s): `admin-v0.221.0`, `agent-v0.221.0`

## [1.6.441] - 2026-07-17

### Changed

- auto-bump to chart v1.6.441 triggered by release tag(s): `admin-v0.220.0`, `agent-v0.220.0`

## [1.6.440] - 2026-07-17

### Changed

- auto-bump to chart v1.6.440 triggered by release tag(s): `task-store-v0.117.0`

## [1.6.439] - 2026-07-17

### Changed

- auto-bump to chart v1.6.439 triggered by release tag(s): `agent-v0.219.0`

## [1.6.438] - 2026-07-17

### Changed

- auto-bump to chart v1.6.438 triggered by release tag(s): `admin-v0.219.0`, `agent-v0.219.0`

## [1.6.437] - 2026-07-17

### Changed

- auto-bump to chart v1.6.437 triggered by release tag(s): `agent-v0.218.0`

## [1.6.436] - 2026-07-17

### Changed

- auto-bump to chart v1.6.436 triggered by release tag(s): `admin-v0.218.0`, `chat-v0.61.0`, `metrics-v0.175.0`, `task-store-v0.116.0`

## [1.6.435] - 2026-07-17

### Changed

- auto-bump to chart v1.6.435 triggered by release tag(s): `agent-v0.217.0`

## [1.6.434] - 2026-07-17

### Changed

- auto-bump to chart v1.6.434 triggered by release tag(s): `agent-v0.216.0`

## [1.6.433] - 2026-07-17

### Changed

- auto-bump to chart v1.6.433 triggered by release tag(s): `agent-v0.215.1`

## [1.6.432] - 2026-07-17

### Changed

- auto-bump to chart v1.6.432 triggered by release tag(s): `agent-v0.215.0`

## [1.6.431] - 2026-07-17

### Changed

- auto-bump to chart v1.6.431 triggered by release tag(s): `admin-v0.217.0`, `agent-v0.214.1`, `chat-v0.60.0`, `metrics-v0.174.0`, `task-store-v0.115.0`

## [1.6.430] - 2026-07-17

### Changed

- auto-bump to chart v1.6.430 triggered by release tag(s): `agent-v0.214.0`

## [1.6.429] - 2026-07-17

### Changed

- auto-bump to chart v1.6.429 triggered by release tag(s): `task-store-v0.114.0`

## [1.6.428] - 2026-07-17

### Changed

- auto-bump to chart v1.6.428 triggered by release tag(s): `task-store-v0.113.1`

## [1.6.427] - 2026-07-17

### Changed

- auto-bump to chart v1.6.427 triggered by release tag(s): `agent-v0.213.0`

## [1.6.426] - 2026-07-17

### Changed

- auto-bump to chart v1.6.426 triggered by release tag(s): `chat-v0.58.0`

## [1.6.425] - 2026-07-17

### Changed

- auto-bump to chart v1.6.425 triggered by release tag(s): `admin-v0.215.0`

## [1.6.424] - 2026-07-17

### Changed

- auto-bump to chart v1.6.424 triggered by release tag(s): `admin-v0.214.0`, `chat-v0.57.0`, `metrics-v0.171.0`, `metrics-v0.172.0`, `task-store-v0.112.0`

## [1.6.423] - 2026-07-17

### Changed

- auto-bump to chart v1.6.423 triggered by release tag(s): `chat-v0.56.0`

## [1.6.422] - 2026-07-16

### Changed

- auto-bump to chart v1.6.422 triggered by release tag(s): `task-store-v0.110.1`

## [1.6.421] - 2026-07-16

### Changed

- auto-bump to chart v1.6.421 triggered by release tag(s): `admin-v0.213.0`, `agent-v0.209.1`, `chat-v0.54.0`, `metrics-v0.169.0`, `task-store-v0.110.0`

## [1.6.420] - 2026-07-16

### Changed

- auto-bump to chart v1.6.420 triggered by release tag(s): `agent-v0.209.0`

## [1.6.419] - 2026-07-16

### Changed

- auto-bump to chart v1.6.419 triggered by release tag(s): `metrics-v0.168.0`

## [1.6.418] - 2026-07-16

### Changed

- auto-bump to chart v1.6.418 triggered by release tag(s): `admin-v0.212.0`, `agent-v0.208.0`, `chat-v0.53.0`, `metrics-v0.167.0`, `task-store-v0.109.0`

## [1.6.417] - 2026-07-16

### Changed

- auto-bump to chart v1.6.417 triggered by release tag(s): `task-store-v0.108.0`

## [1.6.416] - 2026-07-16

### Changed

- auto-bump to chart v1.6.416 triggered by release tag(s): `agent-v0.207.0`

## [1.6.415] - 2026-07-16

### Changed

- auto-bump to chart v1.6.415 triggered by release tag(s): `agent-v0.206.2`

## [1.6.414] - 2026-07-16

### Changed

- auto-bump to chart v1.6.414 triggered by release tag(s): `admin-v0.209.0`, `admin-v0.210.0`, `admin-v0.211.0`, `agent-v0.203.0`, `agent-v0.204.0`, `agent-v0.205.0`, `agent-v0.206.0`, `agent-v0.206.1`, `chat-v0.51.0`, `chat-v0.52.0`, `metrics-v0.165.0`, `metrics-v0.166.0`, `task-store-v0.106.0`, `task-store-v0.107.0`

## [1.6.413] - 2026-07-16

### Changed

- README: clarify `appVersion` is not used for image resolution — each service's `image.tag` is pinned independently

## [1.6.412] - 2026-07-16

### Changed

- auto-bump to chart v1.6.412 triggered by release tag(s): `admin-v0.208.0`, `chat-v0.50.0`, `metrics-v0.164.0`, `task-store-v0.105.0`

## [1.6.411] - 2026-07-16

### Changed

- auto-bump to chart v1.6.411 triggered by release tag(s): `admin-v0.207.0`, `agent-v0.202.0`, `chat-v0.49.0`, `metrics-v0.163.0`, `task-store-v0.104.0`

## [1.6.410] - 2026-07-16

### Changed

- auto-bump to chart v1.6.410 triggered by release tag(s): `admin-v0.202.0`, `admin-v0.206.0`, `agent-v0.195.0`, `agent-v0.201.0`, `chat-v0.45.0`, `chat-v0.48.0`, `metrics-v0.159.0`, `metrics-v0.162.0`, `task-store-v0.103.0`, `task-store-v0.99.0`

## [1.6.409] - 2026-07-16

### Changed

- auto-bump to chart v1.6.409 triggered by release tag(s): `admin-v0.202.0`, `agent-v0.195.0`, `agent-v0.200.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.99.0`

## [1.6.408] - 2026-07-16

### Changed

- auto-bump to chart v1.6.408 triggered by release tag(s): `admin-v0.202.0`, `agent-v0.195.0`, `agent-v0.199.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.99.0`

## [1.6.407] - 2026-07-16

### Changed

- auto-bump to chart v1.6.407 triggered by release tag(s): `admin-v0.202.0`, `admin-v0.205.0`, `agent-v0.189.0`, `agent-v0.195.0`, `chat-v0.45.0`, `chat-v0.47.0`, `metrics-v0.159.0`, `metrics-v0.161.0`, `task-store-v0.102.0`, `task-store-v0.99.0`

## [1.6.406] - 2026-07-16

### Changed

- auto-bump to chart v1.6.406 triggered by release tag(s): `admin-v0.202.0`, `agent-v0.189.0`, `agent-v0.195.0`, `agent-v0.198.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.99.0`

## [1.6.405] - 2026-07-16

### Changed

- auto-bump to chart v1.6.405 triggered by release tag(s): `admin-v0.202.0`, `agent-v0.189.0`, `agent-v0.195.0`, `agent-v0.197.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.99.0`

## [1.6.404] - 2026-07-16

### Changed

- auto-bump to chart v1.6.404 triggered by release tag(s): `admin-v0.202.0`, `admin-v0.204.1`, `agent-v0.189.0`, `agent-v0.195.0`, `agent-v0.196.0`, `chat-v0.45.0`, `chat-v0.46.0`, `metrics-v0.159.0`, `metrics-v0.160.0`, `task-store-v0.101.0`, `task-store-v0.99.0`

## [1.6.403] - 2026-07-16

### Changed

- auto-bump to chart v1.6.403 triggered by release tag(s): `admin-v0.202.0`, `admin-v0.204.0`, `agent-v0.189.0`, `agent-v0.195.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.99.0`

## [1.6.402] - 2026-07-16

### Changed

- auto-bump to chart v1.6.402 triggered by release tag(s): `admin-v0.202.0`, `admin-v0.203.0`, `agent-v0.189.0`, `agent-v0.195.0`, `chat-v0.45.0`, `metrics-v0.159.0`, `task-store-v0.100.0`, `task-store-v0.99.0`

## [1.6.401] - 2026-07-16

### Changed

- auto-bump to chart v1.6.401 triggered by release tag(s): `admin-v0.201.0`, `agent-v0.189.0`, `agent-v0.194.1`, `chat-v0.44.0`, `metrics-v0.158.0`, `task-store-v0.98.0`

## [1.6.400] - 2026-07-16

### Changed

- auto-bump to chart v1.6.400 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.194.0`

## [1.6.399] - 2026-07-16

### Changed

- auto-bump to chart v1.6.399 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.193.1`

## [1.6.398] - 2026-07-16

### Changed

- auto-bump to chart v1.6.398 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.193.0`

## [1.6.397] - 2026-07-16

### Changed

- auto-bump to chart v1.6.397 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.192.0`

## [1.6.396] - 2026-07-16

### Changed

- auto-bump to chart v1.6.396 triggered by release tag(s): `admin-v0.200.0`, `agent-v0.189.0`, `agent-v0.191.0`, `chat-v0.43.0`, `metrics-v0.157.0`, `task-store-v0.97.0`

## [1.6.395] - 2026-07-16

### Changed

- auto-bump to chart v1.6.395 triggered by release tag(s): `admin-v0.199.0`, `agent-v0.189.0`

## [1.6.394] - 2026-07-16

### Changed

- auto-bump to chart v1.6.394 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.190.2`

## [1.6.393] - 2026-07-15

### Changed

- auto-bump to chart v1.6.393 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.190.1`

## [1.6.392] - 2026-07-15

### Changed

- auto-bump to chart v1.6.392 triggered by release tag(s): `agent-v0.189.0`, `agent-v0.190.0`

## [1.6.391] - 2026-07-15

### Changed

- auto-bump to chart v1.6.391 triggered by release tag(s): `agent-v0.189.0`

## [1.6.390] - 2026-07-15

### Changed

- auto-bump to chart v1.6.390 triggered by release tag(s): `agent-v0.188.0`

## [1.6.389] - 2026-07-15

### Changed

- auto-bump to chart v1.6.389 triggered by release tag(s): `admin-v0.197.0`, `admin-v0.198.0`, `agent-v0.187.0`, `chat-v0.41.0`, `chat-v0.42.0`, `metrics-v0.155.0`, `metrics-v0.156.0`, `task-store-v0.95.0`, `task-store-v0.96.0`

## [1.6.388] - 2026-07-15

### Changed

- auto-bump to chart v1.6.388 triggered by release tag(s): `admin-v0.196.0`

## [1.6.387] - 2026-07-15

### Changed

- auto-bump to chart v1.6.387 triggered by release tag(s): `agent-v0.186.0`

## [1.6.386] - 2026-07-15

### Changed

- auto-bump to chart v1.6.386 triggered by release tag(s): `agent-v0.185.0`

## [1.6.385] - 2026-07-15

### Changed

- auto-bump to chart v1.6.385 triggered by release tag(s): `task-store-v0.94.0`

## [1.6.384] - 2026-07-15

### Changed

- auto-bump to chart v1.6.384 triggered by release tag(s): `agent-v0.184.0`

## [1.6.383] - 2026-07-15

### Changed

- auto-bump to chart v1.6.383 triggered by release tag(s): `admin-v0.195.0`

## [1.6.382] - 2026-07-15

### Changed

- auto-bump to chart v1.6.382 triggered by release tag(s): `metrics-v0.154.0`

## [1.6.381] - 2026-07-15

### Changed

- auto-bump to chart v1.6.381 triggered by release tag(s): `task-store-v0.93.0`

## [1.6.380] - 2026-07-15

### Changed

- auto-bump to chart v1.6.380 triggered by release tag(s): `metrics-v0.153.0`

## [1.6.379] - 2026-07-15

### Changed

- auto-bump to chart v1.6.379 triggered by release tag(s): `agent-v0.183.0`

## [1.6.378] - 2026-07-15

### Changed

- auto-bump to chart v1.6.378 triggered by release tag(s): `agent-v0.182.0`

## [1.6.377] - 2026-07-15

### Changed

- auto-bump to chart v1.6.377 triggered by release tag(s): `agent-v0.181.5`

## [1.6.376] - 2026-07-15

### Changed

- auto-bump to chart v1.6.376 triggered by release tag(s): `agent-v0.181.4`

## [1.6.375] - 2026-07-15

### Changed

- auto-bump to chart v1.6.375 triggered by release tag(s): `agent-v0.181.3`

## [1.6.374] - 2026-07-15

### Changed

- auto-bump to chart v1.6.374 triggered by release tag(s): `agent-v0.181.2`

## [1.6.373] - 2026-07-15

### Changed

- auto-bump to chart v1.6.373 triggered by release tag(s): `agent-v0.181.1`

## [1.6.372] - 2026-07-15

### Changed

- auto-bump to chart v1.6.372 triggered by release tag(s): `agent-v0.181.0`, `task-store-v0.92.0`

## [1.6.371] - 2026-07-15

### Changed

- auto-bump to chart v1.6.371 triggered by release tag(s): `admin-v0.194.1`

## [1.6.370] - 2026-07-15

### Changed

- auto-bump to chart v1.6.370 triggered by release tag(s): `admin-v0.194.0`

## [1.6.369] - 2026-07-15

### Changed

- auto-bump to chart v1.6.369 triggered by release tag(s): `task-store-v0.91.0`

## [1.6.368] - 2026-07-14

### Changed

- auto-bump to chart v1.6.368 triggered by release tag(s): `agent-v0.180.2`

## [1.6.367] - 2026-07-14

### Changed

- auto-bump to chart v1.6.367 triggered by release tag(s): `admin-v0.193.0`

## [1.6.366] - 2026-07-14

### Changed

- auto-bump to chart v1.6.366 triggered by release tag(s): `agent-v0.180.1`

## [1.6.365] - 2026-07-14

### Changed

- auto-bump to chart v1.6.365 triggered by release tag(s): `agent-v0.180.0`, `chat-v0.40.0`, `task-store-v0.90.0`

## [1.6.364] - 2026-07-14

### Changed

- auto-bump to chart v1.6.364 triggered by release tag(s): `admin-v0.192.0`

## [1.6.363] - 2026-07-14

### Changed

- auto-bump to chart v1.6.363 triggered by release tag(s): `agent-v0.179.2`

## [1.6.362] - 2026-07-14

### Changed

- auto-bump to chart v1.6.362 triggered by release tag(s): `agent-v0.179.1`

## [1.6.361] - 2026-07-14

### Changed

- auto-bump to chart v1.6.361 triggered by release tag(s): `agent-v0.179.0`

## [1.6.360] - 2026-07-14

### Changed

- auto-bump to chart v1.6.360 triggered by release tag(s): `agent-v0.178.0`

## [1.6.359] - 2026-07-14

### Changed

- auto-bump to chart v1.6.359 triggered by release tag(s): `agent-v0.177.2`

## [1.6.358] - 2026-07-14

### Changed

- auto-bump to chart v1.6.358 triggered by release tag(s): `admin-v0.191.0`, `agent-v0.176.1`, `agent-v0.177.1`

## [1.6.357] - 2026-07-14

### Changed

- auto-bump to chart v1.6.357 triggered by release tag(s): `agent-v0.176.1`, `agent-v0.177.0`

## [1.6.356] - 2026-07-14

### Changed

- auto-bump to chart v1.6.356 triggered by release tag(s): `agent-v0.176.1`, `agent-v0.176.2`

## [1.6.355] - 2026-07-14

### Changed

- auto-bump to chart v1.6.355 triggered by release tag(s): `agent-v0.176.1`

## [1.6.354] - 2026-07-14

### Changed

- auto-bump to chart v1.6.354 triggered by release tag(s): `agent-v0.176.0`

## [1.6.353] - 2026-07-14

### Changed

- auto-bump to chart v1.6.353 triggered by release tag(s): `agent-v0.175.1`

## [1.6.352] - 2026-07-14

### Changed

- auto-bump to chart v1.6.352 triggered by release tag(s): `task-store-v0.89.0`

## [1.6.351] - 2026-07-14

### Changed

- auto-bump to chart v1.6.351 triggered by release tag(s): `agent-v0.175.0`

## [1.6.350] - 2026-07-14

### Changed

- auto-bump to chart v1.6.350 triggered by release tag(s): `admin-v0.190.1`

## [1.6.349] - 2026-07-14

### Changed

- auto-bump to chart v1.6.349 triggered by release tag(s): `agent-v0.174.3`

## [1.6.348] - 2026-07-14

### Changed

- auto-bump to chart v1.6.348 triggered by release tag(s): `agent-v0.174.3`, `task-store-v0.88.0`

## [1.6.347] - 2026-07-14

### Changed

- auto-bump to chart v1.6.347 triggered by release tag(s): `metrics-v0.152.0`

## [1.6.346] - 2026-07-14

### Changed

- auto-bump to chart v1.6.346 triggered by release tag(s): `agent-v0.174.2`

## [1.6.345] - 2026-07-14

### Changed

- auto-bump to chart v1.6.345 triggered by release tag(s): `agent-v0.174.1`

## [1.6.344] - 2026-07-14

### Changed

- auto-bump to chart v1.6.344 triggered by release tag(s): `agent-v0.174.0`

## [1.6.343] - 2026-07-13

### Changed

- auto-bump to chart v1.6.343 triggered by release tag(s): `admin-v0.190.0`

## [1.6.342] - 2026-07-13

### Changed

- auto-bump to chart v1.6.342 triggered by release tag(s): `admin-v0.189.3`, `agent-v0.173.3`, `chat-v0.39.1`, `metrics-v0.151.1`, `task-store-v0.87.2`

## [1.6.341] - 2026-07-12

### Changed

- auto-bump to chart v1.6.341 triggered by release tag(s): `admin-v0.189.0`, `agent-v0.173.0`

## [1.6.340] - 2026-07-11

### Fixed

- `global.imageRegistry` no longer double-prefixes the fully-qualified
  `ghcr.io/app-vitals` service image repositories (admin, metrics, taskStore,
  chat). A shared `shipwright.imageRef` helper detects a fully-qualified
  repository (a registry host in the first `/`-delimited segment) and only
  applies the `global.imageRegistry` prefix to bare repository names.

## [1.6.339] - 2026-07-11

### Changed

- Default image values are now fully-qualified, pinned GHCR references
  (`ghcr.io/app-vitals/<service>:<tag>`) for all six shipwright service image
  blocks (admin, metrics, agent, agent provisioning, taskStore, chat),
  replacing the bare repository name + `appVersion`-fallback `tag: ""`
  defaults.
- `auto-bump-chart.yml` now pins each batch's released tag(s) directly into
  the matching `values.yaml` `image.tag` path(s) on every auto-bump, keeping
  chart defaults in sync with the services they package instead of only
  bumping the chart version.

## [1.6.338] - 2026-07-11

### Changed

- Pin exact GHCR image tags in `values.yaml` defaults for all six shipwright
  service image blocks (admin, metrics, agent, agent provisioning, taskStore,
  chat), replacing the bare repository name + `appVersion`-fallback `tag: ""`
  defaults.

## [1.6.337] - 2026-07-11

### Changed

- auto-bump to chart v1.6.337 triggered by release tag(s): `admin-v0.188.0`, `agent-v0.172.0`, `chat-v0.38.0`, `metrics-v0.150.0`, `task-store-v0.86.0`

## [1.6.336] - 2026-07-10

### Changed

- auto-bump to chart v1.6.336 triggered by release tag(s): `admin-v0.187.1`, `agent-v0.171.2`, `chat-v0.37.1`, `metrics-v0.149.1`, `task-store-v0.85.1`

## [1.6.335] - 2026-07-10

### Changed

- auto-bump to chart v1.6.335 triggered by release tag(s): `agent-v0.171.1`

## [1.6.334] - 2026-07-10

### Changed

- auto-bump to chart v1.6.334 triggered by release tag(s): `admin-v0.187.0`, `agent-v0.171.0`, `chat-v0.37.0`, `metrics-v0.149.0`, `task-store-v0.85.0`

## [1.6.333] - 2026-07-10

### Changed

- auto-bump to chart v1.6.333 triggered by release tag(s): `agent-v0.170.0`

## [1.6.332] - 2026-07-10

### Changed

- auto-bump to chart v1.6.332 triggered by release tag(s): `agent-v0.169.2`

## [1.6.331] - 2026-07-10

### Changed

- auto-bump to chart v1.6.331 triggered by release tag(s): `admin-v0.186.1`, `agent-v0.169.1`, `chat-v0.36.1`, `metrics-v0.148.1`, `task-store-v0.84.1`

## [1.6.330] - 2026-07-10

### Changed

- auto-bump to chart v1.6.330 triggered by release tag(s): `admin-v0.186.0`, `agent-v0.169.0`, `chat-v0.36.0`, `metrics-v0.148.0`, `task-store-v0.84.0`

## [1.6.329] - 2026-07-09

### Changed

- auto-bump to chart v1.6.329 triggered by release tag(s): `agent-v0.168.0`

## [1.6.328] - 2026-07-09

### Changed

- auto-bump to chart v1.6.328 triggered by release tag(s): `admin-v0.185.0`, `agent-v0.167.0`

## [1.6.327] - 2026-07-09

### Changed

- auto-bump to chart v1.6.327 triggered by release tag(s): `agent-v0.166.0`

## [1.6.326] - 2026-07-09

### Changed

- auto-bump to chart v1.6.326 triggered by release tag(s): `agent-v0.165.0`

## [1.6.325] - 2026-07-09

### Changed

- auto-bump to chart v1.6.325 triggered by release tag(s): `admin-v0.184.0`

## [1.6.324] - 2026-07-09

### Changed

- auto-bump to chart v1.6.324 triggered by release tag(s): `admin-v0.183.0`

## [1.6.323] - 2026-07-09

### Changed

- auto-bump to chart v1.6.323 triggered by release tag(s): `agent-v0.164.0`

## [1.6.322] - 2026-07-09

### Changed

- auto-bump to chart v1.6.322 triggered by release tag(s): `admin-v0.182.0`, `agent-v0.163.0`

## [1.6.321] - 2026-07-09

### Changed

- auto-bump to chart v1.6.321 triggered by release tag(s): `admin-v0.181.0`, `metrics-v0.147.0`, `task-store-v0.83.0`

## [1.6.320] - 2026-07-09

### Changed

- auto-bump to chart v1.6.320 triggered by release tag(s): `admin-v0.180.0`, `agent-v0.162.0`, `chat-v0.35.0`, `metrics-v0.146.0`, `task-store-v0.82.0`

## [1.6.319] - 2026-07-09

### Changed

- auto-bump to chart v1.6.319 triggered by release tag(s): `agent-v0.161.0`

## [1.6.318] - 2026-07-09

### Changed

- auto-bump to chart v1.6.318 triggered by release tag(s): `admin-v0.178.0`, `agent-v0.160.0`

## [1.6.317] - 2026-07-09

### Changed

- auto-bump to chart v1.6.317 triggered by release tag(s): `admin-v0.176.0`

## [1.6.316] - 2026-07-09

### Changed

- auto-bump to chart v1.6.316 triggered by release tag(s): `admin-v0.175.0`

## [1.6.315] - 2026-07-09

### Changed

- auto-bump to chart v1.6.315 triggered by release tag(s): `admin-v0.174.0`, `agent-v0.159.0`, `chat-v0.32.0`, `metrics-v0.143.0`, `task-store-v0.79.0`

## [1.6.314] - 2026-07-09

### Changed

- auto-bump to chart v1.6.314 triggered by release tag(s): `admin-v0.173.0`, `metrics-v0.142.0`

## [1.6.313] - 2026-07-09

### Changed

- auto-bump to chart v1.6.313 triggered by release tag(s): `agent-v0.158.1`

## [1.6.312] - 2026-07-09

### Changed

- auto-bump to chart v1.6.312 triggered by release tag(s): `admin-v0.172.0`, `agent-v0.158.0`, `chat-v0.31.0`, `metrics-v0.141.0`, `task-store-v0.78.0`

## [1.6.311] - 2026-07-09

### Changed

- auto-bump to chart v1.6.311 triggered by release tag(s): `agent-v0.157.2`

## [1.6.310] - 2026-07-09

### Changed

- auto-bump to chart v1.6.310 triggered by release tag(s): `admin-v0.171.0`, `agent-v0.157.1`, `chat-v0.30.0`, `metrics-v0.140.0`, `task-store-v0.77.0`

## [1.6.309] - 2026-07-09

### Changed

- auto-bump to chart v1.6.309 triggered by release tag(s): `agent-v0.157.0`

## [1.6.308] - 2026-07-08

### Changed

- auto-bump to chart v1.6.308 triggered by release tag(s): `admin-v0.170.0`, `chat-v0.29.0`

## [1.6.307] - 2026-07-08

### Changed

- auto-bump to chart v1.6.307 triggered by release tag(s): `admin-v0.169.0`, `agent-v0.156.0`, `chat-v0.28.0`, `metrics-v0.139.0`, `task-store-v0.76.0`

## [1.6.306] - 2026-07-08

### Changed

- auto-bump to chart v1.6.306 triggered by release tag(s): `agent-v0.155.0`

## [1.6.305] - 2026-07-08

### Changed

- auto-bump to chart v1.6.305 triggered by release tag(s): `admin-v0.168.0`, `agent-v0.154.0`, `chat-v0.27.0`, `metrics-v0.138.0`, `task-store-v0.75.0`

## [1.6.304] - 2026-07-08

### Changed

- auto-bump to chart v1.6.304 triggered by release tag(s): `agent-v0.153.1`

## [1.6.303] - 2026-07-08

### Changed

- auto-bump to chart v1.6.303 triggered by release tag(s): `admin-v0.167.0`, `agent-v0.153.0`, `chat-v0.26.0`, `metrics-v0.137.0`, `task-store-v0.74.0`

## [1.6.302] - 2026-07-08

### Changed

- auto-bump to chart v1.6.302 triggered by release tag `agent-v0.152.0`

## [1.6.301] - 2026-07-08

### Changed

- auto-bump to chart v1.6.301 triggered by release tag `admin-v0.166.0`

## [1.6.300] - 2026-07-07

### Changed

- auto-bump to chart v1.6.300 triggered by release tag `agent-v0.151.0`

## [1.6.299] - 2026-07-07

### Changed

- auto-bump to chart v1.6.299 triggered by release tag `admin-v0.165.0`

## [1.6.298] - 2026-07-07

### Changed

- auto-bump to chart v1.6.298 triggered by release tag `admin-v0.164.0`

## [1.6.297] - 2026-07-07

### Changed

- auto-bump to chart v1.6.297 triggered by release tag `admin-v0.163.0`

## [1.6.296] - 2026-07-06

### Changed

- auto-bump to chart v1.6.296 triggered by release tag `agent-v0.150.0`

## [1.6.295] - 2026-07-06

### Changed

- auto-bump to chart v1.6.295 triggered by release tag `metrics-v0.135.0`

## [1.6.294] - 2026-07-06

### Added

- metrics: optional SENTRY_DSN/SENTRY_ENVIRONMENT env passthrough for Sentry error reporting

## [1.6.293] - 2026-07-06

### Changed

- auto-bump to chart v1.6.293 triggered by release tag `agent-v0.149.0`

## [1.6.292] - 2026-07-06

### Changed

- auto-bump to chart v1.6.292 triggered by release tag `metrics-v0.134.0`

## [1.6.291] - 2026-07-06

### Added

- optional SENTRY_DSN/SENTRY_ENVIRONMENT env passthrough for the admin service

## [1.6.290] - 2026-07-06

### Changed

- auto-bump to chart v1.6.290 triggered by release tag `agent-v0.148.0`

## [1.6.289] - 2026-07-06

### Changed

- auto-bump to chart v1.6.289 triggered by release tag `admin-v0.160.0`

## [1.6.288] - 2026-07-06

### Changed

- auto-bump to chart v1.6.288 triggered by release tag `task-store-v0.69.0`

## [1.6.287] - 2026-07-06

### Changed

- auto-bump to chart v1.6.287 triggered by release tag `admin-v0.159.0`

## [1.6.286] - 2026-07-06

### Changed

- auto-bump to chart v1.6.286 triggered by release tag `agent-v0.147.1`

## [1.6.285] - 2026-07-06

### Changed

- auto-bump to chart v1.6.285 triggered by release tag `agent-v0.147.0`

## [1.6.284] - 2026-07-06

### Changed

- auto-bump to chart v1.6.284 triggered by release tag `agent-v0.146.0`

## [1.6.283] - 2026-07-06

### Changed

- auto-bump to chart v1.6.283 triggered by release tag `admin-v0.158.0`

## [1.6.282] - 2026-07-06

### Changed

- auto-bump to chart v1.6.282 triggered by release tag `agent-v0.145.0`

## [1.6.281] - 2026-07-06

### Changed

- auto-bump to chart v1.6.281 triggered by release tag `metrics-v0.132.0`

## [1.6.280] - 2026-07-06

### Changed

- auto-bump to chart v1.6.280 triggered by release tag `agent-v0.144.0`

## [1.6.279] - 2026-07-06

### Changed

- auto-bump to chart v1.6.279 triggered by release tag `admin-v0.156.0`

## [1.6.278] - 2026-07-06

### Changed

- auto-bump to chart v1.6.278 triggered by release tag `agent-v0.143.1`

## [1.6.277] - 2026-07-06

### Changed

- auto-bump to chart v1.6.277 triggered by release tag `task-store-v0.66.0`

## [1.6.276] - 2026-07-06

### Changed

- auto-bump to chart v1.6.276 triggered by release tag `agent-v0.143.0`

## [1.6.275] - 2026-07-06

### Changed

- auto-bump to chart v1.6.275 triggered by release tag `agent-v0.142.0`

## [1.6.274] - 2026-07-06

### Changed

- auto-bump to chart v1.6.274 triggered by release tag `agent-v0.141.0`

## [1.6.273] - 2026-07-06

### Changed

- auto-bump to chart v1.6.273 triggered by release tag `task-store-v0.65.0`

## [1.6.272] - 2026-07-06

### Changed

- auto-bump to chart v1.6.272 triggered by release tag `task-store-v0.64.0`

## [1.6.271] - 2026-07-06

### Changed

- auto-bump to chart v1.6.271 triggered by release tag `agent-v0.140.0`

## [1.6.270] - 2026-07-06

### Changed

- auto-bump to chart v1.6.270 triggered by release tag `admin-v0.154.0`

## [1.6.269] - 2026-07-06

### Changed

- auto-bump to chart v1.6.269 triggered by release tag `agent-v0.139.2`

## [1.6.268] - 2026-07-06

### Changed

- auto-bump to chart v1.6.268 triggered by release tag `chat-v0.18.1`

## [1.6.267] - 2026-07-06

### Changed

- auto-bump to chart v1.6.267 triggered by release tag `admin-v0.153.1`

## [1.6.266] - 2026-07-06

### Changed

- auto-bump to chart v1.6.266 triggered by release tag `task-store-v0.62.1`

## [1.6.265] - 2026-07-06

### Changed

- auto-bump to chart v1.6.265 triggered by release tag `agent-v0.139.1`

## [1.6.264] - 2026-07-06

### Changed

- auto-bump to chart v1.6.264 triggered by release tag `chat-v0.18.0`

## [1.6.263] - 2026-07-06

### Changed

- auto-bump to chart v1.6.263 triggered by release tag `agent-v0.139.0`

## [1.6.262] - 2026-07-06

### Changed

- auto-bump to chart v1.6.262 triggered by release tag `agent-v0.138.0`

## [1.6.261] - 2026-07-06

### Changed

- auto-bump to chart v1.6.261 triggered by release tag `metrics-v0.127.0`

## [1.6.260] - 2026-07-06

### Changed

- auto-bump to chart v1.6.260 triggered by release tag `agent-v0.137.0`

## [1.6.259] - 2026-07-06

### Changed

- auto-bump to chart v1.6.259 triggered by release tag `chat-v0.16.0`

## [1.6.258] - 2026-07-06

### Changed

- auto-bump to chart v1.6.258 triggered by release tag `metrics-v0.126.0`

## [1.6.257] - 2026-07-06

### Changed

- auto-bump to chart v1.6.257 triggered by release tag `agent-v0.135.1`

## [1.6.256] - 2026-07-06

### Changed

- auto-bump to chart v1.6.256 triggered by release tag `admin-v0.150.0`

## [1.6.255] - 2026-07-06

### Changed

- auto-bump to chart v1.6.255 triggered by release tag `chat-v0.15.0`

## [1.6.254] - 2026-07-06

### Added

- task-store: optional SENTRY_DSN/SENTRY_ENVIRONMENT env passthrough for Sentry error reporting

## [1.6.253] - 2026-07-06

### Changed

- auto-bump to chart v1.6.253 triggered by release tag `agent-v0.134.0`

## [1.6.252] - 2026-07-06

### Changed

- auto-bump to chart v1.6.252 triggered by release tag `task-store-v0.58.0`

## [1.6.251] - 2026-07-05

### Changed

- auto-bump to chart v1.6.251 triggered by release tag `admin-v0.148.0`

## [1.6.250] - 2026-07-05

### Changed

- auto-bump to chart v1.6.250 triggered by release tag `agent-v0.133.0`

## [1.6.249] - 2026-07-05

### Changed

- auto-bump to chart v1.6.249 triggered by release tag `agent-v0.132.0`

## [1.6.248] - 2026-07-05

### Changed

- auto-bump to chart v1.6.248 triggered by release tag `chat-v0.13.1`

## [1.6.247] - 2026-07-05

### Changed

- auto-bump to chart v1.6.247 triggered by release tag `metrics-v0.123.0`

## [1.6.246] - 2026-07-05

### Changed

- auto-bump to chart v1.6.246 triggered by release tag `task-store-v0.57.0`

## [1.6.245] - 2026-07-04

### Changed

- auto-bump to chart v1.6.245 triggered by release tag `metrics-v0.122.1`

## [1.6.244] - 2026-07-04

### Changed

- auto-bump to chart v1.6.244 triggered by release tag `admin-v0.146.1`

## [1.6.243] - 2026-07-04

### Changed

- auto-bump to chart v1.6.243 triggered by release tag `task-store-v0.56.0`

## [1.6.242] - 2026-07-04

### Changed

- auto-bump to chart v1.6.242 triggered by release tag `chat-v0.12.0`

## [1.6.241] - 2026-07-04

### Changed

- auto-bump to chart v1.6.241 triggered by release tag `agent-v0.131.0`

## [1.6.240] - 2026-07-04

### Changed

- auto-bump to chart v1.6.240 triggered by release tag `agent-v0.130.1`

## [1.6.239] - 2026-07-04

### Changed

- auto-bump to chart v1.6.239 triggered by release tag `metrics-v0.121.0`

## [1.6.238] - 2026-07-04

### Changed

- auto-bump to chart v1.6.238 triggered by release tag `agent-v0.130.0`

## [1.6.237] - 2026-07-04

### Changed

- auto-bump to chart v1.6.237 triggered by release tag `agent-v0.129.0`

## [1.6.236] - 2026-07-04

### Changed

- auto-bump to chart v1.6.236 triggered by release tag `agent-v0.128.1`

## [1.6.235] - 2026-07-04

### Changed

- auto-bump to chart v1.6.235 triggered by release tag `admin-v0.144.0`

## [1.6.234] - 2026-07-04

### Changed

- auto-bump to chart v1.6.234 triggered by release tag `agent-v0.128.0`

## [1.6.233] - 2026-07-04

### Changed

- auto-bump to chart v1.6.233 triggered by release tag `agent-v0.127.0`

## [1.6.232] - 2026-07-04

### Changed

- auto-bump to chart v1.6.232 triggered by release tag `admin-v0.143.0`

## [1.6.231] - 2026-07-04

### Changed

- auto-bump to chart v1.6.231 triggered by release tag `admin-v0.142.1`

## [1.6.230] - 2026-07-04

### Changed

- auto-bump to chart v1.6.230 triggered by release tag `agent-v0.126.1`

## [1.6.229] - 2026-07-04

### Changed

- auto-bump to chart v1.6.229 triggered by release tag `agent-v0.126.0`

## [1.6.228] - 2026-07-04

### Changed

- auto-bump to chart v1.6.228 triggered by release tag `admin-v0.141.0`

## [1.6.227] - 2026-07-04

### Changed

- auto-bump to chart v1.6.227 triggered by release tag `agent-v0.125.0`

## [1.6.226] - 2026-07-04

### Changed

- auto-bump to chart v1.6.226 triggered by release tag `metrics-v0.119.0`

## [1.6.225] - 2026-07-04

### Changed

- auto-bump to chart v1.6.225 triggered by release tag `metrics-v0.118.0`

## [1.6.224] - 2026-07-04

### Changed

- auto-bump to chart v1.6.224 triggered by release tag `metrics-v0.117.5`

## [1.6.223] - 2026-07-04

### Changed

- auto-bump to chart v1.6.223 triggered by release tag `admin-v0.140.5`

## [1.6.222] - 2026-07-04

### Changed

- auto-bump to chart v1.6.222 triggered by release tag `task-store-v0.53.4`

## [1.6.221] - 2026-07-04

### Changed

- auto-bump to chart v1.6.221 triggered by release tag `metrics-v0.117.3`

## [1.6.220] - 2026-07-04

### Changed

- auto-bump to chart v1.6.220 triggered by release tag `task-store-v0.53.0`

## [1.6.219] - 2026-07-04

### Changed

- auto-bump to chart v1.6.219 triggered by release tag `agent-v0.124.0`

## [1.6.218] - 2026-07-04

### Changed

- auto-bump to chart v1.6.218 triggered by release tag `chat-v0.8.1`

## [1.6.217] - 2026-07-04

### Changed

- auto-bump to chart v1.6.217 triggered by release tag `agent-v0.123.1`

## [1.6.216] - 2026-07-04

### Changed

- auto-bump to chart v1.6.216 triggered by release tag `task-store-v0.52.0`

## [1.6.215] - 2026-07-03

### Changed

- auto-bump to chart v1.6.215 triggered by release tag `agent-v0.123.0`

## [1.6.214] - 2026-07-03

### Changed

- auto-bump to chart v1.6.214 triggered by release tag `agent-v0.122.0`

## [1.6.213] - 2026-07-03

### Changed

- auto-bump to chart v1.6.213 triggered by release tag `task-store-v0.51.0`

## [1.6.212] - 2026-07-03

### Changed

- auto-bump to chart v1.6.212 triggered by release tag `task-store-v0.50.1`

## [1.6.211] - 2026-07-03

### Changed

- auto-bump to chart v1.6.211 triggered by release tag `agent-v0.121.1`

## [1.6.210] - 2026-07-03

### Changed

- auto-bump to chart v1.6.210 triggered by release tag `agent-v0.121.0`

## [1.6.209] - 2026-07-03

### Changed

- auto-bump to chart v1.6.209 triggered by release tag `admin-v0.138.0`

## [1.6.208] - 2026-07-03

### Changed

- auto-bump to chart v1.6.208 triggered by release tag `chat-v0.7.0`

## [1.6.206] - 2026-07-03

### Changed

- auto-bump to chart v1.6.206 triggered by release tag `agent-v0.120.0`

## [1.6.205] - 2026-07-03

### Changed

- auto-bump to chart v1.6.205 triggered by release tag `admin-v0.137.0`

## [1.6.204] - 2026-07-03

### Changed

- auto-bump to chart v1.6.204 triggered by release tag `agent-v0.119.0`

## [1.6.203] - 2026-07-03

### Changed

- auto-bump to chart v1.6.203 triggered by release tag `agent-v0.118.1`

## [1.6.202] - 2026-07-03

### Changed

- auto-bump to chart v1.6.202 triggered by release tag `agent-v0.118.0`

## [1.6.201] - 2026-07-03

### Changed

- auto-bump to chart v1.6.201 triggered by release tag `agent-v0.117.0`

## [1.6.200] - 2026-07-03

### Changed

- auto-bump to chart v1.6.200 triggered by release tag `agent-v0.116.0`

## [1.6.199] - 2026-07-03

### Changed

- auto-bump to chart v1.6.199 triggered by release tag `chat-v0.5.0`

## [1.6.198] - 2026-07-03

### Changed

- auto-bump to chart v1.6.198 triggered by release tag `task-store-v0.48.0`

## [1.6.197] - 2026-07-03

### Changed

- auto-bump to chart v1.6.197 triggered by release tag `admin-v0.134.0`

## [1.6.196] - 2026-07-03

### Changed

- auto-bump to chart v1.6.196 triggered by release tag `chat-v0.4.0`

## [1.6.195] - 2026-07-03

### Changed

- auto-bump to chart v1.6.195 triggered by release tag `admin-v0.133.0`

## [1.6.194] - 2026-07-02

### Changed

- auto-bump to chart v1.6.194 triggered by release tag `chat-v0.3.0`

## [1.6.193] - 2026-07-02

### Changed

- auto-bump to chart v1.6.193 triggered by release tag `agent-v0.114.0`

## [1.6.192] - 2026-07-02

### Changed

- auto-bump to chart v1.6.192 triggered by release tag `metrics-v0.112.0`

## [1.6.191] - 2026-07-02

### Changed

- auto-bump to chart v1.6.191 triggered by release tag `agent-v0.113.1`

## [1.6.190] - 2026-07-02

### Changed

- auto-bump to chart v1.6.190 triggered by release tag `agent-v0.113.0`

## [1.6.189] - 2026-07-02

### Changed

- auto-bump to chart v1.6.189 triggered by release tag `admin-v0.131.1`

## [1.6.188] - 2026-07-02

### Changed

- auto-bump to chart v1.6.188 triggered by release tag `chat-v0.2.0`

## [1.6.187] - 2026-07-02

### Changed

- auto-bump to chart v1.6.187 triggered by release tag `task-store-v0.46.0`

## [1.6.186] - 2026-07-02

### Changed

- auto-bump to chart v1.6.186 triggered by release tag `metrics-v0.110.0`

## [1.6.185] - 2026-07-02

### Changed

- auto-bump to chart v1.6.185 triggered by release tag `agent-v0.112.2`

## [1.6.184] - 2026-07-02

### Changed

- auto-bump to chart v1.6.184 triggered by release tag `agent-v0.112.1`

## [1.6.183] - 2026-07-02

### Changed

- auto-bump to chart v1.6.183 triggered by release tag `agent-v0.112.0`

## [1.6.182] - 2026-07-02

### Changed

- auto-bump to chart v1.6.182 triggered by release tag `admin-v0.130.0`

## [1.6.181] - 2026-07-02

### Changed

- auto-bump to chart v1.6.181 triggered by release tag `metrics-v0.109.0`

## [1.6.180] - 2026-07-02

### Changed

- auto-bump to chart v1.6.180 triggered by release tag `agent-v0.111.0`

## [1.6.179] - 2026-07-02

### Changed

- auto-bump to chart v1.6.179 triggered by release tag `task-store-v0.44.0`

## [1.6.178] - 2026-07-02

### Changed

- auto-bump to chart v1.6.178 triggered by release tag `metrics-v0.108.0`

## [1.6.177] - 2026-07-02

### Changed

- auto-bump to chart v1.6.177 triggered by release tag `agent-v0.110.1`

## [1.6.176] - 2026-07-02

### Changed

- auto-bump to chart v1.6.176 triggered by release tag `agent-v0.110.0`

## [1.6.175] - 2026-07-02

### Changed

- auto-bump to chart v1.6.175 triggered by release tag `agent-v0.109.0`

## [1.6.174] - 2026-07-02

### Changed

- auto-bump to chart v1.6.174 triggered by release tag `chat-v0.0.1`

## [1.6.173] - 2026-07-02

### Added

- chat service Deployment, Service, ServiceAccount, and CI workflow (CHT-2.1)
- Helm unit tests for chat workload (`chat_workload_test.yaml`, 7 test cases)

### Fixed

- `docs/deploy-kubernetes.md`: correct chat env vars to `chat.extraEnv` (not `admin.env`)

## [1.6.172] - 2026-07-02

### Changed

- auto-bump to chart v1.6.172 triggered by release tag `agent-v0.108.0`

## [1.6.171] - 2026-07-02

### Changed

- auto-bump to chart v1.6.171 triggered by release tag `agent-v0.107.1`

## [1.6.170] - 2026-07-02

### Changed

- auto-bump to chart v1.6.170 triggered by release tag `agent-v0.107.0`

## [1.6.169] - 2026-07-02

### Changed

- auto-bump to chart v1.6.169 triggered by release tag `metrics-v0.107.0`

## [1.6.168] - 2026-07-02

### Changed

- auto-bump to chart v1.6.168 triggered by release tag `task-store-v0.43.0`

## [1.6.167] - 2026-07-02

### Added

- chat service Deployment, Service, ServiceAccount, and CI workflow (CHT-2.1)

### Changed

- auto-bump to chart v1.6.167 triggered by release tag `metrics-v0.106.0`

## [1.6.166] - 2026-07-02

### Changed

- auto-bump to chart v1.6.166 triggered by release tag `admin-v0.128.0`

## [1.6.165] - 2026-07-02

### Changed

- auto-bump to chart v1.6.165 triggered by release tag `admin-v0.127.0`

## [1.6.164] - 2026-07-02

### Changed

- auto-bump to chart v1.6.164 triggered by release tag `metrics-v0.105.0`

## [1.6.163] - 2026-07-02

### Changed

- auto-bump to chart v1.6.163 triggered by release tag `agent-v0.106.0`

## [1.6.162] - 2026-07-02

### Changed

- auto-bump to chart v1.6.162 triggered by release tag `admin-v0.126.0`

## [1.6.161] - 2026-07-02

### Changed

- auto-bump to chart v1.6.161 triggered by release tag `admin-v0.125.1`

## [1.6.160] - 2026-07-02

### Changed

- auto-bump to chart v1.6.160 triggered by release tag `admin-v0.125.0`

## [1.6.159] - 2026-07-02

### Changed

- auto-bump to chart v1.6.159 triggered by release tag `admin-v0.124.0`

## [1.6.158] - 2026-07-02

### Changed

- auto-bump to chart v1.6.158 triggered by release tag `task-store-v0.41.0`

## [1.6.157] - 2026-07-02

### Changed

- auto-bump to chart v1.6.157 triggered by release tag `metrics-v0.103.0`

## [1.6.156] - 2026-07-02

### Changed

- auto-bump to chart v1.6.156 triggered by release tag `agent-v0.105.0`

## [1.6.155] - 2026-07-01

### Changed

- auto-bump to chart v1.6.155 triggered by release tag `agent-v0.104.0`

## [1.6.154] - 2026-07-01

### Changed

- auto-bump to chart v1.6.154 triggered by release tag `admin-v0.122.0`

## [1.6.153] - 2026-07-01

### Changed

- auto-bump to chart v1.6.153 triggered by release tag `agent-v0.103.0`

## [1.6.152] - 2026-07-01

### Changed

- auto-bump to chart v1.6.152 triggered by release tag `admin-v0.121.0`

## [1.6.151] - 2026-07-01

### Changed

- auto-bump to chart v1.6.151 triggered by release tag `metrics-v0.101.2`

## [1.6.150] - 2026-07-01

### Changed

- auto-bump to chart v1.6.150 triggered by release tag `task-store-v0.38.0`

## [1.6.149] - 2026-07-01

### Changed

- auto-bump to chart v1.6.149 triggered by release tag `metrics-v0.101.1`

## [1.6.148] - 2026-07-01

### Changed

- auto-bump to chart v1.6.148 triggered by release tag `metrics-v0.101.0`

## [1.6.147] - 2026-07-01

### Changed

- auto-bump to chart v1.6.147 triggered by release tag `agent-v0.102.0`

## [1.6.146] - 2026-07-01

### Changed

- auto-bump to chart v1.6.146 triggered by release tag `agent-v0.101.0`

## [1.6.145] - 2026-07-01

### Changed

- auto-bump to chart v1.6.145 triggered by release tag `admin-v0.120.1`

## [1.6.144] - 2026-07-01

### Changed

- auto-bump to chart v1.6.144 triggered by release tag `admin-v0.120.0`

## [1.6.143] - 2026-07-01

### Changed

- auto-bump to chart v1.6.143 triggered by release tag `metrics-v0.100.0`

## [1.6.142] - 2026-07-01

### Changed

- auto-bump to chart v1.6.142 triggered by release tag `agent-v0.100.2`

## [1.6.141] - 2026-07-01

### Changed

- auto-bump to chart v1.6.141 triggered by release tag `agent-v0.100.1`

## [1.6.140] - 2026-06-30

### Changed

- auto-bump to chart v1.6.140 triggered by release tag `agent-v0.100.0`

## [1.6.139] - 2026-06-30

### Changed

- auto-bump to chart v1.6.139 triggered by release tag `admin-v0.119.0`

## [1.6.138] - 2026-06-30

### Changed

- auto-bump to chart v1.6.138 triggered by release tag `agent-v0.99.0`

## [1.6.137] - 2026-06-30

### Changed

- auto-bump to chart v1.6.137 triggered by release tag `agent-v0.98.0`

## [1.6.136] - 2026-06-30

### Changed

- auto-bump to chart v1.6.136 triggered by release tag `task-store-v0.36.0`

## [1.6.135] - 2026-06-30

### Changed

- auto-bump to chart v1.6.135 triggered by release tag `metrics-v0.98.0`

## [1.6.134] - 2026-06-30

### Changed

- auto-bump to chart v1.6.134 triggered by release tag `admin-v0.117.0`

## [1.6.133] - 2026-06-30

### Changed

- auto-bump to chart v1.6.133 triggered by release tag `metrics-v0.97.0`

## [1.6.132] - 2026-06-30

### Changed

- auto-bump to chart v1.6.132 triggered by release tag `metrics-v0.96.0`

### Removed

- remove PostHog provider section from metrics deployment

## [1.6.131] - 2026-06-30

### Changed

- auto-bump to chart v1.6.131 triggered by release tag `admin-v0.116.0`

## [1.6.130] - 2026-06-30

### Changed

- auto-bump to chart v1.6.130 triggered by release tag `agent-v0.96.0`

## [1.6.129] - 2026-06-30

### Changed

- auto-bump to chart v1.6.129 triggered by release tag `admin-v0.115.0`

## [1.6.128] - 2026-06-30

### Changed

- auto-bump to chart v1.6.128 triggered by release tag `metrics-v0.95.0`

## [1.6.127] - 2026-06-29

### Changed

- auto-bump to chart v1.6.127 triggered by release tag `task-store-v0.34.0`

## [1.6.126] - 2026-06-29

### Changed

- auto-bump to chart v1.6.126 triggered by release tag `admin-v0.114.0`

## [1.6.125] - 2026-06-29

### Changed

- auto-bump to chart v1.6.125 triggered by release tag `metrics-v0.94.1`

## [1.6.124] - 2026-06-29

### Changed

- auto-bump to chart v1.6.124 triggered by release tag `metrics-v0.94.0`

## [1.6.123] - 2026-06-29

### Added

- `metrics.public.{enabled,repo}` to enable the unauthenticated, repo-scoped `/public/*` proof surface on the metrics service (injects `SHIPWRIGHT_METRICS_PUBLIC_MODE` + `SHIPWRIGHT_METRICS_PUBLIC_REPO`). `repo` is required when `enabled=true` (template fails fast at render). Backs the public dogfooding page (e.g. `proof.shipwrightharness.com`).

## [1.6.122] - 2026-06-29

### Changed

- auto-bump to chart v1.6.122 triggered by release tag `admin-v0.113.0`

## [1.6.121] - 2026-06-29

### Fixed

- correct stray-hyphen domain references to canonical `shipwrightharness.com` in CLAUDE.md, docs/architecture.md, and Chart.yaml
- add `metrics.provider.offline` to `values.schema.json` to satisfy `additionalProperties: false` constraint and unblock `helm lint`
- strengthen domain-guard regression test: `some()` → `every()` for required-files assertion; exclude test file itself from canonical-domain grep

## [1.6.120] - 2026-06-29

### Changed

- auto-bump to chart v1.6.120 triggered by release tag `metrics-v0.93.0`

## [1.6.119] - 2026-06-29

### Changed

- auto-bump to chart v1.6.119 triggered by release tag `task-store-v0.33.0`

## [1.6.118] - 2026-06-29

### Changed

- auto-bump to chart v1.6.118 triggered by release tag `agent-v0.95.0`

## [1.6.117] - 2026-06-28

### Added

- metrics: wire `METRICS_TASK_STORE_URL` + `METRICS_TASK_STORE_TOKEN` into the
  metrics Deployment via `metrics.provider.taskStoreUrl` and
  `metrics.provider.taskStoreToken`. Set `taskStoreUrl` alongside `adminUrl` to
  run the dashboard in TASKSTORE mode. Without this the provider selector falls
  through to the bundled SQLite store, which has no writable path in the
  published image and crash-loops on boot (`SQLITE_CANTOPEN`) — the regression
  introduced when metrics v0.91.0 replaced PostHog mode with task-store mode.

## [1.6.116] - 2026-06-29

### Changed

- auto-bump to chart v1.6.116 triggered by release tag `admin-v0.112.0`

## [1.6.115] - 2026-06-29

### Changed

- auto-bump to chart v1.6.115 triggered by release tag `metrics-v0.91.0`

## [1.6.114] - 2026-06-28

### Changed

- auto-bump to chart v1.6.114 triggered by release tag `agent-v0.94.0`

## [1.6.113] - 2026-06-28

### Changed

- auto-bump to chart v1.6.113 triggered by release tag `task-store-v0.32.0`

## [1.6.112] - 2026-06-28

### Changed

- auto-bump to chart v1.6.112 triggered by release tag `agent-v0.93.0`

## [1.6.111] - 2026-06-28

### Changed

- auto-bump to chart v1.6.111 triggered by release tag `agent-v0.92.0`

## [1.6.110] - 2026-06-28

### Changed

- auto-bump to chart v1.6.110 triggered by release tag `metrics-v0.90.0`

## [1.6.109] - 2026-06-28

### Changed

- auto-bump to chart v1.6.109 triggered by release tag `agent-v0.91.0`

## [1.6.108] - 2026-06-28

### Changed

- auto-bump to chart v1.6.108 triggered by release tag `agent-v0.90.0`

## [1.6.107] - 2026-06-28

### Changed

- auto-bump to chart v1.6.107 triggered by release tag `agent-v0.89.0`

## [1.6.106] - 2026-06-28

### Changed

- auto-bump to chart v1.6.106 triggered by release tag `admin-v0.111.0`

## [1.6.105] - 2026-06-28

### Changed

- auto-bump to chart v1.6.105 triggered by release tag `agent-v0.88.0`

## [1.6.104] - 2026-06-27

### Changed

- auto-bump to chart v1.6.104 triggered by release tag `task-store-v0.31.0`

## [1.6.103] - 2026-06-27

### Changed

- auto-bump to chart v1.6.103 triggered by release tag `agent-v0.87.0`

## [1.6.102] - 2026-06-27

### Changed

- auto-bump to chart v1.6.102 triggered by release tag `admin-v0.110.0`

## [1.6.101] - 2026-06-27

### Added

- `admin.taskStorePublicUrl` renders `SHIPWRIGHT_TASK_STORE_PUBLIC_URL` into the
  admin Deployment (only when set) so the mint-token success page advertises the
  externally-reachable task-store URL (e.g. `https://<host>/task-store` when
  `taskStore.expose.enabled`) instead of the internal cluster URL. Admin's own
  in-cluster task-store calls keep using the internal `SHIPWRIGHT_TASK_STORE_URL`;
  the env block falls back to that internal URL when this value is empty.

## [1.6.100] - 2026-06-27

### Added

- opt-in external route for the task-store API (`taskStore.expose.enabled`) via
  HTTPRoute (Gateway API) and Ingress, mounted under a configurable path prefix
  (`/task-store`) with prefix-strip so the task-store app's root routes are
  reachable. Guarded on `taskStore.enabled`; documented in
  `docs/deploy-kubernetes.md` (incl. AWS ALB rewrite caveat).

## [1.6.99] - 2026-06-27

### Changed

- auto-bump to chart v1.6.99 triggered by release tag `task-store-v0.30.0`

## [1.6.98] - 2026-06-27

### Changed

- auto-bump to chart v1.6.98 triggered by release tag `agent-v0.85.0`

## [1.6.97] - 2026-06-26

### Changed

- auto-bump to chart v1.6.97 triggered by release tag `agent-v0.84.0`

## [1.6.96] - 2026-06-26

### Changed

- auto-bump to chart v1.6.96 triggered by release tag `admin-v0.109.0`

## [1.6.95] - 2026-06-26

### Changed

- auto-bump to chart v1.6.95 triggered by release tag `admin-v0.108.0`

## [1.6.94] - 2026-06-26

### Changed

- auto-bump to chart v1.6.94 triggered by release tag `admin-v0.107.0`

## [1.6.93] - 2026-06-26

### Changed

- auto-bump to chart v1.6.93 triggered by release tag `admin-v0.106.0`

## [1.6.92] - 2026-06-26

### Changed

- auto-bump to chart v1.6.92 triggered by release tag `agent-v0.83.0`

## [1.6.91] - 2026-06-26

### Changed

- auto-bump to chart v1.6.91 triggered by release tag `task-store-v0.29.0`

## [1.6.90] - 2026-06-26

### Changed

- auto-bump to chart v1.6.90 triggered by release tag `agent-v0.82.0`

## [1.6.89] - 2026-06-26

### Changed

- auto-bump to chart v1.6.89 triggered by release tag `admin-v0.105.0`

## [1.6.88] - 2026-06-26

### Changed

- auto-bump to chart v1.6.88 triggered by release tag `agent-v0.81.0`

## [1.6.87] - 2026-06-26

### Changed

- auto-bump to chart v1.6.87 triggered by release tag `task-store-v0.28.0`

## [1.6.86] - 2026-06-26

### Changed

- auto-bump to chart v1.6.86 triggered by release tag `admin-v0.104.1`

## [1.6.85] - 2026-06-26

### Changed

- auto-bump to chart v1.6.85 triggered by release tag `admin-v0.104.0`

## [1.6.84] - 2026-06-26

### Changed

- auto-bump to chart v1.6.84 triggered by release tag `metrics-v0.89.1`

## [1.6.83] - 2026-06-26

### Changed

- auto-bump to chart v1.6.83 triggered by release tag `metrics-v0.89.0`

## [1.6.82] - 2026-06-26

### Changed

- auto-bump to chart v1.6.82 triggered by release tag `task-store-v0.27.0`

## [1.6.81] - 2026-06-26

### Changed

- auto-bump to chart v1.6.81 triggered by release tag `admin-v0.102.0`

## [1.6.80] - 2026-06-26

### Changed

- auto-bump to chart v1.6.80 triggered by release tag `task-store-v0.26.0`

## [1.6.79] - 2026-06-26

### Changed

- auto-bump to chart v1.6.79 triggered by release tag `agent-v0.80.0`

## [1.6.78] - 2026-06-26

### Changed

- auto-bump to chart v1.6.78 triggered by release tag `agent-v0.79.0`

## [1.6.77] - 2026-06-26

### Changed

- auto-bump to chart v1.6.77 triggered by release tag `task-store-v0.25.1`

## [1.6.76] - 2026-06-26

### Changed

- auto-bump to chart v1.6.76 triggered by release tag `task-store-v0.25.0`

## [1.6.75] - 2026-06-26

### Changed

- auto-bump to chart v1.6.75 triggered by release tag `admin-v0.101.0`

## [1.6.74] - 2026-06-26

### Changed

- auto-bump to chart v1.6.74 triggered by release tag `admin-v0.100.1`

## [1.6.73] - 2026-06-25

### Changed

- auto-bump to chart v1.6.73 triggered by release tag `task-store-v0.23.0`

## [1.6.72] - 2026-06-25

### Changed

- auto-bump to chart v1.6.72 triggered by release tag `metrics-v0.87.0`

## [1.6.71] - 2026-06-25

### Changed

- auto-bump to chart v1.6.71 triggered by release tag `admin-v0.99.0`

## [1.6.70] - 2026-06-25

### Changed

- auto-bump to chart v1.6.70 triggered by release tag `admin-v0.98.0`

## [1.6.69] - 2026-06-25

### Changed

- auto-bump to chart v1.6.69 triggered by release tag `agent-v0.78.0`

## [1.6.68] - 2026-06-25

### Changed

- auto-bump to chart v1.6.68 triggered by release tag `task-store-v0.22.1`

## [1.6.67] - 2026-06-25

### Changed

- auto-bump to chart v1.6.67 triggered by release tag `admin-v0.97.2`

## [1.6.66] - 2026-06-25

### Changed

- auto-bump to chart v1.6.66 triggered by release tag `admin-v0.97.1`

## [1.6.65] - 2026-06-25

### Changed

- auto-bump to chart v1.6.65 triggered by release tag `agent-v0.77.1`

## [1.6.64] - 2026-06-25

### Changed

- auto-bump to chart v1.6.64 triggered by release tag `agent-v0.77.0`

## [1.6.63] - 2026-06-25

### Changed

- auto-bump to chart v1.6.63 triggered by release tag `task-store-v0.22.0`

## [1.6.62] - 2026-06-25

### Changed

- auto-bump to chart v1.6.62 triggered by release tag `admin-v0.97.0`

## [1.6.61] - 2026-06-25

### Changed

- auto-bump to chart v1.6.61 triggered by release tag `agent-v0.76.0`

## [1.6.60] - 2026-06-25

### Changed

- auto-bump to chart v1.6.60 triggered by release tag `task-store-v0.21.0`

## [1.6.59] - 2026-06-25

### Changed

- auto-bump to chart v1.6.59 triggered by release tag `admin-v0.96.0`

## [1.6.58] - 2026-06-25

### Changed

- auto-bump to chart v1.6.58 triggered by release tag `agent-v0.75.0`

## [1.6.57] - 2026-06-25

### Changed

- auto-bump to chart v1.6.57 triggered by release tag `task-store-v0.20.0`

## [1.6.56] - 2026-06-25

### Changed

- auto-bump to chart v1.6.56 triggered by release tag `task-store-v0.19.0`

## [1.6.55] - 2026-06-25

### Changed

- auto-bump to chart v1.6.55 triggered by release tag `agent-v0.74.0`

## [1.6.54] - 2026-06-25

### Added

- admin-ui: show run stats (last run time, outcome badge, today's count) on cron job rows

## [1.6.53] - 2026-06-25

### Changed

- auto-bump to chart v1.6.53 triggered by release tag `agent-v0.73.0`

## [1.6.52] - 2026-06-25

### Changed

- auto-bump to chart v1.6.52 triggered by release tag `agent-v0.72.0`

## [1.6.51] - 2026-06-25

### Changed

- auto-bump to chart v1.6.51 triggered by release tag `task-store-v0.18.0`

## [1.6.50] - 2026-06-25

### Changed

- auto-bump to chart v1.6.50 triggered by release tag `task-store-v0.17.0`

## [1.6.49] - 2026-06-25

### Changed

- auto-bump to chart v1.6.49 triggered by release tag `admin-v0.94.0`

## [1.6.48] - 2026-06-25

### Changed

- auto-bump to chart v1.6.48 triggered by release tag `task-store-v0.16.0`

## [1.6.47] - 2026-06-25

### Changed

- auto-bump to chart v1.6.47 triggered by release tag `admin-v0.93.0`

## [1.6.46] - 2026-06-25

### Changed

- auto-bump to chart v1.6.46 triggered by release tag `admin-v0.92.0`

## [1.6.45] - 2026-06-25

### Changed

- auto-bump to chart v1.6.45 triggered by release tag `task-store-v0.15.0`

## [1.6.44] - 2026-06-25

### Changed

- auto-bump to chart v1.6.44 triggered by release tag `admin-v0.91.0`

## [1.6.43] - 2026-06-25

### Changed

- auto-bump to chart v1.6.43 triggered by release tag `admin-v0.90.0`

## [1.6.42] - 2026-06-25

### Changed

- auto-bump to chart v1.6.42 triggered by release tag `task-store-v0.14.0`

## [1.6.41] - 2026-06-24

### Added

- task-store `distinct` endpoint for filter autocomplete (sessions and repos)

## [1.6.40] - 2026-06-25

### Changed

- auto-bump to chart v1.6.40 triggered by release tag `task-store-v0.13.0`

## [1.6.39] - 2026-06-25

### Changed

- auto-bump to chart v1.6.39 triggered by release tag `admin-v0.89.0`

## [1.6.38] - 2026-06-25

### Changed

- auto-bump to chart v1.6.38 triggered by release tag `task-store-v0.12.0`

## [1.6.37] - 2026-06-25

### Changed

- auto-bump to chart v1.6.37 triggered by release tag `task-store-v0.11.0`

## [1.6.36] - 2026-06-25

### Added

- `taskStore.extraEnv` passthrough for additional env vars on the task-store pod (enables scope resolver wiring via `SHIPWRIGHT_TASK_STORE_AGENTS_URL` + `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY`)

### Changed

- auto-bump to chart v1.6.36 triggered by release tag `agent-v0.70.0`

## [1.6.34] - 2026-06-25

### Changed

- auto-bump to chart v1.6.34 triggered by release tag `task-store-v0.10.0`

## [1.6.33] - 2026-06-25

### Changed

- auto-bump to chart v1.6.33 triggered by release tag `task-store-v0.9.0`

## [1.6.32] - 2026-06-25

### Changed

- auto-bump to chart v1.6.32 triggered by release tag `agent-v0.69.1`

## [1.6.31] - 2026-06-24

### Changed

- auto-bump to chart v1.6.31 triggered by release tag `agent-v0.69.0`

## [1.6.30] - 2026-06-24

### Changed

- auto-bump to chart v1.6.30 triggered by release tag `metrics-v0.83.0`

## [1.6.29] - 2026-06-24

### Changed

- auto-bump to chart v1.6.29 triggered by release tag `admin-v0.87.0`

## [1.6.28] - 2026-06-24

### Changed

- auto-bump to chart v1.6.28 triggered by release tag `agent-v0.68.1`

## [1.6.27] - 2026-06-24

### Changed

- auto-bump to chart v1.6.27 triggered by release tag `admin-v0.86.0`

## [1.6.26] - 2026-06-24

### Changed

- auto-bump to chart v1.6.26 triggered by release tag `agent-v0.67.1`

## [1.6.25] - 2026-06-24

### Changed

- auto-bump to chart v1.6.25 triggered by release tag `agent-v0.67.0`

## [1.6.24] - 2026-06-24

### Changed

- Replace chart-releaser with direct gh-pages packaging for Helm chart releases (REL-2.2)

## [1.6.23] - 2026-06-24

### Changed

- auto-bump to chart v1.6.23 triggered by release tag `metrics-v0.81.0`

## [1.6.22] - 2026-06-24

### Changed

- Add bare platform-name banned-string patterns and exclude planning dir from check-strings

## [1.6.21] - 2026-06-24

### Changed

- auto-bump to chart v1.6.21 triggered by release tag `agent-v0.65.0`

## [1.6.20] - 2026-06-24

### Changed

- auto-bump to chart v1.6.20 triggered by release tag `task-store-v0.4.0`

## [1.6.19] - 2026-06-24

### Changed

- auto-bump to chart v1.6.19 triggered by release tag `admin-v0.84.0`

## [1.6.18] - 2026-06-24

### Changed

- auto-bump to chart v1.6.18 triggered by release tag `admin-v0.83.1`

## [1.6.17] - 2026-06-24

### Changed

- auto-bump to chart v1.6.17 triggered by release tag `agent-v0.64.1`

## [1.6.16] - 2026-06-24

### Changed

- auto-bump to chart v1.6.16 triggered by release tag `task-store-v0.3.0`

## [1.6.14] - 2026-06-24

### Fixed

- agent-provisioner RBAC: grant `patch`/`update` on Deployments (apps) so the
  reconcile path can strategic-merge-patch existing agent Deployments. Without
  these verbs, `POST /agents/reconcile` returned 200 but every agent failed with
  `cannot patch resource "deployments"` from the K8s API (SHI-1.3).

## [1.6.13] - 2026-06-24

### Changed

- auto-bump to chart v1.6.13 triggered by release tag `agent-v0.63.0`

## [1.6.12] - 2026-06-23

### Changed

- image-update detection and patching in reconcile (SHI-1.3)
- restore dispatch pipeline broken by #633

## [1.6.11] - 2026-06-23

### Added

- task-store HTTP adapter in the shipwright plugin; drop GitHub and Jira backends (TSS-2.1)

## [1.6.10] - 2026-06-23

### Changed

- auto-bump to chart v1.6.10 triggered by release tag `admin-v0.80.0`

## [1.6.9] - 2026-06-23

### Removed

- Deleted internal CI install-test config (no longer ships).
- Scrubbed all internal platform references from chart templates, tests, CHANGELOG, and docs; replaced with generic placeholders.

## [1.6.8] - 2026-06-23

### Changed

- auto-bump to chart v1.6.8 triggered by release tag `agent-v0.61.0`

## [1.6.7] - 2026-06-23

### Changed

- auto-bump to chart v1.6.7 triggered by release tag `admin-v0.79.1`

## [1.6.6] - 2026-06-23

### Changed

- Remove `ownerReferences` from provisioned agent Deployments, Secrets, and PVCs — ineffective cross-namespace and unsafe same-namespace (cascade-deletes all agents on admin uninstall)
- Align provisioned agent Deployment spec with Helm-managed agents: `strategy: Recreate`, `terminationGracePeriodSeconds: 120`, `readinessProbe`, `AGENT_HOME` env var, `fsGroupChangePolicy: OnRootMismatch`, `failureThreshold: 3` on liveness probe, `containerPort` declaration

## [1.6.5] - 2026-06-23

### Changed

- auto-bump to chart v1.6.5 triggered by release tag `admin-v0.79.0`

## [1.6.4] - 2026-06-22

### Added

- wire full manifest through provisioner for proper PVC mounts

## [1.6.3] - 2026-06-23

### Fixed

- bump chart version to 1.6.3 to resolve duplicate 1.6.2 release tag conflict

## [1.6.2] - 2026-06-23

### Changed

- auto-bump to chart v1.6.2 triggered by release tag `metrics-v0.79.0`

## [1.5.29] - 2026-06-22

### Changed

- auto-bump to chart v1.5.29 triggered by release tag `agent-v0.60.0`

## [1.5.28] - 2026-06-22

### Changed

- auto-bump to chart v1.5.28 triggered by release tag `agent-v0.59.0`

## [1.5.27] - 2026-06-20

### Changed

- auto-bump to chart v1.5.27 triggered by release tag `admin-v0.76.0`

## [1.5.26] - 2026-06-20

### Changed

- `agent.provisioning.pvcNameTemplate`: pass slug to provisioner callback as second arg; fallback to sanitized resource name when slug is absent; add console.warn when pvcNameTemplate is active and reconcile re-provisions without a slug

## [1.5.25] - 2026-06-20

### Changed

- auto-bump to chart v1.5.25 triggered by release tag `admin-v0.75.0`

## [1.5.24] - 2026-06-20

### Added

- `agent.provisioning.pvcNameTemplate`: optional PVC name template for provisioned agent home directories; `{name}` is replaced with the agent slug at provision time

## [1.5.23] - 2026-06-20

### Changed

- auto-bump to chart v1.5.23 triggered by release tag `agent-v0.57.0`

## [1.5.22] - 2026-06-19

### Changed

- auto-bump to chart v1.5.22 triggered by release tag `admin-v0.74.1`

## [1.5.21] - 2026-06-19

### Changed

- auto-bump to chart v1.5.21 triggered by release tag `admin-v0.74.0`

## [1.5.20] - 2026-06-19

### Changed

- auto-bump to chart v1.5.20 triggered by release tag `agent-v0.56.0`

## [1.5.19] - 2026-06-19

### Changed

- auto-bump to chart v1.5.19 triggered by release tag `metrics-v0.77.0`

## [1.5.18] - 2026-06-19

### Changed

- auto-bump to chart v1.5.18 triggered by release tag `admin-v0.72.0`

## [1.5.17] - 2026-06-19

### Changed

- auto-bump to chart v1.5.17 triggered by release tag `admin-v0.71.0`

## [1.5.16] - 2026-06-19

### Changed

- auto-bump to chart v1.5.16 triggered by release tag `metrics-v0.76.0`

## [1.5.15] - 2026-06-19

### Changed

- auto-bump to chart v1.5.15 triggered by release tag `agent-v0.53.1`

## [1.5.14] - 2026-06-19

### Changed

- auto-bump to chart v1.5.14 triggered by release tag `admin-v0.69.1`

## [1.5.13] - 2026-06-18

### Changed

- auto-bump to chart v1.5.13 triggered by release tag `admin-v0.69.0`

## [1.5.12] - 2026-06-18

### Changed

- auto-bump to chart v1.5.12 triggered by release tag `metrics-v0.75.0`

## [1.5.10] - 2026-06-18

### Changed

- auto-bump to chart v1.5.10 triggered by release tag `metrics-v0.74.14`

## [1.5.9] - 2026-06-18

### Changed

- auto-bump to chart v1.5.9 triggered by release tag `metrics-v0.74.12`

## [1.5.8] - 2026-06-18

### Changed

- auto-bump to chart v1.5.8 triggered by release tag `agent-v0.52.11`

## [1.5.7] - 2026-06-18

### Changed

- auto-bump to chart v1.5.7 triggered by release tag `agent-v0.52.10`

## [1.5.6] - 2026-06-18

### Changed

- auto-bump to chart v1.5.6 triggered by release tag `metrics-v0.74.7`

## [1.5.5] - 2026-06-18

### Changed

- auto-bump to chart v1.5.5 triggered by release tag `metrics-v0.74.6`

## [1.5.4] - 2026-06-18

### Changed

- auto-bump to chart v1.5.4 triggered by release tag `agent-v0.52.5`

## [1.5.3] - 2026-06-18

### Changed

- auto-bump to chart v1.5.3 triggered by release tag `admin-v0.68.4`

## [1.5.2] - 2026-06-18

### Changed

- auto-bump to chart v1.5.2 triggered by release tag `metrics-v0.74.2`

## [1.5.0]

### Added

- `agent-provisioning-rbac`: added a `persistentvolumeclaims` rule (`create`/`get`/`delete`) to the `agent-provisioner` Role, giving the provisioner the permissions it needs to manage workspace PVCs alongside Deployments and Secrets. Additive — no existing rules changed.

## [1.4.0]

### Added

- `agent.voice` block: agent voice (STT/TTS) as a deploy-time chart option. Disabled by default (`agent.voice.enabled=false`) — no Whisper pod/Service, no voice Secret, and the admin Deployment carries no voice env (provisioned agent pods keep their 3 base vars). When enabled:
  - `agent.voice.provider=whisper` renders a self-hosted Whisper ASR `Deployment` + `Service` (`templates/whisper-deployment.yaml`, `templates/whisper-service.yaml`) running `onerahmet/openai-whisper-asr-webservice:v1.3.0` — pinned to a concrete tag so `helm upgrade` cannot silently break the `POST /asr?task=transcribe&output=txt` plain-text contract the agent's whisper client targets. The in-cluster Service URL is injected into the admin Deployment as `WHISPER_SERVICE_URL` and flowed to provisioned agent pods by the admin provisioner.
  - `agent.voice.provider=groq` flows `GROQ_API_KEY` via the chart-managed voice Secret (`templates/voice-secret.yaml`) with no Whisper pod.
  - ElevenLabs TTS applies to both providers: `agent.voice.elevenlabs.apiKey` is stored in the voice Secret and injected as `ELEVENLABS_API_KEY`; the optional `agent.voice.elevenlabs.voiceId` is injected as the plain-value `ELEVENLABS_VOICE_ID`.
  - New values: `agent.voice.{enabled, provider, whisper.{image, service.port, resources}, elevenlabs.{apiKey, voiceId}, groq.apiKey}`, with matching `values.schema.json` constraints (`provider` enum `whisper | groq`).

## [1.3.0]

### Added

- `metrics.sessionSecret.existingSecret`: source the metrics service's `SHIPWRIGHT_SESSION_SECRET` from a caller-managed Secret instead of the chart-generated random. Point it at the same Secret the admin uses (`admin.encryptionKeys.existingSecret`) so admin-minted dashboard session JWTs validate at the metrics service when both sit behind a shared Gateway — a mismatch returns 401 on the dashboard's metrics view. `sessionSecretRef` selects the key within that Secret (defaults to `SHIPWRIGHT_SESSION_SECRET`). When set, the chart-managed metrics Secret omits `SHIPWRIGHT_SESSION_SECRET` and the Deployment injects it via `secretKeyRef` against the caller-managed Secret. Default empty preserves the existing generate-on-install / reuse-on-upgrade behaviour — purely additive.

## [1.2.0]

### Added

- `auth.google.existingSecret`: source `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` from a caller-managed Secret instead of inline Helm values. The chart-managed admin Secret omits these keys when the knob is set; the Deployment sources them via `secretKeyRef`. Allows fully secret-free helm installs when combined with `admin.encryptionKeys.existingSecret`.

## [1.1.0]

### Added

- `admin.encryptionKeys` block: source `SHIPWRIGHT_ENCRYPTION_KEY` and `SHIPWRIGHT_SESSION_SECRET` from a pre-existing Secret instead of generating random values on a fresh namespace install. Set `admin.encryptionKeys.existingSecret` to the Secret name; `encryptionKeyRef` and `sessionSecretRef` select the keys within it (default to the env var names). When set, the chart-managed Secret omits these two keys entirely and the Deployment injects them via `secretKeyRef` against the caller-managed Secret. Default is empty — existing generate-on-install / reuse-on-upgrade behaviour is unchanged.
- `admin.appBaseUrl`: sets `SHIPWRIGHT_ADMIN_APP_BASE_URL` in the admin container env when non-empty. Required when the admin service is behind a Gateway or Ingress so that OAuth redirect URIs reference the real public host rather than `localhost:3001`. Omitted from the env when left empty (default).
- `admin.extraEnv`: list of Kubernetes `envVar` objects appended to the admin container env. Provides a generic passthrough for env vars not otherwise covered by chart values. Defaults to `[]` (no extra vars).
- `networking.gateway.healthCheckPolicy.enabled`: when `true` and `networking.type=gateway`, renders a `networking.gke.io/v1 HealthCheckPolicy` for the admin Service and (when `metrics.enabled=true`) a second one for the metrics Service, both probing `/health` with 15 s interval / 5 s timeout / 1 healthy / 2 unhealthy thresholds. Without this the GKE Gateway controller default-probes `"/"` (both services → 404) and marks the backends UNHEALTHY, returning 503 on the external host. Disabled by default (`false`) so non-GKE Gateway installs are unaffected.

## [1.0.0]

_First publicly published chart version. New features in this release: externalDatabase and cloudSqlProxy (SWD-1.x). Gateway API networking, cert-manager Certificate, agent-provisioning RBAC, and metrics.provider were shipped in 0.9.0/0.9.1._

### Added

- `externalDatabase` block: bring-your-own-Postgres for the admin service. Set `postgresql.enabled=false` and `externalDatabase.existingSecret` to inject `DATABASE_URL_SHIPWRIGHT_ADMIN` from a user-managed Secret via `secretKeyRef`. The optional `externalDatabase.adminUrlKey` overrides the key name within that Secret (defaults to `DATABASE_URL_SHIPWRIGHT_ADMIN` when empty). When this path is active, the chart-managed admin Secret assembles no DB URL (no duplicate env injection). Bundled-PostgreSQL path is unchanged — this is purely additive.
- `cloudSqlProxy` sidecar: when `cloudSqlProxy.enabled=true`, a GCP Cloud SQL Auth Proxy container is injected alongside the admin container in the admin Deployment, making a Cloud SQL instance reachable at `127.0.0.1:5432`. Disabled by default (`enabled: false`). When enabled, the proxy runs with `--private-ip` and the required `cloudSqlProxy.connectionName` argument. Additional proxy arguments are configurable via `cloudSqlProxy.args`; resource limits via `cloudSqlProxy.resources`. The sidecar is purely additive — the existing admin Deployment is unchanged when the feature is off.

## [0.9.1]

### Added

- `metrics.provider` block: configurable PostHog provider (`posthog.existingSecret`, `posthog.personalApiKeyRef`, `posthog.projectIdRef`) for POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID injection via `secretKeyRef`, plus `adminUrl` (METRICS_ADMIN_URL), `basePath` (METRICS_BASE_PATH), `requireOwnerRole` (METRICS_REQUIRE_OWNER_ROLE), and `internalKey.existingSecret` / `internalKey.key` (METRICS_INTERNAL_API_KEY). All fields default to empty/false — existing `SHIPWRIGHT_SESSION_SECRET` and bundled-PG `METRICS_DATABASE_URL` paths are unchanged (additive, gated).

## [0.9.0]

### Added

- Gateway API networking. Setting `networking.type=gateway` renders a
  `gateway.networking.k8s.io/v1` `Gateway` (`templates/gateway.yaml`) and
  `HTTPRoute`(s) (`templates/httproute.yaml`) instead of an Ingress. The Gateway
  binds to a configurable `gatewayClassName` (`networking.gateway.gatewayClassName`,
  default `gke-l7-global-external-managed`) and `host`
  (`networking.gateway.host`, default `shipwright.local`), with a plain HTTP
  listener on `:80`. HTTPRoutes attach via `parentRefs` and route the admin
  UI/API at `/` to the admin Service and the metrics dashboard at `/dashboard`
  to the metrics Service (the `/dashboard` route is omitted when
  `metrics.enabled=false`). Mutually exclusive with `networking.type=ingress`:
  `gateway` renders Gateway+HTTPRoute and NO Ingress, `ingress` renders Ingress
  and NO Gateway/HTTPRoute. Requires the Gateway API CRDs (and a controller for
  the chosen class) in the cluster.
- Optional cert-manager Certificate. Setting `tls.certManager.enabled=true`
  renders a `cert-manager.io/v1` `Certificate` (`templates/certificate.yaml`)
  for `networking.gateway.host`, wired to an `issuerRef`
  (`tls.certManager.issuerRef.{name,kind}`, kind default `ClusterIssuer`). When
  enabled, the Gateway also adds an HTTPS (`:443`) listener referencing the
  issued Secret (`<fullname>-tls`). Disabled by default (Minikube = plain HTTP);
  disabled → no Certificate is rendered.
- `networking.gateway.{gatewayClassName,host,annotations}` and
  `tls.certManager.{enabled,issuerRef.{name,kind}}` values surface, with matching
  `values.schema.json` constraints (`gateway` added to the `networking.type`
  enum; the `certManager` block requires a non-empty `issuerRef.name` when
  enabled).
- Example values file `examples/values-gke-gateway.yaml` demonstrating the full
  `networking.type=gateway` + `tls.certManager.enabled=true` configuration for a
  real GKE cluster (NOT a ct-discovered `ci/` variant, since the kind e2e cluster
  has no Gateway API / cert-manager CRDs).
- Agent-provisioning RBAC + admin env contract, gated on
  `agent.provisioning.enabled` (default **false** → nothing is rendered and the
  admin service stays in **Noop** mode, requiring no cluster access). When
  enabled, the chart renders:
  - A **namespace-scoped** `Role` (`templates/agent-provisioning-rbac.yaml`) —
    NOT a `ClusterRole` — granting least-privilege verbs `create`, `get`,
    `delete` on `apps`/`Deployments` and core (`""`)/`Secrets`: exactly
    the verbs the provisioner (`KubernetesAgentProvisioner`) exercises.
  - A `RoleBinding` binding that Role to the admin `ServiceAccount`.
  - A separate **agent** `ServiceAccount`
    (`templates/agent-serviceaccount.yaml`,
    `agent.provisioning.serviceAccount.{create,name,annotations}`) that
    provisioned agent pods run as — distinct from the admin SA.
  - The provisioner **env contract** injected into the admin Deployment,
    matching `admin/src/main.ts` `buildProvisioner` exactly:
    `SHIPWRIGHT_K8S_PROVISIONING=enabled`, `SHIPWRIGHT_K8S_NAMESPACE` (via the
    **downward API**, `fieldRef: metadata.namespace`), `SHIPWRIGHT_AGENT_IMAGE`
    + `SHIPWRIGHT_AGENT_IMAGE_TAG` (tag defaults to `.Chart.AppVersion`),
    `SHIPWRIGHT_AGENT_REPLICAS`, `SHIPWRIGHT_API_URL` (built from the admin
    Service name + port, or `agent.provisioning.apiUrl`), and
    `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME`. `SHIPWRIGHT_ADMIN_DEPLOYMENT_UID` is
    injected ONLY when `agent.provisioning.adminDeploymentUid` is set — the
    downward API cannot expose the parent Deployment's UID to its pods, so a
    missing UID is acceptable (ownerRef propagation is a separate follow-up) and
    no wrong value is fabricated.
  - New values: `agent.provisioning.{enabled, image.{repository,tag}, replicas,
    serviceAccount.{create,name,annotations}, apiUrl, adminDeploymentUid,
    pvc.{size,storageClass}}` (provisioning OFF by default). The `pvc` settings
    are surfaced for the agent manifest builder's future use and are NOT injected
    as env (not read by `buildProvisioner`).

## [0.6.0]

### Added

- Ingress networking. Setting `networking.type=ingress` renders a
  `networking.k8s.io/v1` `Ingress` (`templates/ingress.yaml`) with a configurable
  `ingressClassName` (`networking.ingress.className`, default `nginx`), `host`
  (`networking.ingress.host`, default `shipwright.local`), and controller-specific
  `annotations` (`networking.ingress.annotations`, default `{}`). Rules route the
  admin UI/API at `/` to the admin Service and the metrics dashboard at `/dashboard`
  to the metrics Service (`pathType: Prefix`). The `/dashboard` path is omitted when
  `metrics.enabled=false`. No Ingress is rendered for any other `networking.type`
  (the default stays `ClusterIP`, so the Ingress is OFF by default).
- Helm test connection hook (`templates/tests/test-connection.yaml`). A
  `helm.sh/hook: test` Pod using the public, pinned `curlimages/curl` image curls
  the admin Service `/health` (must return 200) and, when `metrics.enabled`, the
  metrics Service `/dashboard` (accepts 200 or 302), exiting non-zero on failure so
  `helm test` fails loudly. This is the smoke check `ct install` runs in the e2e job.

## [0.5.0]

### Fixed

- Initdb DB name now tracks `metrics.database.name` overrides. The hardcoded
  `shipwright_metrics` string in `postgresql.primary.initdb.scripts` has been
  replaced with a parent-chart ConfigMap (`metrics-initdb-configmap.yaml`)
  rendered via the `shipwright.metrics.databaseName` helper. The Bitnami subchart
  reads the ConfigMap name from `postgresql.primary.initdb.scriptsConfigMap`
  (evaluated through `tpl` at install time using `.Release.Name`). Previously,
  overriding `metrics.database.name` would cause a fresh install to fail because
  the Deployment targeted a database that initdb never created.

## [0.4.0]

### Added

- Metrics service workloads: `metrics-deployment.yaml`, `metrics-service.yaml`,
  and `metrics-serviceaccount.yaml` (container port 3460, liveness/readiness
  probes on the DB-independent `/health`, ServiceAccount, standard
  labels/selectors). The dashboard is served at `/dashboard`.
- Chart-managed metrics `Secret` (`metrics-secret.yaml`) assembling
  `METRICS_DATABASE_URL` for postgres mode so the database password is never
  rendered into plaintext Deployment env. Only rendered when both `metrics.enabled`
  and `postgresql.enabled` are true.
- `METRICS_DATABASE_URL` wired to the bundled Bitnami PostgreSQL subchart in
  postgres mode (`METRICS_OFFLINE=false`, `METRICS_API_PORT=3460`). The metrics
  provider bootstraps its own `events` table on boot — no separate migration job.
- `metrics.service.type`, `metrics.serviceAccount.{create,name,annotations}`,
  `metrics.resources`, and `metrics.database.name` values surface, with matching
  `values.schema.json` constraints. `metrics.database.name` empty reuses the
  bundled PostgreSQL database (no collision with the admin Prisma tables); set it
  to isolate metrics data in a separate database.
- CI: the `helm-e2e` workflow now builds and side-loads the `shipwright-metrics`
  image into kind so `ct install` schedules the real metrics workload.

## [0.3.0]

### Added

- Admin service workloads: `admin-deployment.yaml`, `admin-service.yaml`, and
  `admin-serviceaccount.yaml` (container port 3001, liveness/readiness probes on
  `/health`, ServiceAccount, standard labels/selectors).
- Chart-managed admin `Secret` (`admin-secret.yaml`) holding
  `SHIPWRIGHT_SESSION_SECRET` and `SHIPWRIGHT_ENCRYPTION_KEY`, generated with the
  lookup-then-`randAlphaNum` idiom so they survive `helm upgrade`.
- `DATABASE_URL_SHIPWRIGHT_ADMIN` wired to the bundled Bitnami PostgreSQL
  subchart. The URL is assembled in the admin Secret so the database password is
  never rendered into plaintext Deployment env.
- Auth modes for the admin service: `open` (dev auth via `ADMIN_DEV_AUTH=true`,
  **insecure — no real authentication**) and `google` (Google OAuth with
  `NODE_ENV=production`, `GOOGLE_CLIENT_ID/SECRET`, and
  `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS`).
- `admin.service.type`, `admin.serviceAccount.{create,name,annotations}`,
  `admin.resources`, and the `auth.google.{clientId,clientSecret,allowedEmails}`
  values surface, with matching `values.schema.json` constraints.

### Changed

- `auth.mode` enum is now `open | google` (was `none | session | bearer`); the
  default is `open`. NOTES.txt warns loudly when `auth.mode=open`.
  **Migration:** existing installs with `auth.mode: none` should run
  `helm upgrade --set auth.mode=open` or add `auth.mode: open` to their values
  file. The value `none` is retained as a deprecated alias for `open` and will
  be removed in a future release.
- CI values variants (`ci/*-values.yaml`) updated to the new auth modes (gke
  exercises `google`, minikube/eks exercise `open`).

## [0.2.0]

### Added

- `CHANGELOG.md` (keep-a-changelog) documenting chart versions.
- `artifacthub.io/changes` annotation in `Chart.yaml` mirroring this changelog.
- `ct` version-increment CI gate (`ct lint --check-version-increment`) wired into
  the Helm workflow — any PR touching `charts/shipwright/**` that does not bump
  the chart `version` now fails CI.

### Changed

- Documented the chart versioning discipline in the chart `README.md`
  ("Versioning" section) and `CONTRIBUTING.md`.

## [0.1.0]

### Added

- Initial chart scaffold: values surface, helpers, NOTES, `values.schema.json`,
  and the pinned Bitnami PostgreSQL dependency (HD-2.1).
- Helm test harness: `task helm:*` targets, helm-unittest specs, and the
  kind-based `ct install` CI workflow (HD-2.2).
