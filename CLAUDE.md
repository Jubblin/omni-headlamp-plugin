## GBrain Configuration (configured by /setup-gbrain)
- Mode: local-stdio
- Engine: postgres (self-hosted, migrated from pglite 2026-08-13)
- Container: `gbrain-postgres` (pgvector/pgvector:pg16), docker volume `gbrain-postgres-data`, port 127.0.0.1:5433, restart policy unless-stopped
- Connection: postgresql://postgres:gbrain@localhost:5433/gbrain
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-08-13
- MCP registered: yes (user scope)
- Artifacts sync: full
- Current repo policy: read-write
- Note: old PGLite brain preserved at ~/.gbrain/brain.pglite (42MB, safe to delete once postgres engine is trusted) — migration was necessary because PGLite is single-process/single-writer and multiple concurrent Claude Code sessions each spawning their own `gbrain serve` fought over the same file lock.

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet. Two indexed corpora available via the `gbrain` CLI:
- This repo's code (registered as `gstack-code-<repo>` source).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. The brain auto-syncs incrementally on every gstack skill start.
Run `/sync-gbrain` to force-refresh, `/sync-gbrain --full` for full reindex.

<!-- gstack-gbrain-search-guidance:end -->
