# Design System — omni-manager (Headlamp plugin)

## Product Context
- **What this is:** A Headlamp plugin for viewing, editing, and applying Sidero Omni
  `ConfigPatch`/`MachineClass`/`Cluster` resources, replacing manual `omnictl` use.
- **Who it's for:** Platform engineers and SREs operating Kubernetes clusters via Omni.
- **Space/industry:** Kubernetes cluster administration tooling (peers: Headlamp itself,
  Lens, Kubernetes Dashboard, Rancher).
- **Project type:** Plugin embedded inside an existing host application (Headlamp),
  not a standalone product.

## The One Rule

**This plugin has no visual identity of its own.** The memorable-thing this design
system exists to serve: *"this feels native to Headlamp, not bolted on."* Every rule
below exists to keep this plugin invisible as a plugin — indistinguishable from
Headlamp's own built-in pages.

Confirmed against real evidence before writing this file:
- Live screenshot of the running plugin (`ConfigPatchDetail`, captured by
  `scripts/visual-smoke-test.mjs` in CI) shows it already rendering with zero visual
  distinction from Headlamp's own chrome — light gray nav/header, white content,
  standard MUI typography, amber active-nav highlight, all from Headlamp's theme.
- Codebase inspection (`grep` across `src/omni/*.tsx`) found **zero hardcoded hex
  colors** anywhere — every color reference is a semantic MUI token
  (`text.secondary`, `color="error"`, etc.).

This file exists to make that an explicit, enforced contract, not an accident that
erodes the next time someone adds a screen.

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian, fully inherited from the host.
- **Decoration level:** Minimal — typography and spacing carry the design, no
  decorative elements of any kind (no gradients, no illustration, no custom icons
  beyond MUI's icon set).
- **Mood:** Whatever Headlamp's active theme is. This plugin does not have its own mood.
- **Reference:** Headlamp's own UI (headlamp.dev / the running app) is the only
  reference that matters — not other Kubernetes tools, not general SaaS convention.

## Typography
- **Every font**: inherited from Headlamp's active theme (default: the Roboto stack,
  confirmed via live screenshot). This plugin declares no font of its own, anywhere.
- **Rule:** never add a `fontFamily` override, a `<link>` to Google/Bunny Fonts, or
  any font-loading code. If Headlamp's theme changes fonts, this plugin follows
  automatically — that's the point.

## Color
- **Approach:** 100% MUI semantic theme tokens. Zero hardcoded hex values anywhere
  in this codebase, no exceptions.
- **Rule:** use `palette.*`, `color="error"`/`"success"`/`"warning"`/`"info"` props on
  `Alert`/`Chip`/etc., and semantic tokens like `text.secondary` — never a literal
  `#rrggbb` or `rgb()` value in a `.tsx` file. A hardcoded color is a design system
  violation to flag in code review or `/design-review`, regardless of how good it
  looks in isolation.
- **Dark mode:** handled automatically by inheriting Headlamp's theme provider — no
  plugin-specific dark-mode logic needed or wanted.

## Spacing
- **Base unit:** MUI's default 8px unit (`theme.spacing()`), used via the `sx` prop's
  numeric shorthand (`sx={{ mb: 2 }}` = 16px) exactly as every existing screen already does.
- **Density:** Compact — matches Headlamp's own dense admin-tool density. Never widen
  spacing to feel more "spacious" or "premium"; that reads as foreign to the host.

## Layout
- **Approach:** Grid-disciplined, MUI `Stack`/`Box` composition — matches every
  existing screen (`ClusterCreate.tsx`, `ResourceDetail.tsx`, `ConfigPatchDetail.tsx`).
- **Component vocabulary (established, reuse before inventing):**
  - `Dialog`/`DialogTitle`/`DialogContent`/`DialogActions` — for a focused,
    self-contained sub-task that shouldn't restructure the page (e.g. delete
    confirmation in `ResourceDetail.tsx`).
  - Inline full-content replacement — only for a genuine page-level gate that blocks
    everything else on the page (e.g. `ConnectPrompt.tsx`'s credential gate). Do not
    use this pattern for an optional, non-blocking action.
  - `Alert` — for error states and status banners, using MUI's `severity` prop for
    color, never a custom-colored `Box`.
  - `Stack direction="row"` — for action-button rows (Apply/Delete/etc.).
  - `List`/`ListItemButton` — for any selectable list (not a hand-rolled `<div>` list),
    to get keyboard navigation and ARIA semantics for free.
- **Max content width:** match existing pages — `ClusterCreate.tsx` uses `maxWidth: 640`
  for its form; detail/list pages are otherwise unconstrained (matching Headlamp's own
  full-width content area).
- **Border radius:** MUI's theme default — never override.

## Motion
- **Approach:** Minimal-functional — only MUI's built-in component transitions
  (`Dialog` open/close, button hover/focus states, `Collapse` if ever needed).
  No custom animation, no entrance choreography, no scroll-driven effects.

## Accessibility & Responsive
- **Accessibility:** rides entirely on MUI's built-in semantics — no hand-written
  `aria-*` attributes exist anywhere in this codebase (confirmed by inspection), and
  that's correct: use MUI's semantic components (`Dialog`, `List`/`ListItemButton`,
  `TextField` with a real `label`) and get keyboard nav, focus management, and ARIA
  roles for free rather than hand-rolling them.
- **Responsive:** explicitly out of scope. This is a desktop-only Kubernetes admin
  tool (matching Headlamp itself and every peer in this category) — no responsive
  breakpoints exist anywhere in this codebase, and none should be added for one
  feature while the rest of the plugin has none.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-24 | DESIGN.md created as a strict inheritance contract, not a distinctive visual system | User's memorable-thing ("feels native to Headlamp, not bolted on") plus live-screenshot + codebase evidence both confirmed the plugin already has zero visual identity of its own — the correct system codifies that as a rule, not adds one |
