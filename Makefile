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

# Builds deploy/Dockerfile (Headlamp + this plugin baked in), runs it with
# no real credentials (every page scripts/visual-smoke-test.mjs visits is
# reachable before the "Connect to Omni" gate), and drives it with a real
# browser to produce regression screenshots + video in screenshots/.
# -kubeconfig=/dev/null still surfaces a (harmless, logged) parse error --
# see the identical note the very first time this repo's session explored
# that flag -- the Home page renders fine regardless.
#
# Needs `docker` and `npx playwright install chromium` once locally; CI's
# visual-smoke-test job (.github/workflows/ci.yml) has both.
screenshots:
	docker build -f deploy/Dockerfile -t omni-manager-headlamp:smoke-test .
	docker rm -f omni-manager-smoke-test >/dev/null 2>&1 || true
	docker run -d --name omni-manager-smoke-test -p 4466:4466 \
		omni-manager-headlamp:smoke-test \
		-in-cluster=false -kubeconfig=/dev/null -listen-addr=0.0.0.0 -port=4466
	@echo "Waiting for Headlamp to come up..."
	@for i in $$(seq 1 30); do \
		curl -sf -o /dev/null http://localhost:4466/ && break; \
		sleep 1; \
	done
	rm -rf screenshots
	node scripts/visual-smoke-test.mjs http://localhost:4466; \
	status=$$?; \
	docker rm -f omni-manager-smoke-test >/dev/null 2>&1; \
	exit $$status
