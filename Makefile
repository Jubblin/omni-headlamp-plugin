.PHONY: validate screenshots

# Builds the plugin and stages the release payload in .plugins/, matching
# what .github/workflows/release.yml's later steps read directly
# (.plugins/package.json, .plugins/*) -- kept as an explicit copy here
# rather than headlamp-plugin's own `extract`/`package` subcommands, since
# both nest output under a package-name subfolder instead of the flat
# layout the release workflow expects.
validate:
	npm run tsc
	npm run build
	rm -rf .plugins
	mkdir -p .plugins
	cp dist/main.js .plugins/main.js
	cp package.json .plugins/package.json

# Builds deploy/Dockerfile (Headlamp + this plugin baked in) and a full
# disposable Omni instance (deploy/test/), then drives the result with a
# real browser end to end -- pre-authentication pages AND, once connected
# with the disposable instance's own bootstrapped service-account key,
# real authenticated screens backed by real Omni API data (see
# scripts/visual-smoke-test.mjs). Produces regression screenshots + video
# in screenshots/.
#
# Needs `docker`, `gpg`, `openssl`, and `npx playwright install chromium`
# once locally; CI's visual-smoke-test job (.github/workflows/ci.yml) has
# all four.
screenshots:
	scripts/setup-test-omni.sh
	docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml down -t 5 -v --remove-orphans >/dev/null 2>&1 || true
	docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml up -d --build
	@echo "Waiting for the bootstrapped service-account key..."
	@OMNI_CID="$$(docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml ps -q omni)"; \
	deadline=$$(( $$(date +%s) + 120 )); \
	KEY=""; \
	until KEY="$$(docker run --rm --volumes-from "$$OMNI_CID" alpine sh -c '[ -s /out/key ] && cat /out/key' 2>/dev/null)" && [ -n "$$KEY" ]; do \
		if [ "$$(date +%s)" -gt "$$deadline" ]; then \
			echo "Omni did not write the service-account key in time" >&2; \
			docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml logs omni | tail -50 >&2; \
			docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml down -t 5 -v --remove-orphans >/dev/null 2>&1; \
			exit 1; \
		fi; \
		sleep 2; \
	done; \
	echo "$$KEY" > /tmp/omni-manager-smoke-test-key
	@echo "Waiting for Headlamp to come up..."
	@for i in $$(seq 1 30); do \
		curl -sf -o /dev/null http://localhost:4466/ && break; \
		sleep 1; \
	done
	rm -rf screenshots
	OMNI_ENDPOINT=https://omni:8099 OMNI_SERVICE_ACCOUNT_KEY="$$(cat /tmp/omni-manager-smoke-test-key)" \
		node scripts/visual-smoke-test.mjs http://localhost:4466; \
	status=$$?; \
	if [ "$$status" -ne 0 ]; then \
		echo "--- headlamp container logs (diagnosing the failure above) ---" >&2; \
		docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml logs headlamp | tail -80 >&2; \
	fi; \
	docker compose -p omni-manager-smoke-test -f deploy/test/docker-compose.yml down -t 5 -v --remove-orphans >/dev/null 2>&1; \
	rm -f /tmp/omni-manager-smoke-test-key; \
	exit $$status
