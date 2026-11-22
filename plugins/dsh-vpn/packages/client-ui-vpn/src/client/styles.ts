/**
 * Page stylesheet, DeepSeek style: one accent (#4d6bfe), rounded surfaces,
 * separation by tone and spacing instead of borders. Colours come from the
 * host's `--dsw-alias-*` tokens (so light and dark follow the shell) with the
 * light-theme values as fallbacks. Every class carries the `dshv-` prefix.
 *
 * Text that sits on a tinted or neutral surface uses the `*-text` variants: the
 * raw state colour mixed a little towards `--dshv-text`, which darkens it on a
 * light theme and lightens it on a dark one, so amber / red / blue copy keeps
 * readable contrast in both. Shadows derive from `--dshv-line` for the same
 * reason (a shadow made from the text colour would glow on a dark theme).
 *
 * Two size containers: `dshv-root` (whole page; rail collapses under 760px) and
 * `dshv-main` (the content column; stats, form grids and actions reflow).
 */

const STYLE_KEY = 'dsh-client-ui-vpn/VpnPage.css'

/** Stylesheet text. */
export const VPN_CSS = `
.dshv-root { container: dshv-root / inline-size; height: 100%; min-height: 0; }
.dshv-page {
  --dshv-accent: #4d6bfe;
  --dshv-accent-soft: color-mix(in srgb, var(--dshv-accent) 11%, transparent);
  --dshv-text: var(--dsw-alias-label-primary, #0f1115);
  --dshv-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshv-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshv-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshv-base: var(--dsw-alias-bg-base, #fff);
  --dshv-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshv-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshv-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshv-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshv-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshv-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshv-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshv-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --dshv-on-accent: var(--dsw-alias-label-primary-foreground, #fff);
  --dshv-accent-text: color-mix(in srgb, var(--dshv-accent) 88%, var(--dshv-text));
  --dshv-ok-text: color-mix(in srgb, var(--dshv-ok) 70%, var(--dshv-text));
  --dshv-warn-text: color-mix(in srgb, var(--dshv-warn) 72%, var(--dshv-text));
  --dshv-bad-text: color-mix(in srgb, var(--dshv-bad) 86%, var(--dshv-text));
  --dshv-shadow-soft: color-mix(in srgb, var(--dshv-line) 55%, transparent);
  display: grid;
  grid-template-columns: 272px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  background: var(--dshv-base);
  color: var(--dshv-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
.dshv-page *, .dshv-page *::before, .dshv-page *::after { box-sizing: border-box; }
.dshv-page button, .dshv-page input, .dshv-page textarea { font: inherit; color: inherit; }
.dshv-page [data-tone="connected"] { --dshv-tone: var(--dshv-ok); }
.dshv-page [data-tone="connecting"] { --dshv-tone: var(--dshv-accent); }
.dshv-page [data-tone="failed"] { --dshv-tone: var(--dshv-bad); }
.dshv-page [data-tone="disconnected"] { --dshv-tone: var(--dshv-idle); }

/* ---------- left rail ---------- */
/* Rail text starts 20px in: 10px scroll padding + 10px row padding. Head and foot match. */
.dshv-rail { display: flex; flex-direction: column; min-height: 0; background: var(--dshv-fill); }
.dshv-rail-head { display: flex; align-items: center; justify-content: space-between; min-height: 30px; padding: 22px 20px 8px; }
.dshv-rail-title { font-size: 12px; line-height: 18px; color: var(--dshv-text-3); font-weight: 500; }
.dshv-rail-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.dshv-profile {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 12px;
  background: transparent; text-align: left; cursor: pointer; transition: background 0.15s;
}
.dshv-profile:hover { background: var(--dshv-hover); }
.dshv-profile[data-on="true"] { background: var(--dshv-accent-soft); }
.dshv-profile:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: -2px; }
.dshv-profile-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshv-tone, transparent); }
.dshv-profile-main { min-width: 0; flex: 1 1 auto; }
.dshv-profile-name { display: block; font-size: 13.5px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-profile[data-on="true"] .dshv-profile-name { color: var(--dshv-accent-text); font-weight: 600; }
.dshv-profile-sub { display: block; font-size: 12px; line-height: 17px; color: var(--dshv-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-profile-sub[data-warn="true"] { color: var(--dshv-warn-text); }
.dshv-rail-foot { padding: 6px 10px 16px; }
.dshv-new {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; padding: 0 10px; border: 0; border-radius: 12px;
  background: transparent; color: var(--dshv-accent-text); font-size: 13.5px; font-weight: 500; cursor: pointer; transition: background 0.15s;
}
.dshv-new:hover { background: var(--dshv-accent-soft); }
.dshv-new:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: -2px; }
.dshv-new-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; font-size: 16px; line-height: 1; }

/* ---------- empty / loading ---------- */
.dshv-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  margin: 0; padding: 24px 12px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dshv-text-3);
}
.dshv-empty-icon { display: inline-flex; color: var(--dshv-text-3); opacity: 0.6; }
.dshv-rail-empty { padding: 28px 14px; }

/* ---------- main column ---------- */
.dshv-main { container: dshv-main / inline-size; min-width: 0; min-height: 0; overflow-y: auto; }
.dshv-col { width: 100%; max-width: 820px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }
.dshv-head { padding-top: 36px; display: flex; flex-direction: column; gap: 4px; }
.dshv-head-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshv-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshv-sub { margin: 0; font-size: 13px; line-height: 20px; color: var(--dshv-text-3); }
.dshv-badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshv-warn) 14%, transparent); color: var(--dshv-warn-text);
  font-size: 12px; font-weight: 500;
}
.dshv-note { margin: 0; font-size: 12.5px; line-height: 19px; color: var(--dshv-text-3); }

/* ---------- status card ---------- */
.dshv-card {
  --dshv-tone: var(--dshv-idle);
  display: flex; flex-direction: column; gap: 18px; padding: 24px 26px; border-radius: 24px;
  background: color-mix(in srgb, var(--dshv-tone) 7%, var(--dshv-fill));
}
.dshv-card-top { display: flex; align-items: center; gap: 18px; }
.dshv-orb {
  position: relative; flex: none; width: 52px; height: 52px; border-radius: 50%;
  background: color-mix(in srgb, var(--dshv-tone) 18%, transparent);
}
.dshv-orb::after {
  content: ""; position: absolute; inset: 15px; border-radius: 50%; background: var(--dshv-tone);
}
.dshv-card[data-tone="connecting"] .dshv-orb::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%; box-shadow: 0 0 0 2px var(--dshv-tone); opacity: 0.5;
  animation: dshv-pulse 1.4s ease-out infinite;
}
@keyframes dshv-pulse { from { transform: scale(0.7); opacity: 0.7; } to { transform: scale(1.35); opacity: 0; } }
.dshv-card-text { min-width: 0; flex: 1 1 auto; }
.dshv-state { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; color: var(--dshv-text); }
.dshv-card[data-tone="connected"] .dshv-state { color: var(--dshv-ok-text); }
.dshv-card[data-tone="failed"] .dshv-state { color: var(--dshv-bad-text); }
.dshv-card-sub { margin: 2px 0 0; font-size: 13.5px; line-height: 20px; color: var(--dshv-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-card-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.dshv-card-msgs { display: flex; flex-direction: column; gap: 10px; }
.dshv-card-msgs:empty { display: none; }

.dshv-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dshv-hover); font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.dshv-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-text) 10%, transparent); }
.dshv-btn:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: 2px; }
.dshv-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshv-btn[data-kind="primary"] { background: var(--dshv-accent); color: var(--dshv-on-accent); }
.dshv-btn[data-kind="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-accent) 88%, var(--dshv-text)); }
.dshv-btn[data-kind="danger"] { background: color-mix(in srgb, var(--dshv-bad) 12%, transparent); color: var(--dshv-bad-text); }
.dshv-btn[data-kind="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshv-bad) 20%, transparent); }
.dshv-btn[data-size="sm"] { height: 30px; padding: 0 14px; font-size: 12.5px; }

.dshv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dshv-stat { min-width: 0; padding: 12px 14px; border-radius: 14px; background: var(--dshv-base); }
.dshv-stat-label { display: block; font-size: 12px; line-height: 16px; color: var(--dshv-text-3); }
.dshv-stat-value { display: block; margin-top: 4px; font-family: var(--dshv-mono); font-size: 14px; line-height: 22px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dshv-block { display: flex; flex-direction: column; gap: 8px; }
.dshv-block-title { font-size: 12px; line-height: 18px; color: var(--dshv-text-3); font-weight: 500; }
.dshv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dshv-chip { display: inline-flex; align-items: center; max-width: 100%; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--dshv-base); font-family: var(--dshv-mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshv-chip[data-quiet="true"] { font-family: inherit; color: var(--dshv-text-3); }

.dshv-watch { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dshv-text-2); }
.dshv-watch-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshv-idle); }
.dshv-watch-title { font-weight: 600; color: var(--dshv-text); }
.dshv-watch[data-state="watching"] .dshv-watch-dot { background: var(--dshv-accent); }
.dshv-watch[data-state="passed"] .dshv-watch-dot { background: var(--dshv-ok); }
.dshv-watch[data-state="tripped"] .dshv-watch-dot { background: var(--dshv-bad); }
.dshv-watch[data-state="tripped"], .dshv-watch[data-state="tripped"] .dshv-watch-title { color: var(--dshv-bad-text); }

.dshv-alert {
  display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--dshv-bad) 9%, var(--dshv-base)); font-size: 13px; line-height: 20px; color: var(--dshv-text);
}
.dshv-alert[data-kind="warn"] { background: color-mix(in srgb, var(--dshv-warn) 12%, var(--dshv-base)); }
.dshv-alert-title { font-weight: 600; }
.dshv-alert pre { margin: 0; padding: 10px 12px; border-radius: 12px; background: var(--dshv-fill); font-family: var(--dshv-mono); font-size: 12px; line-height: 19px; white-space: pre-wrap; word-break: break-all; }
.dshv-alert-row { display: flex; align-items: flex-start; gap: 8px; }
.dshv-alert-row > pre { flex: 1 1 auto; min-width: 0; }
.dshv-alert-row > .dshv-btn { flex: none; margin-top: 4px; }

/* ---------- form ---------- */
/* Groups separate by spacing (22px between, 14px inside), never by a rule. */
.dshv-form {
  display: flex; flex-direction: column; gap: 22px; padding: 24px 26px; border-radius: 24px; background: var(--dshv-base);
  box-shadow: 0 0 0 0.5px var(--dshv-line), 0 4px 16px var(--dshv-shadow-soft);
}
.dshv-form-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; }
.dshv-group { display: flex; flex-direction: column; gap: 14px; }
.dshv-grid { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 14px; }
.dshv-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dshv-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshv-label { font-size: 12.5px; line-height: 18px; color: var(--dshv-text-2); font-weight: 500; }
.dshv-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dshv-text-3); }
.dshv-input {
  width: 100%; min-height: 40px; padding: 9px 12px; border: 0; border-radius: 12px; background: var(--dshv-fill);
  font-size: 14px; line-height: 22px; outline: none; transition: box-shadow 0.15s, background 0.15s;
}
.dshv-input:hover { background: var(--dshv-fill-2); }
.dshv-input:focus, .dshv-input:focus-visible { background: var(--dshv-fill); box-shadow: 0 0 0 1.5px var(--dshv-accent); }
.dshv-input::placeholder { color: var(--dshv-text-3); }
.dshv-input[data-mono="true"] { font-family: var(--dshv-mono); font-size: 13px; }
textarea.dshv-input { display: block; resize: vertical; min-height: 88px; }
.dshv-seg { display: inline-flex; flex-wrap: wrap; padding: 3px; gap: 2px; border-radius: 999px; background: var(--dshv-fill); align-self: flex-start; max-width: 100%; }
.dshv-seg button {
  height: 32px; padding: 0 16px; border: 0; border-radius: 999px; background: transparent; font-size: 13px; color: var(--dshv-text-2);
  cursor: pointer; white-space: nowrap; transition: background 0.15s;
}
.dshv-seg button:hover:not([aria-checked="true"]) { background: var(--dshv-hover); }
.dshv-seg button[aria-checked="true"] { background: var(--dshv-base); color: var(--dshv-accent-text); font-weight: 600; box-shadow: 0 0 0 0.5px var(--dshv-line), 0 1px 3px var(--dshv-shadow-soft); }
.dshv-seg button:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: 1px; }
.dshv-check { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; line-height: 22px; color: var(--dshv-text-2); cursor: pointer; align-self: flex-start; }
.dshv-check input { flex: none; width: 15px; height: 15px; margin: 3.5px 0 0; accent-color: var(--dshv-accent); cursor: pointer; }
.dshv-check input:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: 2px; }
.dshv-form-notes { display: flex; flex-direction: column; gap: 6px; margin-top: -6px; }
.dshv-form-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshv-form-foot .dshv-spacer { flex: 1 1 auto; }
.dshv-form-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dshv-bad-text); }

/* ---------- log ---------- */
.dshv-log { display: flex; flex-direction: column; gap: 8px; }
.dshv-log-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
.dshv-log-head .dshv-hint { text-align: right; }
.dshv-log-body {
  max-height: 280px; min-height: 96px; overflow-y: auto; padding: 12px 14px; border-radius: 16px; background: var(--dshv-fill);
  font-family: var(--dshv-mono); font-size: 12px; line-height: 19px;
}
.dshv-log-body:focus-visible { outline: 2px solid var(--dshv-accent); outline-offset: 2px; }
.dshv-log-body[data-empty="true"] { display: flex; align-items: center; justify-content: center; }
.dshv-log-line { display: flex; gap: 12px; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
.dshv-log-time { flex: none; color: var(--dshv-text-3); font-variant-numeric: tabular-nums; }
.dshv-log-line[data-level="out"] { color: var(--dshv-text-2); }
.dshv-log-line[data-level="warn"] { color: var(--dshv-warn-text); }
.dshv-log-line[data-level="error"] { color: var(--dshv-bad-text); }
.dshv-log-empty { color: var(--dshv-text-3); font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif); font-size: 13px; line-height: 20px; }

/* ---------- responsive ---------- */
@container dshv-root (max-width: 760px) {
  .dshv-page { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .dshv-rail { max-height: 220px; }
  .dshv-rail-head { padding-top: 14px; }
  .dshv-rail-empty { padding: 12px 14px; }
  .dshv-rail-foot { padding-bottom: 10px; }
  .dshv-head { padding-top: 24px; }
}
@container dshv-main (max-width: 640px) {
  .dshv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshv-card { padding: 20px; }
  .dshv-form { padding: 20px; }
}
@container dshv-main (max-width: 560px) {
  .dshv-col { padding-bottom: 32px; }
  .dshv-card-top { flex-wrap: wrap; }
  .dshv-card-actions { width: 100%; flex-wrap: wrap; }
  .dshv-grid, .dshv-grid[data-cols="2"] { grid-template-columns: minmax(0, 1fr); }
  .dshv-log-head .dshv-hint { text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  .dshv-btn, .dshv-input, .dshv-profile, .dshv-new, .dshv-seg button { transition: none; }
  .dshv-card[data-tone="connecting"] .dshv-orb::before { animation: none; }
}
`

/** Install the stylesheet once per document; a no-op without a DOM. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-client-ui-vpn'
  tag.dataset['pluginCss'] = STYLE_KEY
  tag.textContent = VPN_CSS
  document.head.appendChild(tag)
}
