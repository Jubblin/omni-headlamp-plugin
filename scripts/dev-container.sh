#!/usr/bin/env bash
# Run an npm script inside the project's pinned-Node-22 dev container.
#
# Repeatable build environment for omni-manager: the host's Node version
# isn't reliable for this project's toolchain (see .devcontainer/Dockerfile),
# so build/lint/test/start all run inside a container with node_modules kept
# in a named Docker volume for speed across repeated invocations.
#
# Usage:
#   ./scripts/dev-container.sh build
#   ./scripts/dev-container.sh test
#   ./scripts/dev-container.sh lint
#   ./scripts/dev-container.sh sh          # drop into a shell in the container
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <npm-script> [args...]   (or: $0 sh)" >&2
  exit 1
fi

COMPOSE=(docker compose -f .devcontainer/docker-compose.yml)

if [ "$1" = "sh" ]; then
  exec "${COMPOSE[@]}" run --rm omni-manager-dev sh
fi

# install/ci are npm subcommands, not `npm run` scripts.
case "$1" in
  install | ci)
    exec "${COMPOSE[@]}" run --rm omni-manager-dev npm "$@"
    ;;
  *)
    exec "${COMPOSE[@]}" run --rm omni-manager-dev npm run "$@"
    ;;
esac
