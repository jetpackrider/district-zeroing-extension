# `@zd/panel-ui` UI Guide

The Zero Deviation side panel renders between **300 px and 700 px** wide (typically ~400 px) in light and dark themes using plain React 19 and CSS (`src/styles/panel.css`). Every class is prefixed with `zd-`.

## Design Tokens

All tokens live on `.zd-panel` (light) and are repeated verbatim in two dark blocks: `@media (prefers-color-scheme: dark) .zd-panel:not([data-theme='light'])` and `.zd-panel[data-theme='dark']`. Keep all three blocks in sync.

| Category | Tokens | Values |
| --- | --- | --- |
| Type scale | `--zd-text-xs`, `-sm`, `-md`, `-lg`, `-xl` | `11px`, `12px`, `13px`, `15px`, `17px` |
| Line heights | `--zd-leading-xs` … `-xl` | `1.36`, `1.4`, `1.46`, `1.33`, `1.3` |
| Weights | `--zd-weight-regular`, `-medium`, `-bold` | `400`, `550`, `650` |
| Spacing | `--zd-space-half`, `-1`, `-2`, `-3`, `-4`, `-5` | `2px` (pills/badges only), `4px`, `8px`, `12px`, `16px`, `24px` |
| Radii | `--zd-radius-sm`, `--zd-radius`, `-lg`, `-pill` | `4px`, `6px`, `10px`, `999px` (`50%` only for true circles) |
| Control heights | `--zd-control-sm`, `--zd-control` | `26px`, `32px` |
| Surfaces & borders | `--zd-bg`, `--zd-surface`, `-subtle`, `-hover`, `--zd-border`, `-strong` | Canvas, cards, inset fills, hover fills, dividers |
| Text | `--zd-text`, `--zd-text-secondary`, `--zd-text-muted` | Primary, body/labels, captions/metadata |
| Brand & status | `--zd-accent`, `--zd-over`, `--zd-under`, `--zd-zero`, `--zd-warn`, `--zd-error`, `--zd-info`, `--zd-twoway` | Each status has `-bg` and `-border`; `--zd-accent` and `--zd-twoway` also define `-text` |
| Misc | `--zd-unassigned`, `--zd-swatch-ring`, `--zd-shadow-sm`, `--zd-shadow-focus`, `--zd-font-sans`, `--zd-font-mono` | Neutral unassigned swatch, rings, focus shadow, fonts |

Rhythm: `--zd-space-3` (`12px`) between cards (`.zd-body`, `.zd-conn`, `.zd-about`); `--zd-space-2` (`8px`) from section titles to content (`.zd-section-head`).

## Shared Component Classes

- **`.zd-card`** — Primary surface container (`padding: var(--zd-space-3)`, `border-radius: var(--zd-radius-lg)`). Use for every major panel section and solution card.
- **`.zd-section-title`** + **`.zd-section-head`** — Uppercase `xs` section label and its flex header row (`margin-bottom: var(--zd-space-2)`).
- **`.zd-btn`** — Default secondary button (`32px` tall). Combine with:
  - `--primary` (one main CTA per view), `--secondary` (explicit default), `--ghost` (low-emphasis toolbar/clear actions), `--warn` / `--danger` (cautious/destructive actions).
  - `--sm` (`26px` tall for inline/card actions), `--full` (`width: 100%`).
- **`.zd-segmented`** + **`.zd-btn zd-btn--sm zd-segmented__btn`** — Every 2–3 way switch (Scope, Prefer/Only, Aim for `−1 / Zero / +1`). Active state uses `aria-pressed="true"`.
- **`.zd-note`** — The single inline message/callout box. Combine with `--info`, `--warn`, `--error`, `--success`, or `--twoway`, and use `.zd-note__title` + `.zd-note__text` inside.
- **`.zd-pill`** — Compact status/metric badge. Variants: `--neutral`, `--over`, `--under`, `--zero`, `--accent`, `--twoway`, `--warn`, `--error`, and `--inline` (borderless inline colored deviation text).
- **`.zd-list`** + **`.zd-list__row`** (+ **`--selected`**) — Bordered container with divided rows. Use for the district table, neighbor chooser rows, walkthrough block ticks, and border step outlines.
- **`.zd-stat`** (+ **`--win`**) — Subtle metric tile inside `.zd-stats-grid`, with `.zd-stat__label`, `.zd-stat__val`, and `.zd-stat__sub`.
- **Utilities** — `.zd-num` (tabular figures on all numbers/deltas), `.zd-mono` (GEOIDs, precinct IDs, filenames), `.zd-swatch` / `.zd-swatch--lg` (district color chips), `.zd-stack` (vertical `--zd-space-2` stack).

## 5 Rules for Adding UI

1. **Tokens only.** Use only the type, spacing, radius, weight, and color tokens above—no raw `px` values for typography/spacing/radii and no raw hex colors outside the three token blocks.
2. **Reuse shared classes.** Build every new card, button, segmented switch, inline note, pill, stat tile, or row list from the shared classes above instead of introducing one-off styled boxes.
3. **No static inline `style={{...}}`.** Reserve `style` props strictly for runtime-dynamic values (district swatch `backgroundColor`, progress bar `width`, SVG geometry). Put all static layout and spacing in `panel.css`.
4. **Verify dark mode and contrast.** Update both dark token blocks together and ensure every text/background pair meets WCAG AA (**≥ 4.5:1**) in both light and dark themes.
5. **Verify 300 px, 700 px, and keyboard focus.** Test narrow (300 px) and pop-out (700 px) widths with `npm run dev` or `node scripts/screens.mjs` so nothing clips, overflows, or stretches awkwardly, and never suppress `.zd-panel :focus-visible`.
