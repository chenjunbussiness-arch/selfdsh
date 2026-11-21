/**
 * Panel stylesheet.
 *
 * Follows the DeepSeek-style pass of `dsh-client-ui-router`: one accent (#4d6bfe),
 * rounded surfaces, separation by tone and spacing instead of thick borders,
 * and colour only from the host's `--dsw-alias-*` tokens so light and dark follow
 * the app. Every class carries the `dshe-` prefix so nothing can collide with host
 * class names. Fallbacks are the host's light-theme values, so the panel still
 * renders in a page that injects no tokens (the standalone preview).
 *
 * Delivered as text and installed by `installStyles()` rather than imported as
 * CSS: the Web bundle is compiled outside Vite's graph, and a runtime `<style>`
 * tag keeps the browser and preview builds identical.
 */

/** Attribute this plugin's style tag carries, also used to stay idempotent. */
const STYLE_KEY = 'dsh-client-ui-egress/EgressPanel.css'

/** Panel stylesheet text. */
export const EGRESS_CSS = `
.dshe-panel {
  --dshe-accent: #4d6bfe;
  --dshe-accent-soft: color-mix(in srgb, var(--dshe-accent) 10%, transparent);
  --dshe-text: var(--dsw-alias-label-primary, #0f1115);
  --dshe-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshe-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshe-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshe-bg: var(--dsw-alias-bg-base, #fff);
  --dshe-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshe-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshe-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshe-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshe-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshe-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshe-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--dshe-bg);
  color: var(--dshe-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  container-type: inline-size;
}
.dshe-panel *, .dshe-panel *::before, .dshe-panel *::after { box-sizing: border-box; }
.dshe-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
.dshe-panel ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background-clip: content-box; background-color: color-mix(in srgb, var(--dshe-text) 16%, transparent); }

.dshe-page { max-width: 880px; margin: 0 auto; padding: 36px 28px 64px; display: flex; flex-direction: column; gap: 22px; }
.dshe-fill { flex: 1 1 auto; min-width: 0; }
.dshe-head { display: flex; align-items: flex-end; gap: 12px; }
.dshe-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshe-sub { margin: 2px 0 0; color: var(--dshe-text-3); font-size: 13px; }
.dshe-code { font-family: var(--dshe-mono); font-size: 12px; padding: 1px 6px; border-radius: 6px; background: var(--dshe-fill-2); color: var(--dshe-text); }
.dshe-empty { padding: 14px 16px; border-radius: 12px; background: var(--dshe-fill); color: var(--dshe-text-3); font-size: 13px; }

/* ---------- buttons ---------- */
.dshe-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 14px;
  border: 0; border-radius: 999px; background: var(--dshe-fill-2); color: var(--dshe-text);
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dshe-btn:hover { background: color-mix(in srgb, var(--dshe-text) 9%, var(--dshe-fill-2)); }
.dshe-btn:focus-visible, .dshe-link:focus-visible, .dshe-select:focus-visible { outline: 2px solid var(--dshe-accent); outline-offset: 2px; }
.dshe-btn[disabled] { opacity: 0.55; cursor: default; }
.dshe-btn[data-size="sm"] { height: 28px; padding: 0 12px; font-size: 12.5px; }
.dshe-btn[data-tone="primary"] { background: var(--dshe-accent); color: #fff; font-weight: 500; }
.dshe-btn[data-tone="primary"]:hover { background: color-mix(in srgb, var(--dshe-accent) 88%, #000); }
.dshe-btn[data-tone="bad"] { color: var(--dshe-bad); background: color-mix(in srgb, var(--dshe-bad) 9%, transparent); }
.dshe-btn[data-tone="bad"]:hover { background: color-mix(in srgb, var(--dshe-bad) 16%, transparent); }
.dshe-btn[data-tone="bad-solid"] { background: var(--dshe-bad); color: #fff; }
.dshe-link { border: 0; background: transparent; padding: 0 2px; color: var(--dshe-accent); font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 4px; }
.dshe-link:hover { text-decoration: underline; }

/* ---------- status bar ---------- */
.dshe-status { padding: 14px 16px; border-radius: 16px; background: var(--dshe-accent-soft); display: flex; flex-direction: column; gap: 6px; }
.dshe-status[data-mode="restart"] { background: color-mix(in srgb, var(--dshe-warn) 14%, transparent); }
.dshe-status-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshe-status-main strong { font-weight: 600; color: var(--dshe-accent); }
.dshe-status[data-mode="restart"] .dshe-status-main strong { color: color-mix(in srgb, var(--dshe-warn) 80%, var(--dshe-text)); }
.dshe-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dshe-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshe-ok) 22%, transparent); flex: none; }
.dshe-status[data-mode="restart"] .dshe-dot { background: var(--dshe-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshe-warn) 25%, transparent); }
.dshe-status-hint { color: var(--dshe-text-2); font-size: 13px; }
.dshe-status-sub { color: var(--dshe-text-3); font-size: 12.5px; padding-left: 16px; }
.dshe-alert { margin-top: 2px; padding: 8px 12px; border-radius: 10px; background: color-mix(in srgb, var(--dshe-bad) 10%, transparent); color: var(--dshe-bad); font-size: 12.5px; line-height: 18px; }
.dshe-badge { padding: 1px 10px; border-radius: 999px; background: color-mix(in srgb, var(--dshe-warn) 20%, transparent); color: color-mix(in srgb, var(--dshe-warn) 75%, var(--dshe-text)); font-size: 12px; font-weight: 500; cursor: help; }

.dshe-notice { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 12px; font-size: 13px; background: color-mix(in srgb, var(--dshe-ok) 12%, transparent); }
.dshe-notice[data-kind="error"] { background: color-mix(in srgb, var(--dshe-bad) 10%, transparent); color: var(--dshe-bad); }
.dshe-notice span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

/* ---------- sections ---------- */
.dshe-section { display: flex; flex-direction: column; gap: 10px; }
.dshe-section-head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.dshe-section-head h2 { margin: 0; font-size: 15px; line-height: 24px; font-weight: 600; }
.dshe-section-sub { color: var(--dshe-text-3); font-size: 12.5px; }

/* ---------- exit list ---------- */
.dshe-exits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dshe-exit {
  display: grid; grid-template-columns: minmax(150px, 1.1fr) minmax(0, 1.5fr) minmax(0, 1.5fr) auto; align-items: center; gap: 4px 16px;
  padding: 12px 16px; border-radius: 14px; background: var(--dshe-fill); transition: background-color 120ms ease;
}
.dshe-exit:hover { background: var(--dshe-fill-2); }
.dshe-exit-id { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.dshe-exit-name { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.dshe-exit-addr { font-family: var(--dshe-mono); font-size: 12px; color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-exit[data-builtin="true"] .dshe-exit-addr { font-family: inherit; font-size: 12.5px; color: var(--dshe-text-3); }
.dshe-exit-probe { font-size: 12.5px; min-width: 0; line-height: 18px; }
.dshe-exit-probe em { font-style: normal; margin-left: 6px; color: var(--dshe-text-3); }
.dshe-probe-ok { color: color-mix(in srgb, var(--dshe-ok) 70%, var(--dshe-text)); }
.dshe-probe-fail { color: var(--dshe-bad); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dshe-probe-none, .dshe-probe-wait { color: var(--dshe-text-3); }
.dshe-probe-wait { color: var(--dshe-accent); }
.dshe-exit-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.dshe-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--dshe-accent-soft); color: var(--dshe-accent); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.dshe-pill[data-type="direct"] { background: color-mix(in srgb, var(--dshe-text) 8%, transparent); color: var(--dshe-text-2); }
.dshe-pill[data-tone="muted"] { background: color-mix(in srgb, var(--dshe-text) 7%, transparent); color: var(--dshe-text-2); font-weight: 500; }
.dshe-pill[data-tone="accent"] { background: var(--dshe-accent); color: #fff; }

@container (max-width: 700px) {
  .dshe-exit { grid-template-columns: minmax(0, 1fr) auto; }
  .dshe-exit-addr, .dshe-exit-probe { grid-column: 1 / -1; }
  .dshe-exit-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .dshe-page { padding: 24px 16px 48px; }
}

/* ---------- form ---------- */
.dshe-form { padding: 16px 18px 14px; border-radius: 16px; background: var(--dshe-bg); box-shadow: 0 0 0 1px var(--dshe-line), 0 6px 22px rgba(15, 17, 21, 0.06); display: flex; flex-direction: column; gap: 12px; }
.dshe-form-title { font-weight: 600; font-size: 14px; }
.dshe-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dshe-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12.5px; color: var(--dshe-text-2); }
.dshe-field em { font-style: normal; color: var(--dshe-text-3); }
.dshe-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dshe-text-2); }
.dshe-input, .dshe-select {
  width: 100%; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--dshe-fill-2); color: var(--dshe-text);
  font: inherit; font-size: 13.5px; transition: box-shadow 120ms ease, background-color 120ms ease;
}
.dshe-input::placeholder { color: var(--dshe-text-3); }
.dshe-input:focus { outline: none; background: var(--dshe-bg); box-shadow: 0 0 0 1.5px var(--dshe-accent); }
.dshe-input:disabled { opacity: 0.5; }
.dshe-form-note { font-size: 12px; color: var(--dshe-text-3); }
.dshe-form-error { font-size: 12.5px; color: var(--dshe-bad); }
.dshe-form-actions { display: flex; gap: 8px; }
@container (max-width: 700px) { .dshe-form-grid { grid-template-columns: 1fr 1fr; } }

/* ---------- bindings ---------- */
.dshe-table { display: flex; flex-direction: column; border-radius: 14px; background: var(--dshe-fill); padding: 4px 6px; }
.dshe-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(190px, 1fr) minmax(130px, auto); align-items: center; gap: 12px; padding: 9px 10px; border-radius: 10px; min-height: 48px; }
.dshe-row + .dshe-row { box-shadow: 0 -0.5px 0 var(--dshe-line); }
.dshe-row-head { min-height: 32px; padding-top: 6px; padding-bottom: 2px; color: var(--dshe-text-3); font-size: 12px; box-shadow: none !important; }
.dshe-row[data-kind="default"] { background: var(--dshe-accent-soft); box-shadow: none; }
.dshe-row[data-kind="default"] + .dshe-row { box-shadow: none; }
.dshe-host { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshe-host code { font-family: var(--dshe-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.dshe-host strong { font-weight: 600; }
.dshe-host em { font-style: normal; color: var(--dshe-text-3); font-size: 12px; }
.dshe-seen { color: var(--dshe-text-3); font-size: 12px; }
.dshe-select { appearance: none; cursor: pointer; padding-right: 30px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%2381858c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; }
.dshe-select option { background: var(--dshe-bg); color: var(--dshe-text); }
.dshe-row-end { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.dshe-source { font-size: 12px; color: var(--dshe-text-3); }
.dshe-source[data-source="binding"] { color: var(--dshe-accent); font-weight: 500; }
.dshe-addhost { display: flex; gap: 8px; max-width: 460px; }
@container (max-width: 700px) {
  .dshe-row { grid-template-columns: 1fr 1fr; }
  .dshe-row-head { display: none; }
  .dshe-seen { order: 3; }
}

/* ---------- request log ---------- */
.dshe-log { list-style: none; margin: 0; padding: 4px 6px; border-radius: 14px; background: var(--dshe-fill); display: flex; flex-direction: column; }
.dshe-log li { display: grid; grid-template-columns: 8px minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 2fr) 40px; align-items: center; gap: 10px; padding: 7px 10px; font-size: 12.5px; }
.dshe-log li + li { box-shadow: 0 -0.5px 0 var(--dshe-line); }
.dshe-log code { font-family: var(--dshe-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dshe-ok); }
.dshe-log li[data-ok="false"] .dshe-log-dot { background: var(--dshe-bad); }
.dshe-log-exit { color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-result { color: var(--dshe-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log li[data-ok="false"] .dshe-log-result { color: var(--dshe-bad); }
.dshe-log-time { color: var(--dshe-text-3); text-align: right; }

@media (prefers-reduced-motion: reduce) { .dshe-btn, .dshe-exit, .dshe-input { transition: none; } }
`

/**
 * Install the panel stylesheet once per document.
 *
 * Idempotent by \`data-plugin-css\`, and a no-op without a DOM.
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-client-ui-egress'
  tag.dataset.pluginCss = STYLE_KEY
  tag.textContent = EGRESS_CSS
  document.head.appendChild(tag)
}
