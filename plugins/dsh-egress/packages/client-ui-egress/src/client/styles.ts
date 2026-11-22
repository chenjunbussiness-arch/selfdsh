/**
 * Panel stylesheet, DeepSeek style (docs/UI-STYLE.md, reference: dsh-vpn).
 *
 * One accent (#4d6bfe), rounded surfaces, separation by tone and spacing instead
 * of borders or rules. Colours come only from the host's `--dsw-alias-*` tokens
 * (so light and dark follow the shell) with the light-theme values as fallbacks,
 * so the panel still renders where no tokens are injected (the standalone
 * preview). Every class carries the `dshe-` prefix.
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
  --dshe-accent-soft: color-mix(in srgb, var(--dshe-accent) 11%, transparent);
  --dshe-on-accent: var(--dsw-alias-label-primary-foreground, #fff);
  --dshe-text: var(--dsw-alias-label-primary, #0f1115);
  --dshe-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshe-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshe-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshe-base: var(--dsw-alias-bg-base, #fff);
  --dshe-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshe-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshe-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshe-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshe-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshe-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshe-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshe-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --dshe-float: var(--dsh-shadow-float, 0 4px 18px rgba(15, 17, 21, 0.06));
  --dshe-knob: var(--dsh-shadow-knob, 0 1px 3px rgba(15, 17, 21, 0.12));

  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--dshe-base);
  color: var(--dshe-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dshe-panel *, .dshe-panel *::before, .dshe-panel *::after { box-sizing: border-box; }
.dshe-panel button, .dshe-panel input, .dshe-panel select, .dshe-panel textarea { font: inherit; color: inherit; }
.dshe-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
.dshe-panel ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background-clip: content-box; background-color: color-mix(in srgb, var(--dshe-text) 16%, transparent); }
.dshe-panel [data-tone="ok"] { --dshe-tone: var(--dshe-ok); }
.dshe-panel [data-tone="warn"] { --dshe-tone: var(--dshe-warn); }
.dshe-panel [data-tone="bad"] { --dshe-tone: var(--dshe-bad); }
.dshe-panel [data-tone="busy"] { --dshe-tone: var(--dshe-accent); }
.dshe-panel [data-tone="idle"] { --dshe-tone: var(--dshe-idle); }

/* ---------- page column and header ---------- */
.dshe-page { width: 100%; max-width: 880px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }
.dshe-spacer { flex: 1 1 auto; min-width: 0; }
.dshe-head { padding-top: 36px; display: flex; align-items: flex-start; gap: 12px; }
.dshe-head-text { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 4px; }
.dshe-head-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dshe-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshe-sub { margin: 0; font-size: 13px; color: var(--dshe-text-3); }
.dshe-badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshe-warn) 16%, transparent); color: color-mix(in srgb, var(--dshe-warn) 80%, var(--dshe-text));
  font-size: 12px; font-weight: 500; cursor: help;
}
.dshe-code { font-family: var(--dshe-mono); font-size: 12.5px; padding: 1px 7px; border-radius: 8px; background: var(--dshe-base); color: var(--dshe-text); overflow-wrap: anywhere; }
.dshe-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dshe-text-3); }

/* ---------- empty and loading ---------- */
.dshe-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 16px; text-align: center; font-size: 13px; color: var(--dshe-text-3); }
.dshe-empty-icon { width: 28px; height: 28px; opacity: 0.45; color: var(--dshe-text-3); }
.dshe-empty[data-size="page"] { padding-top: 96px; }

