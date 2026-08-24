# TODOS

## GitHub ConfigPatch Loading

### GitHub OAuth login as an upgrade path

**What:** Replace the pasted-PAT flow (`docs/designs/github-configpatch-loading.md`) with GitHub OAuth once this feature has more than one real user.

**Why:** A pasted fine-grained PAT is fine for a solo operator, but doesn't scale to a team — shared/rotating tokens, no per-user audit trail on the GitHub side. Removes the exact copy-paste-token friction that motivated this feature in the first place.

**Context:** Explicitly deferred twice: once during `/office-hours` (cross-model review recommended skipping GitHub App/OAuth for a confirmed single solo user), and again during `/plan-eng-review` when it came up as "use GitHub login" and was consciously scoped back out. Real infrastructure if built: a registered GitHub OAuth App, a callback route, and a Device Flow vs. Authorization Code decision — likely mirroring the shape of this plugin's existing Auth0 login for Omni (`src/omni/userAuth.ts`), but a second, separate OAuth integration. Worth revisiting once/if this feature gets a second real user or a team workflow (batch-apply-to-multiple-clusters, PR-review gating) gets built on top of it.

**Effort:** L
**Priority:** P4
**Depends on:** None blocking — only worth doing once demand exists beyond the current single user.

### Longer-lived storage for the GitHub PAT

**What:** Give the GitHub PAT a storage option that survives across browser sessions, instead of sessionStorage-only (re-paste every tab-open).

**Why:** A fine-grained, read-only, single-repo PAT is more annoying to mint than the Omni service-account key (GitHub's scope/repo/expiry pickers add steps), and this feature's whole justification is reducing repetitive manual work — flagged during `/plan-eng-review`'s outside-voice pass as a plausible net friction increase if re-minting/re-pasting a PAT every session offsets the time saved on not retyping patches.

**Context:** v1 deliberately accepts sessionStorage-only, matching the existing Omni service-account key precedent exactly (`src/omni/auth.ts`) — no new pattern, no new risk class introduced. A persisted option (localStorage, or a plugin-config-backed store) is a real tradeoff: bigger blast radius than a session-scoped credential, needs its own decision on where it lives and how it's protected. Revisit if session-scoped re-entry proves to be real friction in practice, not before.

**Effort:** M
**Priority:** P3
**Depends on:** The base GitHub ConfigPatch loading feature shipping first, so real usage data exists on whether this is actually painful.
