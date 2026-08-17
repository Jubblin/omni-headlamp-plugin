.PHONY: validate

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
