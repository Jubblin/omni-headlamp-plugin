# Pinned Node version for omni-manager builds.
#
# The host machine may run a newer Node (e.g. 26.x) that breaks
# @kinvolk/headlamp-plugin's CLI (yargs ESM/CJS interop) and rollup's
# platform-specific native bindings. Node 22 here is the version this
# project has actually been verified to build under.
FROM node:22-bookworm-slim

WORKDIR /workspace

# node_modules lives in a named volume (see docker-compose.yml), not baked
# into the image, so `npm install` always runs against whatever
# package.json/package-lock.json are on disk right now rather than a copy
# frozen at image-build time.