/* ---------- buttons ---------- */
.dshe-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dshe-hover); font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.dshe-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dshe-text) 10%, transparent); }
.dshe-btn:focus-visible, .dshe-link:focus-visible, .dshe-icon-btn:focus-visible { outline: 2px solid var(--dshe-accent); outline-offset: 2px; }
.dshe-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshe-btn[data-kind="primary"] { background: var(--dshe-accent); color: var(--dshe-on-accent); }
.dshe-btn[data-kind="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshe-accent) 88%, var(--dshe-text)); }
.dshe-btn[data-kind="danger"] { background: color-mix(in srgb, var(--dshe-bad) 12%, transparent); color: var(--dshe-bad); }
.dshe-btn[data-kind="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshe-bad) 20%, transparent); }
.dshe-btn[data-kind="danger"][data-strong="true"] { background: color-mix(in srgb, var(--dshe-bad) 20%, transparent); font-weight: 600; }
.dshe-btn[data-kind="danger"][data-strong="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshe-bad) 28%, transparent); }
.dshe-btn[data-size="sm"] { height: 30px; padding: 0 14px; font-size: 12.5px; }
.dshe-btn-plus { font-size: 16px; line-height: 1; font-weight: 400; }
.dshe-link {
  display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 12px; border: 0; border-radius: 999px;
  background: transparent; color: var(--dshe-accent); font-size: 12.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s;
}
.dshe-link:hover { background: var(--dshe-accent-soft); }
.dshe-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: var(--dshe-text-3); font-size: 16px; line-height: 1; cursor: pointer; transition: background 0.15s;
}
.dshe-icon-btn:hover { background: var(--dshe-hover); color: var(--dshe-text); }

/* ---------- status card ---------- */
.dshe-card {
  --dshe-tone: var(--dshe-ok);
  display: flex; flex-direction: column; gap: 16px; padding: 24px 26px; border-radius: 24px;
  background: color-mix(in srgb, var(--dshe-tone) 7%, var(--dshe-fill));
}
.dshe-card-top { display: flex; align-items: center; gap: 18px; }
.dshe-orb { position: relative; flex: none; width: 52px; height: 52px; border-radius: 50%; background: color-mix(in srgb, var(--dshe-tone) 18%, transparent); }
.dshe-orb::after { content: ""; position: absolute; inset: 15px; border-radius: 50%; background: var(--dshe-tone); }
.dshe-card-text { min-width: 0; flex: 1 1 auto; }
.dshe-state { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; color: color-mix(in srgb, var(--dshe-tone) 70%, var(--dshe-text)); }
.dshe-card[data-tone="warn"] .dshe-state { color: color-mix(in srgb, var(--dshe-tone) 80%, var(--dshe-text)); }
.dshe-card-sub { margin: 2px 0 0; font-size: 13.5px; color: var(--dshe-text-2); }
.dshe-card-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.dshe-card-note { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--dshe-text-3); }
.dshe-card-note::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dshe-text-3); opacity: 0.6; }

.dshe-alert { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px; background: color-mix(in srgb, var(--dshe-bad) 9%, var(--dshe-base)); font-size: 13px; color: var(--dshe-text); overflow-wrap: anywhere; }
.dshe-alert[data-kind="warn"] { background: color-mix(in srgb, var(--dshe-warn) 12%, var(--dshe-base)); }

/* ---------- notice (toast line) ---------- */
.dshe-notice { display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: 14px; font-size: 13px; background: color-mix(in srgb, var(--dshe-ok) 10%, var(--dshe-base)); color: var(--dshe-text); }
.dshe-notice::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshe-ok); }
.dshe-notice[data-kind="error"] { background: color-mix(in srgb, var(--dshe-bad) 9%, var(--dshe-base)); }
.dshe-notice[data-kind="error"]::before { background: var(--dshe-bad); }
.dshe-notice-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

/* ---------- sections ---------- */
.dshe-section { display: flex; flex-direction: column; gap: 8px; }
.dshe-section-head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dshe-section-title { margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dshe-text-3); }
.dshe-section-sub { min-width: 0; font-size: 12px; line-height: 18px; color: var(--dshe-text-3); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-section-sub::before { content: "\\00b7"; margin-right: 8px; }

/* ---------- status dot and pills ---------- */
.dshe-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshe-tone, var(--dshe-idle)); }
.dshe-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--dshe-base); color: var(--dshe-text-2); font-size: 12px; font-weight: 500; white-space: nowrap; }
.dshe-pill[data-kind="accent"] { background: var(--dshe-accent-soft); color: var(--dshe-accent); }
.dshe-pill[data-kind="muted"] { color: var(--dshe-text-3); font-weight: 400; }

