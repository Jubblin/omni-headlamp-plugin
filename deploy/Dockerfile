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
FROM node@sha256:f5d1cc40abc10c2843339a2134d07817cf33c405cb16bfd052b0ed790254c3a3 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
# --ignore-scripts: same rationale as .github/workflows/ci.yml's identical
# flag -- verified safe for this dependency tree (tsc/test/build all pass
# against a clean --ignore-scripts install); otherwise every transitive
# dependency's install-time script runs unsandboxed during the image build.
RUN npm ci --ignore-scripts
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
# The base image already sets this as its default user -- repeated
# explicitly so this Dockerfile is correct read on its own (static analysis
# of just this file can't see the base image's own USER instruction) and
# doesn't silently start running as root if a future base-image bump ever
# changes that default.
USER headlamp

COPY --from=build /workspace/dist/main.js /workspace/package.json /headlamp/plugins/omni-manager/
