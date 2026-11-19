# Preview environment

## What it is and is not

A preview environment brings the whole Shipwright stack (admin, metrics, task-store, chat, mcp-server and a provisioned agent, with bundled PostgreSQL) up on a throwaway kind cluster inside a GitHub Actions runner, built from the pull request's own source. It needs no cloud account and no cluster of your own.

It is for pre-release testing only. No agent does real work in a preview, no real credential (model key, GitHub token, cloud key) is placed in it, and the admin runs with `auth.mode: open` inside the cluster, which is why the password gate in front of it matters.

It is not a staging environment, not a deploy target, and not a required check.

## The two jobs

| | Automatic test (`preview-test.yml`) | On-request preview (`preview.yml`) |
|---|---|---|
| Trigger | every `pull_request` (runs the cluster only when the diff touches the chart, a service directory, the preview files or the platform version pins) | the `preview` label on a same-repository PR, or manual dispatch with a PR number |
| Secrets | none; read-only token; fork PRs included | the `PREVIEW_PASSWORD` environment secret |
| Approval | none | a required-reviewer approval on the `preview` environment |
| Tunnel | none | Cloudflare quick tunnel, public URL |
| Runs | `helm test`, the deployed-target canary suite, the browser e2e specs | the same three, then verifies the password gate, posts a comment, and holds the stack up |
| Output | pass/fail, diagnostics artifact on failure | a PR comment with the URL |

Both jobs share one composite action (`.github/actions/preview-env`) and one bring-up script (`scripts/preview-env.ts`; locally `task preview:up`).

## One-time setup

All of this is done in the repository's settings in a browser. Until it is done the on-request job fails closed.

1. **Create the `preview` label.** Issues → Labels → New label, named exactly `preview`.
2. **Create the `preview` environment.** Settings → Environments → New environment, named exactly `preview`.
3. **Add required reviewers** to the environment. These are the people who release the password to a run by approving it. Required reviewers on a private repository need a GitHub plan that includes them. **Without reviewers there is no approval gate**: anyone who can label a PR could start a preview.
4. **Restrict deployment branches** to the default branch (Deployment branches and tags → Selected branches). This keeps a workflow edited on another branch from reading the secret.
5. **Add the `PREVIEW_PASSWORD` environment secret** to the `preview` environment (not a repository secret). It is the shared password reviewers hand out.

The job token cannot read environment protection rules, so the workflow cannot verify steps 3 and 4. It prints a warning on every run; keep them correct yourself.

## Requesting and ending a preview

**Request:** add the `preview` label to a pull request from a branch in the same repository. A maintainer approves the run on the Actions page. After the stack is up, one comment on the PR shows the URL, the username `preview`, the short commit SHA and the expiry. Maintainers hold the password. You can also run the Preview workflow manually from the default branch with a PR number and an optional window in minutes (default 120).

**End:** a preview ends by itself when any of these happens, and the comment is updated in place to say why. The tunnel is stopped before the comment changes.

- the window passes (default 120 minutes);
- the job reaches its time budget (345 minutes after start);
- the `preview` label is removed;
- the PR is closed;
- new commits are pushed (the head no longer matches the previewed commit);
- the tunnel stops;
- the PR cannot be checked three polls in a row.

To end one early, remove the label or close the PR. To preview new commits, remove and re-add the label.

## How the password is protected

- The workflow file runs from the default branch. Everything executed comes from a `trusted/` checkout of the default branch; the PR head is checked out to `pr/` only as an image build context and chart path, and is never executed.
- The password secret is passed to exactly one step, which hashes it (bcrypt htpasswd) before the PR is checked out. PR code never sees the plain text.
- The ingress enforces basic authentication in front of every route. The job then checks through the public URL that no credentials and wrong credentials get `401`, and that a random per-run self-check credential gets `200`, before it posts the comment.
- The ingress strips the forwarded `Authorization` header, because the admin rejects a forwarded `Basic` header. This uses a configuration snippet, so the bring-up enables snippet annotations on the throwaway ingress controller.
- A first job with no environment validates the request, so a fork PR or a wrong label fails there and never raises an approval request.
- The job token is used only to comment and to watch the PR, with `contents: read` and `pull-requests: write`.
- A content test (`preview-workflow.content.test.ts`) enforces these properties.

## Limits

- **The public URL is for a browser only.** The admin API under `auth.mode: open` needs a session cookie obtained by browser sign-in, and the gate answers `401` to requests without basic credentials, so API calls cannot be made through it.
- Same-repository PRs only; fork PRs are refused.
- One preview per PR at a time; a second request queues and never cancels the first.
- A job cannot exceed six hours; the hold stops at 345 minutes.
- Runs on a standard GitHub-hosted Linux runner. Measured time to Ready was about 5 to 7.5 minutes including image builds, with peak memory around 2.5 GB and no OOM kill or Pending pod.
- The agent check asserts only that the in-cluster agent's Deployment exists and is scheduled. An agent pod takes about 2.5 minutes to reach Running without a model credential, which is over the canary suite's 60 second budget, so the suite never asserts a Ready pod.
- Quick tunnel hostnames are random and change on every run.

## Troubleshooting

**"PREVIEW_PASSWORD is not configured for the 'preview' environment"** — the secret is missing or empty, or it was added as a repository secret instead of an environment secret. Add it to the `preview` environment (setup step 5).

**"The tunnel did not produce a hostname within 60 seconds"** — the `cloudflared` quick tunnel did not start. The step prints the tail of its log. Re-run the job; quick tunnels are a free service without a guarantee.

**The stack did not become Ready** — the bring-up waits for every workload and fails when one does not. Look at the job log for the pod that stayed unready; the automatic test job uploads pod status, events and logs (never Secret objects) as an artifact on failure. Reproduce locally with a kind cluster: `task preview:up -- --context <ctx> --chart charts/shipwright --env-out state/preview.env`, then `task preview:canary ENV_FILE=state/preview.env`.

**The run never starts after labelling** — check that the label is exactly `preview`, the PR head is in this repository, and a reviewer has approved the run. `pull_request_target` and manual dispatch only run from the default branch.

**The URL returns `401`** — expected without the password. Sign in as user `preview` with the shared password.
