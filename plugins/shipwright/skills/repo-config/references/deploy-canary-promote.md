# Deploy → Canary → Promote Reference Contract

This reference covers the wiring between three CI stages: deploying to a staging environment, running the canary suite against it, and promoting to production. Each step has known failure modes that teams hand-roll incorrectly. This checklist makes them explicit.

## The three-stage pipeline

```
deploy-staging ──► canary ──► promote-to-production
     │                │               │
  build + push    TEST_TARGET_URL   gates on
  image to        = staging URL     canary success
  staging
```

## Checklist

### 1. Non-empty-tag guard

**Problem:** A deploy job that falls back to `latest` when the image tag is empty will silently deploy the wrong version, then canary passes against stale code.

**Rule:** The deploy job must fail if the image tag is empty or unresolved. Never fall back to `latest`.

```yaml
# ✅ Correct — fail fast on empty tag
- name: Validate image tag
  run: |
    if [ -z "$IMAGE_TAG" ]; then
      echo "IMAGE_TAG is empty — refusing to deploy" >&2
      exit 1
    fi

# ❌ Wrong — silent fallback hides broken builds
IMAGE_TAG: ${{ github.sha || 'latest' }}
```

The tag should be the full commit SHA or a content-addressed digest. Short SHAs are acceptable; mutable tags (`latest`, `main`, branch names) are not.

### 2. Skipped-job-counts-as-success hole

**Problem:** GitHub Actions treats a skipped job as `success` for `needs:` dependency checks. A promote job that only checks `canary` succeeded will also run if canary was skipped — e.g., because `deploy-staging` failed.

**Rule:** The promote job must explicitly verify that canary actually ran and passed, not just that it was not failed.

```yaml
# ✅ Correct — check result explicitly
promote:
  needs: [deploy-staging, canary]
  if: |
    needs.deploy-staging.result == 'success' &&
    needs.canary.result == 'success'

# ❌ Wrong — 'skipped' satisfies this condition
promote:
  needs: [canary]
  # implicit: if: success()  — passes on skipped
```

Both `deploy-staging` and `canary` must appear in `needs:` and both must be checked against `'success'` (not just `!= 'failure'`).

### 3. TEST_TARGET_URL must point at staging, not production

**Problem:** Canary run against production validates nothing about the just-deployed staging build. It also risks polluting production data.

**Rule:** `TEST_TARGET_URL` in the canary job must be set to the URL of the freshly-deployed staging environment. It must not be a static secret pointing at production.

```yaml
# ✅ Correct — URL comes from the deploy step's output
canary:
  needs: deploy-staging
  env:
    TEST_TARGET_URL: ${{ needs.deploy-staging.outputs.staging_url }}

# ❌ Wrong — static secret might point at prod
canary:
  env:
    TEST_TARGET_URL: ${{ secrets.STAGING_URL }}  # if this is wrong, you test prod
```

The staging URL should be an output of the deploy job, not a static environment variable. This ensures canary always targets the build that was just deployed.

## Full pipeline example (GitHub Actions)

```yaml
jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    outputs:
      staging_url: ${{ steps.deploy.outputs.url }}
    steps:
      - name: Validate image tag
        run: |
          if [ -z "${{ github.sha }}" ]; then
            echo "No commit SHA" >&2; exit 1
          fi
      - name: Deploy to staging
        id: deploy
        run: |
          # deploy ${{ github.sha }} to staging
          echo "url=https://staging.example.com" >> $GITHUB_OUTPUT

  canary:
    needs: deploy-staging
    runs-on: ubuntu-latest
    env:
      TEST_TARGET_URL: ${{ needs.deploy-staging.outputs.staging_url }}
    steps:
      - uses: actions/checkout@v4
      - name: Run canary suite
        run: bun run test:canary

  promote:
    needs: [deploy-staging, canary]
    if: |
      needs.deploy-staging.result == 'success' &&
      needs.canary.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Promote staging image to production
        run: |
          # re-tag and deploy ${{ github.sha }} to production
```

## Anti-patterns

- **Static `TEST_TARGET_URL` secret.** If the secret is misconfigured or points at prod, canary runs against the wrong target and you won't know.
- **`needs: [canary]` without explicit result check.** Skipped canary lets promotion proceed silently.
- **Mutable image tags.** `latest` and branch-name tags change meaning over time. Use SHA-pinned tags.
- **Canary job depending only on `push` event.** Canary should depend on a successful deploy, not directly on a push — there's no deployed env to test until deploy completes.
