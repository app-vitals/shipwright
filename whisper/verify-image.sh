#!/usr/bin/env bash
set -euo pipefail
image=${1:?usage: verify-image.sh IMAGE}
# Verify the installed package database, rather than a tag or SBOM assertion.
docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$image" -ec '
  . /etc/os-release
  test "$VERSION_CODENAME" = bookworm
  for package in libbrotli1 libbrotli-dev; do
    version=$(dpkg-query -W -f="\${Version}" "$package")
    dpkg --compare-versions "$version" ge 1.0.9-2+deb12u1
    printf "%s=%s\n" "$package" "$version"
  done
'
# The derivative must retain the parent application launch contract.
parent=onerahmet/openai-whisper-asr-webservice:v1.10.0@sha256:0616c3d5fc6924e9d59aa8a7a3a944fbe8f3a5d701e5fc1fa2ce5b933dfecb73
docker pull --platform linux/amd64 "$parent" >/dev/null
contract='{{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .Config.ExposedPorts}} {{json .Config.User}} {{json .Config.WorkingDir}}'
test "$(docker image inspect --platform linux/amd64 --format "$contract" "$image")" = "$(docker image inspect --platform linux/amd64 --format "$contract" "$parent")"
