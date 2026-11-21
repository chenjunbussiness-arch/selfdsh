/**
 * Panel stylesheet.
 *
 * Delivered as text and installed with a runtime `<style>` tag rather than
 * imported as CSS: the Web bundle is compiled outside Vite's graph, so a
 * `*.module.css` import has no loader. Every class carries the `dst-` prefix.
 *
 * Colours come only from the shell's `--dsw-alias-*` / `--dsw-specific-*`
 * tokens (with the light-theme values as fallbacks), so `body[data-ds-dark-theme]`
 * flips the whole panel without a single `#fff`/`#000` decision in JavaScript.
 */

/** Attribute this plugin's style tag carries, also used to stay idempotent. */
const STYLE_KEY = 'dsh-client-ui-token-stats/TokenStats.css'

/** Stylesheet text. */
export const TOKEN_STATS_CSS = `
:where(div):has(> [data-slot] > .dst-root) { flex-wrap: wrap; row-gap: 6px; }
.dst-root {
  --dst-text: var(--dsw-alias-label-primary, #0f1115);
  --dst-text2: var(--dsw-alias-label-secondary, #61666b);
  --dst-caption: var(--dsw-alias-label-caption, #81858c);
  --dst-line: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  --dst-line2: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  --dst-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --dst-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dst-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dst-pop: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  --dst-soft: color-mix(in srgb, var(--dst-caption) 14%, transparent);
  position: relative; display: block; flex: 1 0 100%; width: 100%; min-width: 0; box-sizing: border-box;
  color: var(--dst-text); font-family: inherit; text-align: left;
}
.dst-root *, .dst-root *::before, .dst-root *::after { box-sizing: border-box; }

/* ---------- card ---------- */
.dst-card {
  display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
  padding: 8px 10px 9px; border: 1px solid var(--dst-line); border-radius: 12px;
  background: transparent; color: var(--dst-text); font: inherit; font-size: 12px; line-height: 1.35;
  text-align: left; cursor: pointer; transition: background 0.15s ease;
}
.dst-card:hover { background: var(--dst-hover); }
.dst-card:focus-visible { outline: 2px solid var(--dst-accent); outline-offset: 1px; }
.dst-card[aria-expanded="true"] { border-color: color-mix(in srgb, var(--dst-accent) 38%, var(--dst-line)); }
.dst-head { display: flex; align-items: center; gap: 6px; width: 100%; }
.dst-title { font-size: 11px; font-weight: 500; letter-spacing: 0.02em; color: var(--dst-caption); white-space: nowrap; margin-right: auto; }
.dst-caret { font-size: 9px; color: var(--dst-caption); }
.dst-big-row { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }
.dst-big { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.05; font-variant-numeric: tabular-nums; }
.dst-big-label { font-size: 10px; color: var(--dst-caption); padding-bottom: 2px; white-space: nowrap; }
.dst-spark { margin-left: auto; display: flex; align-items: flex-end; gap: 2px; height: 22px; flex: none; }
.dst-spark i { display: block; width: 5px; min-height: 2px; border-radius: 1.5px; background: color-mix(in srgb, var(--dst-accent) 35%, transparent); }
.dst-spark i[data-today="true"] { background: var(--dst-accent); }
.dst-split { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 10.5px; color: var(--dst-caption); }
.dst-split b { font-weight: 600; color: var(--dst-text2); font-variant-numeric: tabular-nums; }
.dst-stack { display: flex; width: 100%; height: 5px; border-radius: 3px; overflow: hidden; background: var(--dst-soft); gap: 1px; }
.dst-stack i { display: block; height: 100%; min-width: 2px; }
.dst-model { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 30px; align-items: center; gap: 6px; min-width: 0; }
.dst-swatch { display: block; width: 8px; height: 8px; border-radius: 2px; flex: none; }
.dst-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dst-text2); min-width: 0; }
.dst-model-tok { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dst-text); white-space: nowrap; }
.dst-model-share { font-size: 10px; font-variant-numeric: tabular-nums; color: var(--dst-caption); text-align: right; white-space: nowrap; }
.dst-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--dst-caption); }
.dst-note[data-bad] { color: var(--dst-bad); }

/* ---------- collapsed 56px rail ---------- */
.dst-rail {
  display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; margin: 0 auto; padding: 0;
  border: 1px solid var(--dst-line); border-radius: 12px; background: transparent; color: var(--dst-text2); font: inherit; cursor: pointer;
}
.dst-rail:hover { background: var(--dst-hover); }
.dst-rail[aria-expanded="true"] { color: var(--dst-accent); background: color-mix(in srgb, var(--dst-accent) 12%, transparent); }
.dst-rail:focus-visible { outline: 2px solid var(--dst-accent); outline-offset: 1px; }
.dst-rail-bars { display: flex; align-items: flex-end; gap: 2px; height: 16px; }
.dst-rail-bars i { display: block; width: 3px; border-radius: 1px; background: currentColor; opacity: 0.9; }

/* ---------- popover ---------- */
.dst-pop {
  position: fixed; z-index: 1200; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dst-line2); border-radius: 14px; background: var(--dst-pop); color: var(--dst-text);
  box-shadow: 0 18px 48px rgba(15, 17, 21, 0.2), 0 2px 8px rgba(15, 17, 21, 0.08);
  font-size: 12px; line-height: 1.45; overflow: hidden;
}
.dst-pop-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dst-line); flex: none; }
.dst-pop-title { font-size: 12px; font-weight: 600; }
.dst-pop-sub { margin-right: auto; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--dst-caption); }
.dst-close {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dst-caption); font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.dst-close:hover { background: var(--dst-hover); color: var(--dst-text); }
.dst-pop-body { display: flex; flex-direction: column; gap: 12px; min-height: 0; padding: 10px 12px 12px; overflow-y: auto; }
.dst-tabs { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--dst-soft); }
.dst-tab { flex: 1; padding: 4px 6px; border: 0; border-radius: 7px; background: transparent; color: var(--dst-text2); font: inherit; font-size: 11px; cursor: pointer; }
.dst-tab[data-on="true"] { background: var(--dst-pop); color: var(--dst-text); font-weight: 600; box-shadow: 0 1px 2px rgba(15, 17, 21, 0.12); }
.dst-hero { display: flex; flex-direction: column; gap: 1px; }
.dst-hero-value { font-size: 24px; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.dst-hero-unit { margin-left: 4px; font-size: 11px; font-weight: 500; color: var(--dst-caption); }
.dst-hero-note { font-size: 10.5px; color: var(--dst-caption); }
.dst-cells { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.dst-cell { display: flex; flex-direction: column; gap: 1px; padding: 6px 7px; border-radius: 8px; background: var(--dst-soft); min-width: 0; }
.dst-cell span { font-size: 10px; color: var(--dst-caption); white-space: nowrap; }
.dst-cell b { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dst-section { display: flex; flex-direction: column; gap: 7px; }
.dst-section-title { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; color: var(--dst-caption); }
.dst-model-row { display: flex; flex-direction: column; gap: 3px; }
.dst-model-row-head { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 34px; align-items: center; gap: 6px; }
.dst-model-row .dst-model-name { color: var(--dst-text); font-size: 11.5px; }
.dst-track { display: block; height: 4px; border-radius: 2px; background: var(--dst-soft); overflow: hidden; }
.dst-fill { display: block; height: 100%; min-width: 2px; border-radius: 2px; }
.dst-days { display: flex; flex-direction: column; gap: 4px; }
.dst-day { display: grid; grid-template-columns: 38px minmax(0, 1fr) 44px; align-items: center; gap: 8px; }
.dst-day-date { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dst-text2); }
.dst-day[data-today="true"] .dst-day-date { color: var(--dst-accent); font-weight: 600; }
.dst-day-track { display: block; height: 8px; border-radius: 3px; background: var(--dst-soft); overflow: hidden; }
.dst-day-bar { display: flex; height: 100%; border-radius: 3px; overflow: hidden; gap: 1px; }
.dst-day-bar i { display: block; height: 100%; min-width: 1px; }
.dst-day-tok { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dst-text2); text-align: right; }
.dst-day[data-zero="true"] .dst-day-tok { color: var(--dst-caption); }
.dst-empty { display: flex; flex-direction: column; gap: 4px; padding: 14px 4px; text-align: center; }
.dst-empty-title { font-size: 12px; font-weight: 600; }
.dst-empty-hint { font-size: 11px; line-height: 1.4; color: var(--dst-caption); }
.dst-error { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dst-bad) 35%, transparent); border-radius: 10px; }
.dst-error-title { font-size: 11px; font-weight: 600; color: var(--dst-bad); }
.dst-error-hint { font-size: 10px; line-height: 1.4; color: var(--dst-caption); }
.dst-retry, .dst-refresh {
  align-self: flex-start; margin-top: 2px; padding: 3px 8px; border: 1px solid var(--dst-line2); border-radius: 7px;
  background: transparent; color: var(--dst-text2); font: inherit; font-size: 10px; cursor: pointer;
}
.dst-retry:hover, .dst-refresh:hover { background: var(--dst-hover); }
.dst-pop-foot { display: flex; flex-direction: column; gap: 1px; flex: none; padding: 7px 12px 8px; border-top: 1px solid var(--dst-line); }
.dst-foot-line { font-size: 10px; line-height: 1.35; color: var(--dst-caption); overflow-wrap: anywhere; }
.dst-foot-line[data-bad] { color: var(--dst-bad); }
.dst-refresh:disabled { opacity: .55; cursor: default; }
@media (prefers-reduced-motion: reduce) { .dst-card, .dst-rail { transition: none; } }
`

/** Install the stylesheet once per document. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.head.querySelector(`style[data-dsh-style="${STYLE_KEY}"]`)
  if (existing !== null) { existing.textContent = TOKEN_STATS_CSS; return }
  const style = document.createElement('style')
  style.setAttribute('data-dsh-style', STYLE_KEY)
  style.textContent = TOKEN_STATS_CSS
  document.head.appendChild(style)
}
