# Whisper security rebuild

This derivative retains the v1.10.0 application, entrypoint, API and model behavior,
while updating Debian 12 Brotli packages for CVE-2026-111497. The build fails if
its parent is not bookworm or either installed package is older than
`1.0.9-2+deb12u1` (the Debian security fix).

Build and check locally:

```sh
docker build --platform linux/amd64 -f whisper/Dockerfile -t shipwright-whisper:security .
docker run --rm --entrypoint dpkg-query shipwright-whisper:security -W libbrotli1 libbrotli-dev
```

`build-whisper.yml` builds on pull requests and publishes only after a successful
CI run for the same upstream-main commit. It uses a commit-specific tag
`ghcr.io/app-vitals/shipwright-whisper:sha-<commit>`. No chart default or running
installation changes until an operator selects the published image by digest.
If automatic publication was missed (for example an earlier Whisper commit's CI
failed and a later unrelated commit passed), dispatch the recovery from main with
the successful CI run id:

```sh
gh workflow run build-whisper.yml --repo app-vitals/shipwright --ref main -f ci_run_id=123456
```

The recovery validates the workflow id, upstream repository, main branch, push
event, completed/success state and exact SHA through the Actions API. It does not
accept a fork run, PR run or failed CI as publication authority.

Verify `/docs` and `/asr` with the same model settings before rollout and obtain a
fresh image scan afterward. Package-version checks are not full image clearance.

Admin, metrics and task-store use Bun. Their Dockerfiles pin Bun 1.4.4's image
index digest and refresh inherited Debian packages during each rebuild.
`process.version` in Bun is a Node-compatibility value, not the installed Node
binary version; record `Bun.version` and `process.execPath` during validation.
The platform-owned chat/runtime images are released from app-vitals/agent.

References:
- https://security-tracker.debian.org/tracker/CVE-2026-111497
- https://bun.com/blog/bun-v1.4.4
