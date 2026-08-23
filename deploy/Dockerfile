# Bundles omni-manager directly into the official Headlamp server image, so
# a single `docker build` produces a ready-to-run Headlamp+plugin image --
# no separate manual plugins-dir copy step. See DEPLOYMENT.md for the
# manual-install path this replaces (still the only option for the Electron
# desktop app, which can't use a server image at all).
#
# Build from the repo root: docker build -f deploy/Dockerfile -t omni-manager-headlamp .

# Stage 1: build the plugin bundle. Same pinned Node as .devcontainer/Dockerfile
# (see that file's comment for why -- host/CI Node 26+ breaks this project's
# toolchain via yargs ESM/CJS interop and rollup's native bindings).
# Tag: node:24-bookworm-slim
FROM node@sha256:bde0dae02f2b12d2bce5ee72b2432f0e511767b7b2dc4dd3b064df11ae422fee AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: the official Headlamp server image this plugin was last verified
# against end-to-end (real Omni-backed clusters, Auth0 login redirect,
# sidebar/routing) -- 2026-08-21 nightly. Re-verify before bumping.
# Pinned by digest only (not tag+digest), per the same reasoning as
# .devcontainer/Dockerfile -- the digest already fully pins the image; this
# comment carries the human-readable tag it corresponded to at pin time.
# Tag: ghcr.io/headlamp-k8s/headlamp:latest (as of 2026-08-21)
FROM ghcr.io/headlamp-k8s/headlamp@sha256:db3f0e0fc58d358d41daa3fe7fc852437552c7ee873c3645470f7b86a8e0db49

# `npm run build` only emits dist/main.js -- package.json (name/version,
# read by Headlamp's plugin loader) comes from the repo root itself, same
# as validate's Makefile target does for the release payload.
#
# /headlamp/plugins is already owned by the image's non-root `headlamp` user
# (its own Dockerfile's default USER), so this needs no extra chown/USER
# switch here.
COPY --from=build /workspace/dist/main.js /workspace/package.json /headlamp/plugins/omni-manager/
