# Design System

This project is a Headlamp plugin. Headlamp already has an established Material UI
theme — that is the design system here, not a new visual identity for this plugin.
These tokens are an approximation extracted from the `/design-html` reference build
(`configpatch-detail-20260811/finalized.html`); when Headlamp's actual theme tokens
are available at implementation time (via its plugin theme context), those are the
source of truth and should replace the approximations below.

## Principle

**No new typefaces, no new color palette, no custom-styled components.** Consume
Headlamp's MUI theme via its plugin API/theme context throughout. A plugin with its
own visual identity reads as bolted-on.

## Typography

- Body/UI: `Roboto` (400, 500, 700) — this is MUI's own default, and here that's
  correct: the goal is matching the host app, not "giving up on typography."
- Code/diff: `Roboto Mono` (400, 500)
- Base size: 14px, line-height 1.5

## Color tokens (light)

```css
--bg: #f5f6f8;
--paper: #ffffff;
--sidebar-bg: #ffffff;
--border: #e0e0e0;
--text-primary: #202124;
--text-secondary: #5f6368;
--primary: #1565c0;
--primary-hover: #0d47a1;
--error: #c62828;
--error-bg: #fdecea;
--warning: #a05a00;
--warning-bg: #fff4e5;
--success: #1b5e20;
--success-bg: #eaf6ea;
--code-bg: #1e1e1e;
--code-add-bg: rgba(46,160,67,0.30);
--code-del-bg: rgba(248,81,73,0.30);
```

## Color tokens (dark — `prefers-color-scheme: dark`)

```css
--bg: #121212;
--paper: #1e1e1e;
--sidebar-bg: #1a1a1a;
--border: #333940;
--text-primary: #e8eaed;
--text-secondary: #9aa0a6;
--primary: #82b1ff;
--error: #ff8a80;
--error-bg: #3a1f1f;
--warning: #ffcc80;
--warning-bg: #3a2f1a;
--success: #a5d6a7;
--success-bg: #1c2e1c;
--code-bg: #1a1a1a;
```

## Layout

- Sidebar nav: 240px fixed width, light background, 3px left border on active item.
- Info hierarchy (detail views): breadcrumb → resource header + status chip → toolbar → content. Status/connection state lives in tier 2 — always visible, never buried.
- Buttons: 36px height, 44px minimum touch target, 4px border radius.
- Diff editor: inline mode (not side-by-side), dark code background regardless of app theme.

## Accessibility baseline

- WCAG AA contrast (4.5:1) on all body text, including error/warning banners.
- 44px minimum touch targets.
- Visible focus rings (`:focus-visible`, 2px solid primary).
- `aria-live` on status/connection banners.
- Desktop-only — matches Headlamp itself, no dedicated mobile layout.

## Motion

Minimal by design (infra admin tool, not marketing). Respect `prefers-reduced-motion`.
