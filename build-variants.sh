#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-datbird/opencode-plus}"
VARIANTS=("${@:-base dev full}")

for variant in ${VARIANTS[*]}; do
  docker build --target "${variant}" -t "${IMAGE_NAME}:${variant}" .
done

docker tag "${IMAGE_NAME}:dev" "${IMAGE_NAME}:latest"
