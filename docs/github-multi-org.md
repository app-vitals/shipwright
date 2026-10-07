# Multi-org GitHub App

One GitHub App, installed on several GitHub orgs, lets a single agent work across all of them as one bot identity. This page covers how it works, operator setup, the org-admin install steps, the admin status card, and troubleshooting. Env var reference: [`configuration-agent.md`](./configuration-agent.md); file map: [`agent-key-files.md`](./agent-key-files.md).

With a single installation, behavior is identical to a one-org setup. Multi-org behavior only engages once the agent has two or more usable installations in scope.

## How it works

- **Discovery.** The agent signs an App JWT from `GH_APP_ID` + `GH_APP_PRIVATE_KEY` and lists the App's installations. It keeps those whose owner appears in the agent's repo scope (`org/repo` entries). `GH_APP_INSTALLATION_ID`, if set, is an optional pin: it is always used, and wins over a discovered installation for the same owner.
- **Default installation.** The pin if set, otherwise the lowest selected installation id. Its token is written to the `gh-token` file, so single-installation behavior is unchanged.
- **Per-owner tokens.** When two or more installations are usable, each owner's token is also written to `gh-token.d/<lowercase-owner>` next to `GH_TOKEN_FILE` (atomic write, mode 0600). With fewer than two, that directory is removed.
- **Routing.** The git credential helper reads the owner from the request path and uses that owner's token file. The `gh` wrapper resolves the target owner in this order: `-R`/`--repo`, a `repos/<owner>/...` API path, the `gh repo clone` argument, the working directory's `origin` remote, then the default installation. An owner with no token fails with a message naming the org; it never falls back to another org's token.
- **Re-sync.** Discovery re-runs on the agent's config-sync tick (every 60 seconds), so scope changes and new installs are picked up without a restart.
- **Broken installations.** An installation is marked broken when GitHub reports it suspended or rejects the token mint (403, 404 or 422). Transient errors (5xx, network) are logged and retried, not marked broken.
- **Repo name collisions.** Repos clone to `repos/<repo>` regardless of owner, so two scoped repos with the same name under different orgs collide. Admin rejects such a repo list with a 400; the clone sync skips the later repo.
- **No PAT regression.** App auth engages only when a pin exists or discovery finds at least one usable installation. Otherwise the agent stays on the PAT path.

## Operator setup

Everything is env-var only:

| Variable | Required | Notes |
|----------|----------|-------|
| `GH_APP_ID` | yes | The App's id. |
| `GH_APP_PRIVATE_KEY` | yes | PEM key; `\n`-escaped newlines are accepted. |
| `GH_APP_INSTALLATION_ID` | no | Pin one installation as always-used and default. Omit to rely on discovery. |
| `GH_APP_SLUG` | no | The App's URL slug. Set automatically by the admin manifest flow; needed for the "Add another org" link. Set it by hand when using an existing App. |

Then add each org's repos to the agent's repo scope.

### Creating the App from admin

The admin "Set up GitHub App (auto)" action has an **Installable on multiple orgs (public App)** checkbox, off by default. Check it for an App that will be installed on orgs other than its owner. The manifest flow stores `GH_APP_SLUG`, and the installed callback no longer overwrites an installation id that is already stored.

### Using an existing private App

A private App can only be installed on its owning account. To make it installable elsewhere, open the App's settings on GitHub and use **Make public** (Advanced). This was verified against a throwaway App: existing installation ids and token minting are unchanged by the flip, and other accounts can install the App afterwards.

## Org-admin install steps

1. From the agent's detail page in admin, use **Add another org** (shown once `GH_APP_SLUG` is set), or open `https://github.com/apps/<slug>/installations/new`.
2. Pick the target org, then choose all repositories or the specific ones the agent needs. The person installing must be an owner of the org, or request approval from one.
3. Wait up to 60 seconds. The next config-sync tick discovers the installation; no restart or env change is needed, provided the org's repos are in the agent's scope.

## Admin status card

The agent detail page shows a **GitHub Installations** card with one row per installation: owner, state, and last error. The agent reports its state to admin (`PUT /agents/:id/github-installations`, see [`agent-api-resources.md`](./agent-api-resources.md#github-installations-snapshot)) when it changes and on a 30-minute heartbeat. Reports never include tokens or keys. Admin only displays the snapshot; it never calls GitHub or the agent.

| State | Meaning |
|-------|---------|
| in scope / ok | Token minting works. |
| discovered, not in scope | The App is installed on the org but none of the agent's repos are. |
| pinned | The `GH_APP_INSTALLATION_ID` installation. |
| broken | Suspended, or the token mint was rejected. The last-error column says which. |

A stale warning appears when the last report is more than 90 minutes old (three missed heartbeats).

## Troubleshooting

- **A new org does not show up.** Allow 60 seconds. Confirm the org's repos are in the agent's scope and the App is installed on that org (not just authorized).
- **"discovered, not in scope".** Add at least one repo from that org to the agent's repo scope.
- **`gh wrapper: no GitHub App installation token for org '<org>'`.** The installation is missing, broken, or not yet picked up. Check the card, then the install on GitHub.
- **Broken: installation suspended.** Unsuspend it in the org's installed-Apps settings.
- **Broken: token mint rejected.** The installation was removed or its permissions were revoked. Reinstall it.
- **Admin rejects the repo list (400).** Two repos share a name across orgs. Scope only one of them.
- **Card is stale or missing.** The agent may be down or unable to reach admin. A missing card means no snapshot was ever reported.
- **Agent still uses a PAT.** App auth did not engage: no pin and no usable in-scope installation. Check `GH_APP_ID`, the key, and the card.
