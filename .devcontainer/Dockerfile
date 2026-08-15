# Pinned Node version for omni-manager builds.
#
# The host machine may run a newer Node (e.g. 26.x) that breaks
# @kinvolk/headlamp-plugin's CLI (yargs ESM/CJS interop) and rollup's
# platform-specific native bindings. Node 22 here is the version this
# project has actually been verified to build under.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

WORKDIR /workspace

# node_modules lives in a named volume (see docker-compose.yml), not baked
# into the image, so `npm install` always runs against whatever
# package.json/package-lock.json are on disk right now rather than a copy
# frozen at image-build time.
