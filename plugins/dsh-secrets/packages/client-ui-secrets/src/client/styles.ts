/**
 * Page stylesheet, per docs/UI-STYLE.md: one accent (#4d6bfe), no 1px borders
 * (layers by fill and spacing), pill buttons and segmented control, colours
 * from the host's `--dsw-alias-*` tokens (so light and dark follow the shell)
 * with light-theme fallbacks. Every class carries the `dss-` prefix.
 */

const STYLE_KEY = 'dsh-client-ui-secrets/SecretsPage.css'

/** Stylesheet text. */
export const SECRETS_CSS = `
.dss-page, .dss-layer {
  --dss-accent: #4d6bfe;
  --dss-accent-soft: color-mix(in srgb, var(--dss-accent) 11%, transparent);
  --dss-text: var(--dsw-alias-label-primary, #0f1115);
  --dss-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dss-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dss-line: var(--dsw-alias-border-l, #e1e5ee);
  --dss-base: var(--dsw-alias-bg-base, #fff);
  --dss-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dss-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dss-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dss-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dss-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dss-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dss-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dss-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --dss-shadow: 0 0 0 0.5px color-mix(in srgb, var(--dss-text) 12%, transparent), 0 12px 40px color-mix(in srgb, var(--dss-text) 14%, transparent);
  color: var(--dss-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
.dss-page { height: 100%; min-height: 0; overflow-y: auto; background: var(--dss-base); container-type: inline-size; }
/* Sheets and toasts are portalled to <body> inside .dss-layer (same tokens). */
.dss-layer { position: fixed; inset: 0; z-index: 1000; pointer-events: none; }
.dss-layer > * { pointer-events: auto; }
.dss-page *, .dss-page *::before, .dss-page *::after, .dss-layer *, .dss-layer *::before, .dss-layer *::after { box-sizing: border-box; }
.dss-page button, .dss-page input, .dss-page textarea, .dss-layer button, .dss-layer input, .dss-layer textarea { font: inherit; color: inherit; }
.dss-col { width: 100%; max-width: 1100px; margin: 0 auto; padding: 0 24px 56px; display: flex; flex-direction: column; gap: 20px; }
.dss-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.dss-mono, .dss-page code, .dss-layer code { font-family: var(--dss-mono); font-size: 12.5px; }

/* ---------- head ---------- */
.dss-head { padding-top: 40px; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dss-head-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dss-sub { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-3); }
.dss-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dss-updated { font-size: 12px; color: var(--dss-text-3); }

/* ---------- buttons ---------- */
.dss-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 16px; border: 0;
  border-radius: 999px; background: var(--dss-hover); cursor: pointer; font-size: 13.5px; font-weight: 500; white-space: nowrap;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.dss-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-text) 9%, transparent); }
.dss-btn:disabled { opacity: 0.5; cursor: default; }
.dss-btn:focus-visible, .dss-segment:focus-visible, .dss-filter:focus-visible, .dss-tag:focus-visible, .dss-icon-btn:focus-visible, .dss-input-toggle:focus-visible {
  outline: 2px solid var(--dss-accent); outline-offset: 2px;
}
.dss-btn[data-primary="true"] { background: var(--dss-accent); color: #fff; }
.dss-btn[data-primary="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-accent) 88%, #000); }
.dss-btn[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, transparent); color: var(--dss-bad); }
.dss-btn[data-danger="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dss-bad) 18%, transparent); }
.dss-btn-sm { height: 30px; padding: 0 12px; font-size: 12.5px; }
.dss-icon-btn {
  width: 30px; height: 30px; border: 0; border-radius: 999px; background: var(--dss-hover); cursor: pointer;
  font-size: 18px; line-height: 30px; color: var(--dss-text-2);
}
.dss-link { border: 0; background: none; padding: 0; color: var(--dss-accent); cursor: pointer; font-size: 12px; }

/* ---------- segmented control ---------- */
.dss-segmented { display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px; border-radius: 999px; background: var(--dss-fill-2); max-width: 100%; overflow-x: auto; }
.dss-segment {
  height: 32px; padding: 0 18px; border: 0; border-radius: 999px; background: transparent; cursor: pointer;
  font-size: 13.5px; color: var(--dss-text-2); white-space: nowrap; transition: background 0.15s ease, color 0.15s ease;
}
.dss-segment:hover { color: var(--dss-text); }
.dss-segment[data-on="true"] {
  background: var(--dss-base); color: var(--dss-accent); font-weight: 600;
  box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--dss-text) 10%, transparent), 0 1px 3px color-mix(in srgb, var(--dss-text) 10%, transparent);
}

/* ---------- sections ---------- */
.dss-section { display: flex; flex-direction: column; gap: 16px; }
.dss-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
.dss-section-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; }

/* ---------- write-only notice ---------- */
.dss-notice { display: flex; gap: 12px; padding: 16px 18px; border-radius: 14px; background: color-mix(in srgb, var(--dss-warn) 12%, var(--dss-base)); }
.dss-notice-icon { flex: none; color: color-mix(in srgb, var(--dss-warn) 85%, var(--dss-text)); margin-top: 1px; }
.dss-notice-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-notice-title { font-weight: 600; font-size: 14px; color: color-mix(in srgb, var(--dss-warn) 60%, var(--dss-text)); }
.dss-notice-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }

/* ---------- vault status ---------- */
.dss-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--dss-text-2); }
.dss-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border-radius: 999px; flex: none;
  background: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 14%, transparent);
  color: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 70%, var(--dss-text)); font-weight: 600; font-size: 12.5px;
}
.dss-chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dss-tone, var(--dss-idle)); }
.dss-page [data-tone="unlocked"] { --dss-tone: var(--dss-ok); }
.dss-page [data-tone="missing"] { --dss-tone: var(--dss-idle); }
.dss-page [data-tone="locked"] { --dss-tone: var(--dss-warn); }
.dss-page [data-tone="error"] { --dss-tone: var(--dss-bad); }
.dss-status-sep { color: var(--dss-text-3); }
.dss-status-path { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-status-key[data-ok="false"] { color: var(--dss-warn); }

/* ---------- banners ---------- */
.dss-banner { display: flex; flex-direction: column; gap: 4px; padding: 14px 18px; border-radius: 14px; background: var(--dss-fill); }
.dss-banner[data-tone] { background: color-mix(in srgb, var(--dss-tone) 10%, var(--dss-base)); }
.dss-banner-title { font-weight: 600; }
.dss-banner-text { margin: 0; font-size: 13px; color: var(--dss-text-2); }
.dss-banner-detail { margin: 0; font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }

/* ---------- toolbar ---------- */
.dss-toolbar { display: flex; flex-direction: column; gap: 10px; }
.dss-search, .dss-input {
  width: 100%; height: 40px; padding: 0 14px; border: 0; border-radius: 12px; background: var(--dss-fill-2);
  outline: none; font-size: 13.5px; transition: box-shadow 0.15s ease;
}
.dss-search { max-width: 420px; }
.dss-search:focus, .dss-input:focus { box-shadow: inset 0 0 0 1.5px var(--dss-accent); }
.dss-textarea { height: auto; min-height: 64px; padding: 10px 14px; resize: vertical; line-height: 20px; }
.dss-tags-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dss-filter {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 12.5px;
}
.dss-filter:hover { background: var(--dss-hover); }
.dss-filter[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); font-weight: 600; }
.dss-filter-count { color: var(--dss-text-3); font-variant-numeric: tabular-nums; }
.dss-filter[data-on="true"] .dss-filter-count { color: inherit; opacity: 0.75; }
.dss-toolbar-foot { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dss-text-3); }

/* ---------- table (no grid lines; whole-row rounded hover) ---------- */
.dss-table-wrap { overflow-x: auto; border-radius: 24px; background: var(--dss-fill); padding: 8px; }
.dss-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.dss-table th {
  text-align: left; font-weight: 500; font-size: 12px; color: var(--dss-text-3); padding: 8px 12px; white-space: nowrap;
}
.dss-table td { padding: 11px 12px; vertical-align: top; }
.dss-table tbody tr td:first-child { border-radius: 12px 0 0 12px; }
.dss-table tbody tr td:last-child { border-radius: 0 12px 12px 0; }
.dss-table tbody tr:hover td { background: var(--dss-hover); }
.dss-cell-name code { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-cell-desc { min-width: 180px; max-width: 380px; color: var(--dss-text-2); overflow-wrap: anywhere; white-space: pre-wrap; }
.dss-cell-tags { min-width: 110px; }
.dss-cell-tags-list { display: flex; flex-wrap: wrap; gap: 4px; }
.dss-tag {
  height: 22px; padding: 0 9px; border: 0; border-radius: 999px; background: var(--dss-base); color: var(--dss-text-2);
  font-size: 12px; cursor: pointer;
}
.dss-tag:hover { background: var(--dss-hover); }
.dss-tag[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); }
.dss-cell-fp code { padding: 2px 8px; border-radius: 999px; background: var(--dss-base); letter-spacing: 0.04em; white-space: nowrap; }
.dss-cell-len { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dss-text-2); }
.dss-cell-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dss-cell-time span { display: block; }
.dss-cell-actions { width: 1%; }
.dss-row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: nowrap; }
.dss-table .dss-row-actions { opacity: 0.55; transition: opacity 0.15s ease; }
.dss-table tbody tr:hover .dss-row-actions, .dss-table .dss-row-actions:focus-within { opacity: 1; }
.dss-table .dss-btn-sm { background: var(--dss-base); }
.dss-table .dss-btn-sm[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, var(--dss-base)); }
.dss-muted { color: var(--dss-text-3); }
.dss-cell-time .dss-muted { font-size: 12px; line-height: 17px; }

/* ---------- list rows (credentials) ---------- */
.dss-list { display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: 24px; background: var(--dss-fill); }
.dss-list-row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px; border-radius: 12px; transition: background 0.15s ease; }
.dss-list-row:hover { background: var(--dss-hover); }
.dss-list-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dss-list-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-list-sub { font-size: 12.5px; color: var(--dss-text-3); }
.dss-list-state { font-size: 12.5px; color: var(--dss-text-2); white-space: nowrap; }
.dss-list-row .dss-btn-sm { background: var(--dss-base); }
.dss-list-row .dss-btn-sm[data-danger="true"] { background: color-mix(in srgb, var(--dss-bad) 12%, var(--dss-base)); }
.dss-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dss-idle); }
.dss-dot[data-state="ok"] { background: var(--dss-ok); }
.dss-dot[data-state="warn"] { background: var(--dss-warn); }
.dss-dot[data-state="bad"] { background: var(--dss-bad); }

/* ---------- plugin cards ---------- */
.dss-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dss-card { display: flex; flex-direction: column; gap: 14px; padding: 24px 26px; border-radius: 24px; background: var(--dss-fill); }
.dss-card[data-installed="false"] { opacity: 0.62; }
.dss-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dss-card-title-wrap { min-width: 0; }
.dss-card-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; font-family: var(--dss-mono); }
.dss-card-sub { margin: 2px 0 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-card-note { margin: 0; font-size: 12.5px; line-height: 19px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-needs { display: flex; flex-direction: column; gap: 2px; margin: 0 -10px; }
.dss-need { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; }
.dss-need:hover { background: var(--dss-hover); }
.dss-need-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dss-need-name { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; flex-wrap: wrap; }
.dss-need-tag { font-size: 11.5px; font-weight: 500; color: var(--dss-text-3); }
.dss-need-detail { font-size: 12.5px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-need-detail[data-mono="true"] { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-2); }
.dss-need .dss-btn-sm { background: var(--dss-base); }

/* ---------- sheet ---------- */
.dss-sheet-backdrop {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: color-mix(in srgb, var(--dss-text) 28%, transparent); animation: dss-fade 0.15s ease;
}
.dss-sheet {
  width: 100%; max-width: 460px; max-height: calc(100% - 24px); overflow-y: auto; padding: 22px 24px 24px; border-radius: 24px;
  background: var(--dss-base); color: var(--dss-text); box-shadow: var(--dss-shadow);
}
.dss-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.dss-sheet-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
.dss-sheet-form { display: flex; flex-direction: column; gap: 14px; }
.dss-sheet-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-sheet-error { margin: 0; padding: 10px 14px; border-radius: 12px; font-size: 13px; background: color-mix(in srgb, var(--dss-bad) 9%, var(--dss-base)); color: var(--dss-bad); overflow-wrap: anywhere; }
.dss-sheet-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dss-btn-left { margin-right: auto; }
.dss-field { display: flex; flex-direction: column; gap: 6px; }
.dss-field-label { font-size: 12px; color: var(--dss-text-3); font-weight: 500; }
.dss-field-hint { font-size: 12px; color: var(--dss-text-3); }
.dss-secret-input { position: relative; }
.dss-secret-input .dss-input { padding-right: 64px; font-family: var(--dss-mono); }
.dss-input-toggle {
  position: absolute; top: 5px; right: 5px; height: 30px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--dss-base); cursor: pointer; font-size: 12px; color: var(--dss-text-2);
}
.dss-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dss-text-2); cursor: pointer; }
.dss-check input { accent-color: var(--dss-accent); width: 16px; height: 16px; }

/* ---------- toast ---------- */
.dss-toast {
  position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: calc(100% - 32px);
  padding: 10px 18px; border-radius: 999px; background: var(--dss-base); box-shadow: var(--dss-shadow);
  font-size: 13.5px; font-weight: 500; animation: dss-rise 0.2s ease;
}
.dss-toast[data-tone="ok"]::before { content: "✓ "; color: var(--dss-ok); }
.dss-toast[data-tone="bad"] { color: var(--dss-bad); }

/* ---------- empty / error / loading ---------- */
.dss-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 56px 16px; text-align: center; }
.dss-empty-title { font-weight: 600; font-size: 15px; }
.dss-empty-hint { max-width: 520px; font-size: 13px; color: var(--dss-text-3); }
.dss-empty .dss-btn { margin-top: 10px; }
.dss-empty[data-bad="true"] .dss-empty-title { color: var(--dss-bad); }

@keyframes dss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dss-rise { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

@container (max-width: 760px) {
  .dss-col { padding: 0 16px 40px; gap: 16px; }
  .dss-head { padding-top: 24px; }
  .dss-cards { grid-template-columns: minmax(0, 1fr); }
  .dss-card { padding: 20px; }
  .dss-cell-desc { min-width: 150px; }
  .dss-list-row { flex-wrap: wrap; }
  .dss-list-state { order: 3; width: 100%; padding-left: 20px; white-space: normal; }
  .dss-row-actions { flex-wrap: wrap; }
  .dss-table .dss-row-actions { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dss-btn, .dss-segment, .dss-list-row, .dss-input, .dss-search, .dss-table .dss-row-actions { transition: none; }
  .dss-sheet-backdrop, .dss-toast { animation: none; }
}
`

/** Install the stylesheet once per document; a no-op without a DOM. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-client-ui-secrets'
  tag.dataset['pluginCss'] = STYLE_KEY
  tag.textContent = SECRETS_CSS
  document.head.appendChild(tag)
}
