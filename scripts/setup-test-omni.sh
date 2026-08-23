#!/usr/bin/env bash
#
# Generates the throwaway GPG key (etcd storage encryption) and self-signed TLS cert the
# disposable test-Omni instance (deploy/test/docker-compose.yml) needs to boot. Fresh every run,
# never checked in -- output goes to deploy/test/.generated/ (gitignored). Neither secret has any
# value outside the lifetime of that one container: the GPG key only encrypts an embedded etcd
# store that's destroyed with the container, and the TLS cert is trusted by exactly one throwaway
# Headlamp container for one test run (see scripts/visual-smoke-test.mjs's caller for how).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/deploy/test/.generated"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/certs"

# --- GPG key for etcd's privateKeySource ---
GNUPGHOME="${OUT_DIR}/gnupg"
mkdir -m 700 "${GNUPGHOME}"
export GNUPGHOME
echo "pinentry-mode loopback" > "${GNUPGHOME}/gpg.conf"
echo "allow-loopback-pinentry" > "${GNUPGHOME}/gpg-agent.conf"
gpg --batch --pinentry-mode loopback --passphrase '' \
  --quick-generate-key "omni-smoke-test <ci@test.local>" rsa4096 cert never
FPR="$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/{print $10; exit}')"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-add-key "${FPR}" rsa4096 encr never
gpg --batch --pinentry-mode loopback --passphrase '' \
  --export-secret-key --armor "${FPR}" > "${OUT_DIR}/certs/etcd-key.asc"

# --- Self-signed TLS cert for Omni's own API endpoint ---
# SAN must cover "omni" -- the docker-compose service name this plugin's -proxy-urls and Omni
# endpoint setting both target.
openssl req -x509 -newkey rsa:2048 -keyout "${OUT_DIR}/certs/omni-key.pem" \
  -out "${OUT_DIR}/certs/omni.pem" -days 1 -nodes \
  -subj "/CN=omni" -addext "subjectAltName=DNS:omni,DNS:localhost,IP:127.0.0.1"

echo "Generated throwaway Omni test credentials in ${OUT_DIR}"
