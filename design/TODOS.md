# TODOs

## GitOps-style drift detection for Omni resources (v2+)

**What:** Diff live Omni state (config patches, machine classes) against a git-committed desired state; surface drift badges in the Headlamp sidebar like the existing Flux plugin's "OutOfSync"; route changes through git + PR review instead of direct apply.

**Why:** Turns risky direct-apply operations into reviewable PRs. This also substantially reduces the audit-trail and blast-radius risks accepted in the v1 shared-token model (`richardw-unknown-design-20260811-132218.md`) — if changes flow through git+PR review, the "who applied what" question is answered by git history instead of requiring per-user Omni auth.

**Context:** Surfaced as Approach C during `/office-hours` (2026-08-11) and reinforced by the `/plan-eng-review` outside-voice pass. Genuinely novel — no existing tool combines Omni fleet management with a Kubernetes UI this way, let alone with GitOps semantics. Requires a git-source-of-truth workflow for Omni resources that doesn't exist yet — that's a prerequisite project, not a feature toggle on top of v1.

**Depends on:** v1 (patch + machine class CRUD, `richardw-unknown-design-20260811-132218.md`) shipping and proving useful with the internal team first.

---

## Publish the Omni plugin to the broader Omni/Talos community

**What:** Package and publish the plugin (Headlamp plugin registry / npm, or documented manual-install instructions) beyond internal team use.

**Why:** The original `/office-hours` session's "who would you show this to" answer was team first, then the broader Omni/Talos community. This is the deferred second half of that goal.

**Context:** Requires resolving RBAC/audit for real — the v1 shared-token model's "no per-user audit trail" is only an accepted risk for internal team use (see design doc RBAC/audit open question), not something responsible to hand to strangers managing their own Omni fleets without at least documenting the risk prominently, or resolving it via the per-user OIDC spike (Next Steps #3).

**Depends on:** Next Steps #10 (internal team shipping) completing first, and the outcome of the RBAC/audit and per-user-OIDC spikes.
