# Pinned Node version for omni-manager builds.
#
# The host machine may run a newer Node (e.g. 26.x) that breaks
# @kinvolk/headlamp-plugin's CLI (yargs ESM/CJS interop) and rollup's
# platform-specific native bindings. Node 22 here is the version this
# project has actually been verified to build under.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

WORKDIR /workspace

# node_modules lives in a named volume (see docker-compose.yml), not baked
# into the image, so `npm install` always runs against whatever
# package.json/package-lock.json are on disk right now rather than a copy
# frozen at image-build time.