/* ---------- exit list ---------- */
.dshe-exits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dshe-exit {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "id actions" "meta actions"; align-items: center; gap: 6px 16px;
  padding: 16px 16px 16px 20px; border-radius: 16px; background: var(--dshe-fill); transition: background 0.15s;
}
.dshe-exit:hover { background: var(--dshe-fill-2); }
.dshe-exit-id { grid-area: id; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshe-exit-name { font-weight: 600; font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.dshe-exit-meta { grid-area: meta; display: flex; align-items: center; gap: 8px 20px; flex-wrap: wrap; min-width: 0; }
.dshe-exit-addr { min-width: 0; max-width: 100%; font-family: var(--dshe-mono); font-size: 12.5px; line-height: 20px; color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-exit[data-builtin="true"] .dshe-exit-addr { font-family: inherit; color: var(--dshe-text-3); }
.dshe-exit-probe { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12.5px; line-height: 20px; color: var(--dshe-text-3); }
.dshe-exit-probe em { font-style: normal; margin-left: 6px; color: var(--dshe-text-3); }
.dshe-exit-probe[data-tone="ok"] .dshe-probe-text { color: color-mix(in srgb, var(--dshe-ok) 70%, var(--dshe-text)); }
.dshe-exit-probe[data-tone="bad"] .dshe-probe-text { color: var(--dshe-bad); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dshe-exit-probe[data-tone="busy"] .dshe-probe-text { color: var(--dshe-accent); }
.dshe-probe-text { min-width: 0; }
.dshe-exit-actions { grid-area: actions; display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

/* ---------- form ---------- */
.dshe-form { display: flex; flex-direction: column; gap: 16px; padding: 24px 26px; border-radius: 24px; background: var(--dshe-base); box-shadow: 0 0 0 0.5px var(--dshe-line), var(--dshe-float); }
.dshe-form-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; }
.dshe-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.dshe-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshe-field[data-span="2"] { grid-column: span 2; }
.dshe-label { font-size: 12.5px; line-height: 18px; color: var(--dshe-text-2); font-weight: 500; }
.dshe-label em { font-style: normal; font-weight: 400; color: var(--dshe-text-3); margin-left: 4px; }
.dshe-input, .dshe-select {
  width: 100%; height: 40px; padding: 0 12px; border: 0; border-radius: 12px; background: var(--dshe-fill); color: var(--dshe-text);
  font-size: 14px; outline: none; transition: box-shadow 0.15s, opacity 0.15s;
}
.dshe-input::placeholder { color: var(--dshe-text-3); }
.dshe-input:focus, .dshe-select:focus-visible { box-shadow: 0 0 0 1.5px var(--dshe-accent); }
.dshe-input:disabled { opacity: 0.5; cursor: not-allowed; }
.dshe-input[data-mono="true"] { font-family: var(--dshe-mono); font-size: 13px; }
.dshe-select-wrap { position: relative; display: block; min-width: 0; }
.dshe-select-wrap::after {
  content: ""; position: absolute; right: 14px; top: 50%; width: 6px; height: 6px; pointer-events: none;
  border-right: 1.5px solid var(--dshe-text-3); border-bottom: 1.5px solid var(--dshe-text-3); transform: translateY(-70%) rotate(45deg);
}
.dshe-select { appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 34px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-select option { background: var(--dshe-base); color: var(--dshe-text); }
.dshe-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 999px; background: var(--dshe-fill); align-self: flex-start; max-width: 100%; }
.dshe-seg button { height: 34px; padding: 0 14px; border: 0; border-radius: 999px; background: transparent; font-size: 13px; color: var(--dshe-text-2); cursor: pointer; transition: background 0.15s; }
.dshe-seg button:hover:not([aria-checked="true"]) { background: var(--dshe-hover); }
.dshe-seg button[aria-checked="true"] { background: var(--dshe-base); color: var(--dshe-accent); font-weight: 600; box-shadow: var(--dshe-knob); }
.dshe-seg button:focus-visible { outline: 2px solid var(--dshe-accent); outline-offset: 1px; }
.dshe-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--dshe-text-2); cursor: pointer; }
.dshe-check input { margin: 0; accent-color: var(--dshe-accent); }
.dshe-form-error { margin: 0; font-size: 13px; color: var(--dshe-bad); }
.dshe-form-foot { display: flex; align-items: center; gap: 8px; padding-top: 4px; }

/* ---------- bindings table ---------- */
.dshe-table { display: flex; flex-direction: column; gap: 2px; }
.dshe-row {
  display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(190px, 1fr) minmax(140px, auto); align-items: center; gap: 12px;
  min-height: 48px; padding: 6px 12px; border-radius: 12px; transition: background 0.15s;
}
.dshe-row:hover:not(.dshe-row-head) { background: var(--dshe-hover); }
.dshe-row-head { min-height: 30px; padding-top: 0; padding-bottom: 0; color: var(--dshe-text-3); font-size: 12px; line-height: 18px; }
.dshe-row[data-kind="default"] { background: var(--dshe-fill); margin-bottom: 4px; }
.dshe-row[data-kind="default"]:hover { background: var(--dshe-fill-2); }
.dshe-row[data-kind="default"] .dshe-select { background: var(--dshe-base); }
.dshe-row .dshe-select { height: 34px; font-size: 13.5px; }
.dshe-row .dshe-pill { background: var(--dshe-fill); }
.dshe-host { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshe-host code { font-family: var(--dshe-mono); font-size: 13px; overflow-wrap: anywhere; }
.dshe-host strong { font-weight: 600; }
.dshe-host em { font-style: normal; color: var(--dshe-text-3); font-size: 12px; }
.dshe-seen { color: var(--dshe-text-3); font-size: 12px; }
.dshe-row-end { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.dshe-source { font-size: 12px; color: var(--dshe-text-3); white-space: nowrap; }
.dshe-source[data-source="binding"] { color: var(--dshe-accent); font-weight: 500; }
.dshe-addhost { display: flex; align-items: center; gap: 8px; max-width: 480px; padding-top: 4px; }

/* ---------- request log ---------- */
.dshe-log { list-style: none; margin: 0; padding: 6px; border-radius: 16px; background: var(--dshe-fill); display: flex; flex-direction: column; gap: 2px; }
.dshe-log li {
  display: grid; grid-template-columns: 8px minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 2fr) 44px; align-items: center; gap: 12px;
  min-height: 36px; padding: 0 12px; border-radius: 12px; font-size: 12.5px; transition: background 0.15s;
}
.dshe-log li:hover { background: var(--dshe-hover); }
.dshe-log li { --dshe-tone: var(--dshe-ok); }
.dshe-log li[data-ok="false"] { --dshe-tone: var(--dshe-bad); }
.dshe-log code { font-family: var(--dshe-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-exit { color: var(--dshe-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log-result { color: var(--dshe-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshe-log li[data-ok="false"] .dshe-log-result { color: var(--dshe-bad); }
.dshe-log-time { font-family: var(--dshe-mono); font-size: 12px; color: var(--dshe-text-3); text-align: right; }

/* ---------- narrow container ---------- */
@container (max-width: 760px) {
  .dshe-page { padding: 0 16px 40px; }
  .dshe-head { padding-top: 24px; }
  .dshe-card { padding: 20px; }
  .dshe-card-top { flex-wrap: wrap; }
  .dshe-exit { grid-template-columns: minmax(0, 1fr); grid-template-areas: "id" "meta" "actions"; }
  .dshe-exit-actions { justify-content: flex-start; }
  .dshe-form { padding: 20px; }
  .dshe-form-grid { grid-template-columns: minmax(0, 1fr); }
  .dshe-field[data-span="2"] { grid-column: auto; }
  .dshe-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 10px 12px; }
  .dshe-row-head { display: none; }
  .dshe-seen { order: 3; }
  .dshe-section-sub { display: none; }
  .dshe-log li { grid-template-columns: 8px minmax(0, 1fr) 44px; grid-template-areas: "dot host time" ". exit exit" ". result result"; row-gap: 2px; padding: 8px 12px; }
  .dshe-log-dot { grid-area: dot; }
  .dshe-log-host { grid-area: host; }
  .dshe-log-time { grid-area: time; }
  .dshe-log-exit { grid-area: exit; }
  .dshe-log-result { grid-area: result; }
}
@media (prefers-reduced-motion: reduce) {
  .dshe-btn, .dshe-link, .dshe-icon-btn, .dshe-exit, .dshe-input, .dshe-select, .dshe-seg button, .dshe-row, .dshe-log li { transition: none; }
}
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
