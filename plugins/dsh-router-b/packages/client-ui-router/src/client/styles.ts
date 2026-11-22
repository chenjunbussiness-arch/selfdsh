/**
 * Panel stylesheet and board tokens, DeepSeek style (docs/UI-STYLE.md).
 *
 * - one accent (#4d6bfe); state colours only on dots, badges and notices;
 * - separation by tone and spacing, never by 1px rules: cards sit on `fill`,
 *   floating layers get a 0.5px shadow outline plus a soft shadow;
 * - every colour is a `--dsw-alias-*` host token with the light-theme value as
 *   its fallback, so light/dark follow the shell and the standalone preview
 *   still renders;
 * - every class carries this plugin's prefix (`dshr-` for the panel tree,
 *   `dshrc-`/`dshws-`/`dshd-` for the board, workspace page and desk).
 *
 * Sizes follow the spec table: body 14/22, secondary 13–13.5, captions 12–12.5,
 * page title 24/32, card title 17/26; radii 24 (big card), 14–16 (card, stat,
 * notice), 12 (rows, inputs) and 999 (buttons, chips); buttons 38 (small 30),
 * inputs 40, status dots 8, transitions 0.15s.
 *
 * The stylesheet is delivered as text and installed by `installStyles()` rather
 * than imported as CSS: the Web bundle is compiled outside Vite's graph, and a
 * runtime `<style>` tag keeps the browser and preview builds identical.
 */

/** Attribute this plugin's style tag carries, also used to stay idempotent. */
const STYLE_KEY = 'dsh-client-ui-router/RouterPanel.css'

/**
 * Roots that carry the `--dshr-*` variables. The header entry button and the
 * redirect placeholder render outside the panel, so they declare them too.
 */
const DSHR_ROOTS = '.dshr-panel, .dshr-page, .dshr-wr, .dshr-redirect, .dshr-entry'

/** Panel stylesheet text. */
export const ROUTER_CSS = `
${DSHR_ROOTS} {
  --dshr-accent: #4d6bfe;
  --dshr-accent-soft: color-mix(in srgb, var(--dshr-accent) 11%, transparent);
  --dshr-text: var(--dsw-alias-label-primary, #0f1115);
  --dshr-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshr-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshr-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshr-base: var(--dsw-alias-bg-base, #fff);
  --dshr-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshr-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshr-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshr-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshr-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshr-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshr-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshr-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --dshr-on-accent: var(--dsw-static-white, #fff);
  --dshr-float: 0 0 0 0.5px var(--dshr-line), 0 4px 18px rgba(15, 17, 21, 0.06);
  /* Legacy names, kept so nothing that still reads them breaks. */
  --dshr-busy: var(--dshr-accent);
  --dshr-radius-sm: 12px;
  --dshr-radius-md: 14px;
  --dshr-radius-lg: 24px;
  --dshr-rail-w: 272px;
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}

.dshr-panel {
  container-type: inline-size;
  display: flex;
  box-sizing: border-box;
  min-height: 0;
  height: 100%;
  background: var(--dshr-base);
  color: var(--dshr-text);
  font-size: 14px;
  line-height: 22px;
  text-align: left;
}
.dshr-panel *, .dshr-panel *::before, .dshr-panel *::after,
.dshr-wr *, .dshr-wr *::before, .dshr-wr *::after { box-sizing: border-box; }
.dshr-panel button, .dshr-panel input, .dshr-panel textarea,
.dshr-wr button, .dshr-wr textarea { font: inherit; color: inherit; }

.dshr-panel [data-tone="busy"] { --dshr-tone: var(--dshr-accent); }
.dshr-panel [data-tone="warn"] { --dshr-tone: var(--dshr-warn); }
.dshr-panel [data-tone="ok"] { --dshr-tone: var(--dshr-ok); }
.dshr-panel [data-tone="bad"] { --dshr-tone: var(--dshr-bad); }

.dshr-fill { flex: 1 1 auto; min-width: 0; }
.dshr-sep { color: var(--dshr-text-3); }
.dshr-mono { font-family: var(--dshr-mono); font-size: 12px; }
.dshr-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- scroll surfaces ---------- */

.dshr-scroll, .dshr-rail-scroll, .dshr-todos { overscroll-behavior: contain; scrollbar-width: thin; }
.dshr-scroll::-webkit-scrollbar, .dshr-rail-scroll::-webkit-scrollbar, .dshr-todos::-webkit-scrollbar { width: 8px; height: 8px; }
.dshr-scroll::-webkit-scrollbar-thumb, .dshr-rail-scroll::-webkit-scrollbar-thumb, .dshr-todos::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: content-box;
  background-color: var(--dsw-alias-scrollbar-bg-l1, rgba(15, 17, 21, 0.14));
}
.dshr-scroll::-webkit-scrollbar-track, .dshr-rail-scroll::-webkit-scrollbar-track, .dshr-todos::-webkit-scrollbar-track { background: transparent; }

/* ---------- buttons ---------- */

.dshr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dshr-hover); color: var(--dshr-text);
  font-size: 13.5px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.dshr-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dshr-text) 10%, transparent); }
.dshr-btn:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshr-btn[data-tone="primary"], .dshr-btn[data-tone="ok"] { background: var(--dshr-accent); color: var(--dshr-on-accent); }
.dshr-btn[data-tone="primary"]:hover:not(:disabled), .dshr-btn[data-tone="ok"]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dshr-accent) 88%, var(--dshr-text));
}
.dshr-btn[data-tone="bad"] { background: color-mix(in srgb, var(--dshr-bad) 12%, transparent); color: var(--dshr-bad); }
.dshr-btn[data-tone="bad"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dshr-bad) 20%, transparent); }
.dshr-btn[data-size="xs"] { height: 30px; padding: 0 14px; font-size: 12.5px; }

/* Round icon button; the "new demand" one grows a label when there is room. */
.dshr-icon-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-width: 30px; height: 30px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: var(--dshr-text-2);
  font-size: 15px; line-height: 1; cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.dshr-icon-btn:hover:not(:disabled) { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-icon-btn:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-icon-btn:disabled { opacity: 0.45; cursor: default; }
.dshr-icon-btn[data-open="plus"] { font-size: 18px; }
.dshr-icon-btn[data-open="plus"][aria-expanded="true"] { background: var(--dshr-accent-soft); color: var(--dshr-accent); }
.dshr-btn-label { display: none; font-size: 13px; font-weight: 500; }

/* ---------- badges, chips, dots ---------- */

.dshr-badge {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 16%, transparent); color: var(--dshr-text-2);
  font-size: 11.5px; line-height: 18px; font-variant-numeric: tabular-nums;
}
.dshr-badge[data-tone] {
  background: color-mix(in srgb, var(--dshr-tone) 16%, transparent);
  color: color-mix(in srgb, var(--dshr-tone) 80%, var(--dshr-text));
}

.dshr-chip {
  flex: none; display: inline-flex; align-items: center;
  height: 26px; padding: 0 10px; border-radius: 999px;
  background: var(--dshr-base); color: var(--dshr-text-2);
  font-size: 12.5px; line-height: 18px; white-space: nowrap;
}
.dshr-chip[data-tone] {
  background: color-mix(in srgb, var(--dshr-tone) 12%, var(--dshr-base));
  color: color-mix(in srgb, var(--dshr-tone) 80%, var(--dshr-text));
}
.dshr-task-row .dshr-chip { height: 22px; padding: 0 8px; background: var(--dshr-fill-2); font-size: 12px; }

.dshr-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dshr-idle); }
.dshr-dot[data-presence="online"] { background: var(--dshr-ok); }
.dshr-dot[data-presence="busy"] { background: var(--dshr-accent); }
.dshr-dot[data-presence="offline"] { background: var(--dshr-text-3); }
/* A released worker holds no machine: a hollow dot says so. */
.dshr-dot[data-presence="released"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dshr-text-3); }

/* ---------- project rail ---------- */

.dshr-rail { display: none; flex-direction: column; min-width: 0; min-height: 0; background: var(--dshr-fill); }
.dshr-panel[data-rail="open"] .dshr-rail { display: flex; flex: 1 1 auto; }
.dshr-panel[data-rail="open"] .dshr-main { display: none; }
/* A closed rail stays in the DOM but out of layout, tab order and a11y tree. */
.dshr-rail[hidden] { display: none !important; }

.dshr-rail-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 22px 12px 8px 22px; }
.dshr-rail-title { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dshr-text-3); white-space: nowrap; }
.dshr-rail-count { font-size: 12px; line-height: 18px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }

.dshr-rail-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px; padding: 0 10px 12px;
}

.dshr-project-all {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 40px; padding: 0 10px;
  border: 0; border-radius: 12px; background: transparent; color: var(--dshr-text-2);
  font-size: 13.5px; line-height: 20px; text-align: left; cursor: pointer;
  transition: background 0.15s;
}
.dshr-project-all:hover { background: var(--dshr-hover); }
.dshr-project-all:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }
.dshr-project-all[data-on="true"] { background: var(--dshr-accent-soft); color: var(--dshr-accent); font-weight: 600; }
.dshr-project-all > .dshr-project-name { flex: 1 1 auto; }
.dshr-caret { flex: none; width: 10px; font-size: 10px; line-height: 1; color: var(--dshr-text-3); }
.dshr-project-all[data-on="true"] > .dshr-caret { color: currentColor; }

.dshr-projects { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dshr-project { min-width: 0; }
.dshr-project-row { display: flex; align-items: center; gap: 4px; border-radius: 12px; transition: background 0.15s; }
.dshr-project-row:hover { background: var(--dshr-hover); }
.dshr-project[data-on="true"] > .dshr-project-row { background: var(--dshr-accent-soft); }

.dshr-project-main {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px;
  padding: 9px 4px 9px 10px; border: 0; border-radius: 12px;
  background: transparent; color: var(--dshr-text); text-align: left; cursor: pointer;
}
.dshr-project-main:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }
.dshr-project-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshr-project-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13.5px; line-height: 20px; font-weight: 500;
}
.dshr-project[data-on="true"] .dshr-project-name { color: var(--dshr-accent); font-weight: 600; }
.dshr-project-count { flex: none; font-size: 12px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-project-sub {
  display: block; min-width: 0; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 17px; color: var(--dshr-text-3);
}
.dshr-project-off {
  flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px;
  background: var(--dshr-fill-2); color: var(--dshr-text-3); font-size: 11.5px; white-space: nowrap;
}
/* A partition the router does not dispatch into reads muted, not struck out. */
.dshr-project[data-off="true"] .dshr-project-name { color: var(--dshr-text-3); font-weight: 400; }

.dshr-switch {
  flex: none; position: relative; width: 30px; height: 18px; margin-right: 8px; padding: 0;
  border: 0; border-radius: 999px; background: color-mix(in srgb, var(--dshr-text-3) 30%, transparent);
  cursor: pointer; transition: background 0.15s, opacity 0.15s;
}
.dshr-switch[data-on="true"] { background: var(--dshr-accent); }
.dshr-switch[data-wired="false"] { opacity: 0.5; }
.dshr-switch:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dshr-on-accent); box-shadow: 0 1px 2px rgba(15, 17, 21, 0.2);
  transition: transform 0.15s;
}
.dshr-switch[data-on="true"] > .dshr-switch-knob { transform: translateX(12px); }

.dshr-workers { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px 10px 28px; }
.dshr-worker {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px; padding: 0 10px;
  border-radius: 999px; background: var(--dshr-base); color: var(--dshr-text-2); font-size: 12.5px;
}
.dshr-worker > .dshr-worker-name { white-space: nowrap; }
.dshr-worker > .dshr-worker-what {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--dshr-mono); font-size: 11.5px; color: var(--dshr-text-3);
}
.dshr-worker[data-presence="released"] { color: var(--dshr-text-3); background: transparent; }
.dshr-worker[data-presence="released"] > .dshr-worker-what { font-family: inherit; }
.dshr-worker[data-presence="offline"] { opacity: 0.6; }

.dshr-rail-new {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; margin-top: 4px; padding: 0 10px;
  border: 0; border-radius: 12px; background: transparent; color: var(--dshr-accent);
  font-size: 13.5px; font-weight: 500; text-align: left; cursor: pointer; transition: background 0.15s;
}
.dshr-rail-new:hover { background: var(--dshr-accent-soft); }
.dshr-rail-new:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }
.dshr-rail-new > span:first-child { font-size: 16px; line-height: 1; }

.dshr-create { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 4px; }

/* ---------- API key block ---------- */

.dshr-keys { flex: none; display: flex; flex-direction: column; gap: 2px; padding: 12px 10px 16px; }
.dshr-rail-label {
  display: flex; align-items: center; gap: 6px; padding: 0 12px 6px;
  font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dshr-text-3);
}
.dshr-key-block { display: flex; flex-direction: column; gap: 6px; }
.dshr-key {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 34px; padding: 6px 12px;
  border: 0; border-radius: 12px; background: transparent; color: var(--dshr-text-2); text-align: left;
}
button.dshr-key { cursor: pointer; transition: background 0.15s; }
button.dshr-key:hover { background: var(--dshr-hover); }
button.dshr-key:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }
.dshr-key-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 1.5px var(--dshr-text-3); }
.dshr-key-dot[data-on="true"] { background: var(--dshr-ok); box-shadow: none; }
.dshr-key-ref {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--dshr-mono); font-size: 12px; line-height: 18px; color: var(--dshr-text-2);
}
.dshr-key-state { flex: none; font-size: 12px; line-height: 18px; color: var(--dshr-text-3); }
.dshr-key-state[data-on="true"] { color: var(--dshr-text-2); }
.dshr-key-form { display: flex; flex-direction: column; gap: 8px; padding: 2px 12px 6px; }
.dshr-key-actions { display: flex; align-items: center; gap: 8px; }
.dshr-key-empty, .dshr-key-where { padding: 2px 12px; font-size: 12px; line-height: 18px; color: var(--dshr-text-3); }
.dshr-key-where { padding-top: 6px; }
.dshr-key-error { padding: 0 12px; font-size: 12px; line-height: 18px; color: var(--dshr-bad); overflow-wrap: anywhere; }
.dshr-key-ok { padding: 0 12px; font-size: 12px; line-height: 18px; color: color-mix(in srgb, var(--dshr-ok) 75%, var(--dshr-text)); }

.dshr-rail-note {
  flex: none; margin: 0 12px 12px; padding: 10px 12px; border-radius: 14px;
  background: var(--dshr-base); color: var(--dshr-text-2); font-size: 12.5px; line-height: 18px;
}

/* ---------- task column ---------- */

.dshr-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--dshr-base); }
.dshr-main-bare { padding: 24px; gap: 12px; }

.dshr-main-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 18px 12px 2px 20px; }
.dshr-main-title { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; letter-spacing: 0; white-space: nowrap; }
.dshr-main-sub {
  display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 20px 12px;
  font-size: 12px; line-height: 18px; color: var(--dshr-text-3);
}
.dshr-stamp { flex: none; font-variant-numeric: tabular-nums; }
.dshr-origin {
  flex: none; display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-warn) 16%, transparent);
  color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text));
  font-size: 12px; font-weight: 500;
}
.dshr-origin[data-tone="bad"] { background: color-mix(in srgb, var(--dshr-bad) 12%, transparent); color: var(--dshr-bad); }

.dshr-notice {
  display: flex; align-items: flex-start; gap: 8px; margin: 4px 16px 8px; padding: 12px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--dshr-text-3) 8%, var(--dshr-base)); color: var(--dshr-text);
  font-size: 13px; line-height: 20px; overflow-wrap: anywhere;
}
.dshr-notice[data-tone="bad"] { background: color-mix(in srgb, var(--dshr-bad) 9%, var(--dshr-base)); }

/* Rail toggle: one chip with glyph, label and count; filtered = accent. */
.dshr-rail-ctl {
  flex: none; display: inline-flex; align-items: center; min-width: 0; max-width: 100%; height: 30px; margin-left: 8px;
  border-radius: 999px; background: var(--dshr-fill-2); color: var(--dshr-text-2);
  transition: background 0.15s, color 0.15s;
}
.dshr-rail-ctl:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-rail-ctl:has(.dshr-rail-btn[aria-expanded="true"]),
.dshr-rail-ctl[data-filtered="true"] { background: var(--dshr-accent-soft); color: var(--dshr-accent); }
.dshr-rail-btn {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 12px 0 10px;
  border: 0; border-radius: 999px; background: transparent; color: inherit;
  font-size: 13px; font-weight: 500; line-height: 1; cursor: pointer;
}
.dshr-rail-ctl[data-filtered="true"] .dshr-rail-btn { padding-right: 4px; }
.dshr-rail-btn:focus-visible, .dshr-rail-clear:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-rail-icon { flex: none; display: block; }
.dshr-rail-btn-label { white-space: nowrap; }
.dshr-rail-ctl .dshr-ellipsis { max-width: 22ch; }
.dshr-rail-btn-count { font-size: 12px; font-variant-numeric: tabular-nums; opacity: 0.75; }
.dshr-rail-clear {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-right: 4px;
  padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.dshr-rail-clear:hover { background: color-mix(in srgb, var(--dshr-accent) 18%, transparent); }

/* ---------- composer ---------- */

.dshr-drawer { flex: none; padding: 4px 16px 8px; }
.dshr-hero { flex: none; }
.dshr-composer {
  display: flex; flex-direction: column; gap: 6px; padding: 12px 12px 10px 16px; border-radius: 24px;
  background: var(--dshr-base); box-shadow: var(--dshr-float); transition: box-shadow 0.15s;
}
.dshr-composer:focus-within { box-shadow: 0 0 0 1.5px var(--dshr-accent), 0 4px 18px rgba(15, 17, 21, 0.06); }
/* The label names the field for assistive tech; the placeholder says it on screen. */
.dshr-composer > .dshr-label {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
.dshr-label { font-size: 12.5px; font-weight: 500; color: var(--dshr-text-2); }

.dshr-input {
  width: 100%; min-height: 40px; padding: 8px 12px; border: 0; border-radius: 12px;
  background: var(--dshr-fill); color: var(--dshr-text); font-size: 14px; line-height: 22px;
  outline: none; transition: box-shadow 0.15s;
}
.dshr-input:focus { box-shadow: 0 0 0 1.5px var(--dshr-accent); }
.dshr-input::placeholder { color: var(--dshr-text-3); }
textarea.dshr-input { resize: vertical; }
.dshr-rail .dshr-input { background: var(--dshr-base); }
.dshr-key-input { font-family: var(--dshr-mono); font-size: 13px; }
.dshr-reject-input { flex: 1 1 auto; min-width: 0; height: 40px; background: var(--dshr-base); }
.dshr-composer > .dshr-input {
  min-height: 44px; max-height: 200px; padding: 0; border-radius: 0; background: transparent;
  font-size: 14px; line-height: 22px; resize: none;
}
.dshr-composer > .dshr-input:focus { box-shadow: none; }

.dshr-composer-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshr-composer-foot > .dshr-hint {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; line-height: 18px; color: var(--dshr-text-3);
}
.dshr-send {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0;
  border: 0; border-radius: 50%; background: var(--dshr-accent); color: var(--dshr-on-accent); cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.dshr-send:hover:not(:disabled) { background: color-mix(in srgb, var(--dshr-accent) 88%, var(--dshr-text)); }
.dshr-send:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-send:disabled { background: color-mix(in srgb, var(--dshr-text-3) 35%, transparent); cursor: not-allowed; }
.dshr-send[data-busy="true"] { opacity: 0.6; }

/* ---------- tabs: segmented control ---------- */

.dshr-tabs {
  flex: none; align-self: flex-start; display: inline-flex; gap: 2px; max-width: calc(100% - 32px);
  margin: 4px 16px 4px 20px; padding: 3px; border-radius: 999px; background: var(--dshr-fill);
  overflow-x: auto; scrollbar-width: none;
}
.dshr-tabs::-webkit-scrollbar { display: none; }
.dshr-tab {
  flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px;
  border: 0; border-radius: 999px; background: transparent; color: var(--dshr-text-2);
  font-size: 13px; line-height: 18px; white-space: nowrap; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.dshr-tab:hover { color: var(--dshr-text); }
.dshr-tab:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }
.dshr-tab[aria-selected="true"] {
  background: var(--dshr-base); color: var(--dshr-accent); font-weight: 600;
  box-shadow: 0 1px 3px rgba(15, 17, 21, 0.12);
}
.dshr-tab-count { font-size: 12px; font-weight: 500; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-tab[aria-selected="true"] .dshr-tab-count { color: color-mix(in srgb, var(--dshr-accent) 70%, transparent); }
.dshr-tab[data-tone="warn"][data-has="true"] .dshr-tab-count { color: var(--dshr-warn); font-weight: 600; }

/* ---------- sections ---------- */

.dshr-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px 32px; }
.dshr-section { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding-top: 12px; }
/* The hidden attribute must beat the display above: closed tabs are out of the
   accessibility tree, not merely invisible. */
.dshr-section[hidden] { display: none; }
.dshr-section-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding: 4px 12px 6px; }
.dshr-section-title { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dshr-text-3); white-space: nowrap; }
.dshr-section[data-tone="warn"] > .dshr-section-head > .dshr-section-title { color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text)); }
.dshr-section[data-tone="bad"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-bad); }
.dshr-section-count { font-size: 12px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }

.dshr-empty { padding: 24px 12px; font-size: 13px; line-height: 20px; color: var(--dshr-text-3); text-align: center; }
.dshr-main-bare > .dshr-empty { padding-top: 48px; }

/* ---------- task row ---------- */

.dshr-task { display: flex; flex-direction: column; min-width: 0; border-radius: 12px; transition: background 0.15s; }
.dshr-task:not([data-open="true"]):hover { background: var(--dshr-hover); }
.dshr-task[data-open="true"] { background: var(--dshr-fill); }

.dshr-task-row {
  display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px;
  border: 0; border-radius: 12px; background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.dshr-task-row:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: -2px; }

/* State ring: the one place state is carried by shape as well as colour. */
.dshr-ring { flex: none; position: relative; width: 14px; height: 14px; border: 1.5px solid var(--dshr-text-3); border-radius: 50%; }
.dshr-ring[data-state="queued"] { border-color: color-mix(in srgb, var(--dshr-text-3) 70%, transparent); }
.dshr-ring[data-state="running"] { border-color: var(--dshr-accent); }
.dshr-ring[data-state="running"]::after { content: ""; position: absolute; inset: 2.5px; border-radius: 50%; background: var(--dshr-accent); }
.dshr-ring[data-state="reported"] { border-color: var(--dshr-warn); border-style: dashed; }
.dshr-ring[data-state="reported"]::after { content: ""; position: absolute; inset: 3.5px; border-radius: 50%; background: var(--dshr-warn); }
.dshr-ring[data-state="verified"] { border-color: var(--dshr-ok); background: var(--dshr-ok); }
.dshr-ring[data-state="verified"]::after {
  content: ""; position: absolute; left: 3.5px; top: 1px; width: 3.5px; height: 7px;
  border: solid var(--dshr-on-accent); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.dshr-ring[data-state="rejected"] { border-color: var(--dshr-bad); }
.dshr-ring[data-state="rejected"]::before, .dshr-ring[data-state="rejected"]::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 1.5px; border-radius: 1px; background: var(--dshr-bad);
}
.dshr-ring[data-state="rejected"]::before { transform: translate(-50%, -50%) rotate(45deg); }
.dshr-ring[data-state="rejected"]::after { transform: translate(-50%, -50%) rotate(-45deg); }

.dshr-task-title {
  flex: 1 1 auto; min-width: 0; font-size: 14px; line-height: 22px; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dshr-task[data-tone="ok"] > .dshr-task-row > .dshr-task-title { color: var(--dshr-text-2); }
.dshr-task[data-open="true"] > .dshr-task-row > .dshr-task-title { font-weight: 600; }

/* Partition, progress and age: wide layouts only (container query below). */
.dshr-task-aside { display: none; }
.dshr-task-prog { flex: none; font-family: var(--dshr-mono); font-size: 12px; line-height: 18px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }

/* ---------- task detail ---------- */

.dshr-task-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 0 16px 16px 38px; }
.dshr-task-body[hidden] { display: none; }
.dshr-task-body > .dshr-empty { padding: 0; text-align: left; font-size: 12.5px; }

.dshr-task-meta {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px; color: var(--dshr-text-3);
}

/* Checklist: a base-tone block on the open task's fill, like a stat cell. */
.dshr-todos {
  display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto;
  padding: 12px 14px; border-radius: 14px; background: var(--dshr-base);
}
.dshr-todo-head { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; font-size: 12px; line-height: 18px; color: var(--dshr-text-3); }
.dshr-progress {
  flex: 0 1 96px; min-width: 32px; height: 4px; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--dshr-text-3) 20%, transparent);
}
.dshr-progress > i { display: block; height: 100%; border-radius: 999px; background: var(--dshr-accent); }
.dshr-task[data-tone="ok"] .dshr-progress > i { background: var(--dshr-ok); }
.dshr-task[data-tone="warn"] .dshr-progress > i { background: var(--dshr-warn); }
.dshr-count { font-family: var(--dshr-mono); font-size: 12px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }

.dshr-todo { display: flex; align-items: flex-start; gap: 8px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dshr-text-2); }
.dshr-todo > .dshr-todo-text { min-width: 0; overflow-wrap: anywhere; }
.dshr-todo[data-status="completed"] > .dshr-todo-text { color: var(--dshr-text-3); }
.dshr-todo[data-status="in_progress"] > .dshr-todo-text { color: var(--dshr-text); font-weight: 500; }

/* Checklist box, drawn rather than typed: crisp at 13px in both themes. */
.dshr-mark { flex: none; position: relative; width: 14px; height: 14px; margin-top: 3px; border: 1.5px solid var(--dshr-text-3); border-radius: 4px; }
.dshr-todo[data-status="completed"] > .dshr-mark { border-color: var(--dshr-ok); background: var(--dshr-ok); }
.dshr-todo[data-status="completed"] > .dshr-mark::after {
  content: ""; position: absolute; left: 3.5px; top: 0.5px; width: 3.5px; height: 7px;
  border: solid var(--dshr-on-accent); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.dshr-todo[data-status="in_progress"] > .dshr-mark { border-color: var(--dshr-accent); border-radius: 50%; }
.dshr-todo[data-status="in_progress"] > .dshr-mark::after { content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--dshr-accent); }

.dshr-current { display: flex; gap: 6px; min-width: 0; font-size: 12.5px; line-height: 18px; color: var(--dshr-accent); }
.dshr-current > .dshr-current-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- task actions + artifacts ---------- */

.dshr-task-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshr-reject-note {
  padding: 10px 14px; border-radius: 14px; background: color-mix(in srgb, var(--dshr-bad) 9%, var(--dshr-base));
  color: var(--dshr-text); font-size: 13px; line-height: 20px; overflow-wrap: anywhere;
}
.dshr-artifacts { display: flex; flex-wrap: wrap; gap: 6px; }
.dshr-artifact {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px; padding: 0 10px;
  border: 0; border-radius: 999px; background: var(--dshr-base); color: var(--dshr-text-2);
  font-size: 12.5px; cursor: pointer; text-decoration: none; transition: background 0.15s;
}
.dshr-artifact:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-artifact:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-artifact > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- wide: rail and list side by side, row asides shown ---------- */

@container (min-width: 760px) {
  .dshr-panel[data-rail="open"] .dshr-rail { flex: 0 0 var(--dshr-rail-w); width: var(--dshr-rail-w); }
  .dshr-panel[data-rail="open"] .dshr-main { display: flex; }
  .dshr-rail-close { display: none; }
}
@container (min-width: 560px) {
  .dshr-task-aside {
    flex: none; display: grid; grid-template-columns: 120px 44px 72px; align-items: center; column-gap: 16px;
    font-size: 12px; line-height: 18px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums;
  }
  .dshr-task-part { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dshr-mono); }
  .dshr-task-prog { text-align: right; }
  .dshr-task-time { text-align: right; white-space: nowrap; }
  .dshr-task-title { -webkit-line-clamp: 1; }
  .dshr-btn-label { display: inline; }
  .dshr-icon-btn[data-warroom="open"], .dshr-icon-btn[data-open="plus"] { padding: 0 14px; font-size: 14px; }
  .dshr-icon-btn[data-open="plus"] { background: var(--dshr-accent); color: var(--dshr-on-accent); }
  .dshr-icon-btn[data-open="plus"]:hover:not(:disabled),
  .dshr-icon-btn[data-open="plus"][aria-expanded="true"] { background: color-mix(in srgb, var(--dshr-accent) 88%, var(--dshr-text)); color: var(--dshr-on-accent); }
}

/* ---------- the Routing page ---------- */

/* The page owns the whole main area; the task column centres a reading column
   (max 880px) by padding, so the rail stays flush left. */
.dshr-page { height: 100%; min-height: 0; display: flex; overflow: hidden; background: var(--dshr-base); }
.dshr-page > .dshr-panel { width: 100%; min-height: 0; height: 100%; }
.dshr-panel[data-variant="page"] {
  --dshr-gutter: max(24px, calc((100% - 880px) / 2 + 24px));
}
.dshr-panel[data-variant="page"] .dshr-main-head,
.dshr-panel[data-variant="page"] .dshr-main-sub,
.dshr-panel[data-variant="page"] .dshr-hero,
.dshr-panel[data-variant="page"] .dshr-scroll { padding-left: var(--dshr-gutter); padding-right: var(--dshr-gutter); }
.dshr-panel[data-variant="page"] .dshr-notice { margin-left: var(--dshr-gutter); margin-right: var(--dshr-gutter); }
.dshr-panel[data-variant="page"] .dshr-main-head { padding-top: 36px; padding-bottom: 4px; }
.dshr-panel[data-variant="page"] .dshr-main-title { font-size: 24px; line-height: 32px; }
.dshr-panel[data-variant="page"] .dshr-main-sub { padding-bottom: 20px; font-size: 13px; }
.dshr-panel[data-variant="page"] .dshr-composer { padding: 14px 14px 10px 18px; }
.dshr-panel[data-variant="page"] .dshr-composer > .dshr-input { min-height: 52px; font-size: 15px; line-height: 24px; }
.dshr-panel[data-variant="page"] .dshr-tabs { margin: 24px 0 4px var(--dshr-gutter); max-width: calc(100% - 2 * var(--dshr-gutter)); }
.dshr-panel[data-variant="page"] .dshr-scroll { padding-top: 4px; padding-bottom: 48px; }
.dshr-panel[data-variant="page"] .dshr-section-head { padding-top: 12px; }
.dshr-panel[data-variant="page"] .dshr-task-row { min-height: 46px; }
.dshr-panel[data-variant="page"] .dshr-rail-ctl { margin-left: 12px; }

@container (max-width: 559px) {
  .dshr-rail-ctl { max-width: 58%; }
  .dshr-panel[data-variant="page"] .dshr-main-head { padding-top: 24px; flex-wrap: wrap; row-gap: 8px; }
}

/* ---------- war room ---------- */

.dshr-wr {
  container-type: inline-size; height: 100%; overflow-y: auto; background: var(--dshr-base); color: var(--dshr-text);
  font-size: 14px; line-height: 22px;
}
.dshr-wr-col { width: 100%; max-width: 880px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }
.dshr-wr-head { padding-top: 36px; display: flex; flex-direction: column; gap: 4px; }
.dshr-wr-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dshr-wr-sub { margin: 0; font-size: 13px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-wr-mock { margin: 0; font-size: 12.5px; color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text)); }

.dshr-wr-composer {
  display: flex; flex-direction: column; gap: 8px; padding: 14px 14px 10px 18px; border-radius: 24px;
  background: var(--dshr-base); box-shadow: var(--dshr-float); transition: box-shadow 0.15s;
}
.dshr-wr-composer:focus-within { box-shadow: 0 0 0 1.5px var(--dshr-accent), 0 4px 18px rgba(15, 17, 21, 0.06); }
.dshr-wr-input {
  width: 100%; min-height: 72px; padding: 0; border: 0; background: transparent; color: var(--dshr-text);
  font-size: 15px; line-height: 24px; resize: vertical; outline: none;
}
.dshr-wr-input::placeholder { color: var(--dshr-text-3); }
.dshr-wr-foot { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; }
.dshr-wr-error { font-size: 12.5px; color: var(--dshr-bad); overflow-wrap: anywhere; }
.dshr-wr-note { font-size: 12.5px; color: var(--dshr-text-3); }

.dshr-wr-block { display: flex; flex-direction: column; gap: 8px; }
.dshr-wr-block-title { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-wr-list { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 16px; background: var(--dshr-fill); }
.dshr-wr-row {
  display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 44px; padding: 10px 12px;
  border-radius: 12px; font-size: 13.5px; transition: background 0.15s;
}
.dshr-wr-row:hover { background: var(--dshr-hover); }
.dshr-wr-row[data-off="true"] { opacity: 0.45; }
.dshr-wr-main { flex: 1 1 auto; min-width: 0; }
.dshr-wr-name { font-size: 14px; line-height: 22px; font-weight: 600; }
.dshr-wr-path { font-family: var(--dshr-mono); font-size: 12px; line-height: 18px; color: var(--dshr-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-wr-counts { flex: none; display: flex; gap: 12px; font-size: 12.5px; color: var(--dshr-text-2); font-variant-numeric: tabular-nums; }
.dshr-wr-quiet { color: var(--dshr-text-3); }
.dshr-wr-pending { color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text)); font-weight: 500; }
.dshr-wr-tag {
  flex: none; display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px;
  background: var(--dshr-base); color: var(--dshr-text-2); font-size: 12px;
}
.dshr-wr-tag[data-tone="warn"] { background: color-mix(in srgb, var(--dshr-warn) 14%, var(--dshr-base)); color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text)); }
.dshr-wr-tag[data-tone="busy"] { background: var(--dshr-accent-soft); color: var(--dshr-accent); }
.dshr-wr-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-wr-meta { flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; text-align: right; }
.dshr-wr-empty { padding: 20px 12px; font-size: 13px; color: var(--dshr-text-3); text-align: center; }
@container (max-width: 559px) {
  .dshr-wr-row { flex-wrap: wrap; }
  .dshr-wr-meta { max-width: 100%; text-align: left; }
}

/* ---------- redirect placeholder + header entry ---------- */

.dshr-redirect {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%;
  color: var(--dshr-text-3); font-size: 13px;
}
.dshr-redirect-text { margin: 0; }

.dshr-entry {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; border-radius: 999px;
  background: transparent; color: var(--dshr-text-2); font-size: 13px; font-weight: 500; line-height: 1;
  white-space: nowrap; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.dshr-entry:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-entry:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-entry-count {
  min-width: 18px; height: 18px; padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 16%, transparent); color: var(--dshr-text-2);
  font-size: 11.5px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums;
}
.dshr-entry-count[data-tone="warn"] {
  background: color-mix(in srgb, var(--dshr-warn) 16%, transparent);
  color: color-mix(in srgb, var(--dshr-warn) 80%, var(--dshr-text)); font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .dshr-btn, .dshr-icon-btn, .dshr-tab, .dshr-task, .dshr-switch, .dshr-switch-knob, .dshr-send, .dshr-rail-ctl,
  .dshr-project-all, .dshr-project-row, .dshr-rail-new, .dshr-key, .dshr-input, .dshr-composer, .dshr-artifact,
  .dshr-wr-composer, .dshr-wr-row, .dshr-entry { transition: none; }
}
`

/**
 * Install the panel stylesheet once per document.
 *
 * Idempotent by `data-plugin-css`, matching how shipped Client bundles install
 * their own styles, and a no-op without a DOM (server-side render, tests).
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-client-ui-router'
  tag.dataset.pluginCss = STYLE_KEY
  tag.textContent = ROUTER_CSS
  document.head.appendChild(tag)
}

/** Board states that own a colour; queued and stale reuse `cancelled` (neutral). */
export type BoardTone = 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

/**
 * Board state palette, three tiers per tone: `dot` (status dot), `text` (status
 * word) and `bg` (a pale wash for banners and tags, never a large fill). Each is
 * derived from the host's state token and the board's own text/base, so it
 * follows light and dark without a second table.
 */
const BOARD_STATES: Readonly<Record<BoardTone, { dot: string; text: string; bg: string }>> = {
  running: {
    dot: 'var(--c-accent)',
    text: 'color-mix(in srgb, var(--c-accent) 82%, var(--c-text))',
    bg: 'color-mix(in srgb, var(--c-accent) 9%, var(--c-bg))',
  },
  blocked: {
    dot: 'var(--c-warn)',
    text: 'color-mix(in srgb, var(--c-warn) 72%, var(--c-text))',
    bg: 'color-mix(in srgb, var(--c-warn) 12%, var(--c-bg))',
  },
  done: {
    dot: 'var(--c-ok)',
    text: 'color-mix(in srgb, var(--c-ok) 70%, var(--c-text))',
    bg: 'color-mix(in srgb, var(--c-ok) 9%, var(--c-bg))',
  },
  failed: {
    dot: 'var(--c-bad)',
    text: 'color-mix(in srgb, var(--c-bad) 85%, var(--c-text))',
    bg: 'color-mix(in srgb, var(--c-bad) 9%, var(--c-bg))',
  },
  cancelled: { dot: 'var(--c-text3)', text: 'var(--c-text2)', bg: 'var(--c-surface)' },
}

const BOARD_TONES: readonly BoardTone[] = ['running', 'blocked', 'done', 'failed', 'cancelled']

/** Declarations: `--st-<tone>-<tier>`, theme-independent. */
function boardVars(): string {
  const lines: string[] = []
  for (const tone of BOARD_TONES) {
    for (const tier of ['dot', 'text', 'bg'] as const) lines.push(`--st-${tone}-${tier}:${BOARD_STATES[tone][tier]}`)
  }
  return lines.join(';')
}

/**
 * Neutral surfaces, type and depth of one theme, as CSS values. Each colour is
 * the host token with that theme's default behind it: the light defaults are the
 * spec's (docs/UI-STYLE.md §2), the dark ones are DeepSeek's dark shell.
 *
 * Mapping (board name → spec role): bg/raised → base, surface/code → fill,
 * pill/lineSoft → fill-2, text/text2/meta → text/text-2/text-3, line/ghostLine
 * → line, hover → hover.
 */
export const UI_THEME = {
  light: {
    bg: 'var(--dsw-alias-bg-base, #fff)',
    surface: 'var(--dsw-alias-bg-layer-1, #f9fafb)',
    raised: 'var(--dsw-alias-bg-base, #fff)',
    text: 'var(--dsw-alias-label-primary, #0f1115)',
    text2: 'var(--dsw-alias-label-secondary, #61666b)',
    meta: 'var(--dsw-alias-label-tertiary, #81858c)',
    id: 'var(--dsw-alias-label-tertiary, #81858c)',
    line: 'var(--dsw-alias-border-l, #e1e5ee)',
    lineSoft: 'var(--dsw-alias-bg-layer-2, #f5f7fa)',
    pill: 'var(--dsw-alias-bg-layer-2, #f5f7fa)',
    hover: 'var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05))',
    press: 'var(--dsw-alias-interactive-bg-press, rgba(15, 17, 21, 0.09))',
    ghostLine: 'var(--dsw-alias-border-l, #e1e5ee)',
    accent: '#4d6bfe',
    accentHover: 'color-mix(in srgb, var(--c-accent) 88%, var(--dsw-alias-label-primary, #0f1115))',
    onAccent: 'var(--dsw-static-white, #fff)',
    ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
    warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    bad: 'var(--dsw-alias-state-error-primary, #ec1313)',
    idle: 'var(--dsw-alias-state-idle-primary, #d4d4d4)',
    shadow1: '0 0 0 0.5px var(--c-line), 0 4px 18px rgba(15, 17, 21, 0.06)',
    shadow2: '0 0 0 0.5px var(--c-line), 0 12px 32px rgba(15, 17, 21, 0.12)',
    scrim: 'var(--dsw-alias-bg-mask, rgba(15, 17, 21, 0.28))',
    code: 'var(--dsw-alias-bg-layer-1, #f9fafb)',
  },
  dark: {
    bg: 'var(--dsw-alias-bg-base, #161618)',
    surface: 'var(--dsw-alias-bg-layer-1, #1e1f22)',
    raised: 'var(--dsw-alias-bg-layer-1, #1e1f22)',
    text: 'var(--dsw-alias-label-primary, #f5f6f7)',
    text2: 'var(--dsw-alias-label-secondary, #b6babf)',
    meta: 'var(--dsw-alias-label-tertiary, #8b8f96)',
    id: 'var(--dsw-alias-label-tertiary, #8b8f96)',
    line: 'var(--dsw-alias-border-l, #2f3136)',
    lineSoft: 'var(--dsw-alias-bg-layer-2, #26272b)',
    pill: 'var(--dsw-alias-bg-layer-2, #26272b)',
    hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06))',
    press: 'var(--dsw-alias-interactive-bg-press, rgba(255, 255, 255, 0.1))',
    ghostLine: 'var(--dsw-alias-border-l, #2f3136)',
    accent: '#4d6bfe',
    accentHover: 'color-mix(in srgb, var(--c-accent) 85%, var(--dsw-alias-label-primary, #f5f6f7))',
    onAccent: 'var(--dsw-static-white, #fff)',
    ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
    warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    bad: 'var(--dsw-alias-state-error-primary, #f25a5a)',
    idle: 'var(--dsw-alias-state-idle-primary, #5c5f66)',
    shadow1: '0 0 0 0.5px var(--c-line), 0 4px 18px rgba(0, 0, 0, 0.32)',
    shadow2: '0 0 0 0.5px var(--c-line), 0 12px 32px rgba(0, 0, 0, 0.5)',
    scrim: 'var(--dsw-alias-bg-mask, rgba(0, 0, 0, 0.5))',
    code: 'var(--dsw-alias-bg-layer-1, #1e1f22)',
  },
} as const

/** Replace every `var(--dsw-…, fallback)` by its fallback (innermost first). */
function defaultsOnly(value: string): string {
  const token = /var\(--dsw-[\w-]+,\s*((?:[^()]|\([^()]*\))*)\)/g
  let previous = ''
  let current = value
  while (current !== previous) {
    previous = current
    current = current.replace(token, (_, fallback: string) => fallback.trim())
  }
  return current
}

/**
 * Declarations for one theme. `follow` keeps the host tokens (panel theme equals
 * the host's); otherwise only the defaults are written, so a panel switched to
 * 白天/黑夜 against the host still paints the theme it was asked for.
 */
function uiVars(theme: 'light' | 'dark', follow: boolean): string {
  const u = UI_THEME[theme]
  const v = (value: string): string => (follow ? value : defaultsOnly(value))
  return [
    `--c-bg:${v(u.bg)}`, `--c-surface:${v(u.surface)}`, `--c-raised:${v(u.raised)}`, `--c-text:${v(u.text)}`, `--c-text2:${v(u.text2)}`,
    `--c-meta:${v(u.meta)}`, `--c-text3:${v(u.meta)}`, `--c-id:${v(u.id)}`, `--c-line:${v(u.line)}`, `--c-line-soft:${v(u.lineSoft)}`,
    `--c-pill:${v(u.pill)}`, `--c-hover:${v(u.hover)}`, `--c-press:${v(u.press)}`, `--c-ghost-line:${v(u.ghostLine)}`,
    `--c-accent:${u.accent}`, `--c-accent-soft:color-mix(in srgb, var(--c-accent) 11%, transparent)`,
    `--c-accent-hover:${v(u.accentHover)}`, `--c-on-accent:${v(u.onAccent)}`, `--c-focus:var(--c-accent)`,
    `--c-ok:${v(u.ok)}`, `--c-warn:${v(u.warn)}`, `--c-bad:${v(u.bad)}`, `--c-idle:${v(u.idle)}`,
    `--shadow-1:${u.shadow1}`, `--shadow-2:${u.shadow2}`, `--c-scrim:${v(u.scrim)}`, `--c-code:${v(u.code)}`,
    `color-scheme:${theme}`,
  ].join(';')
}

/** Spacing, sizes, radii, motion and type: the spec's numbers on a 4px grid. */
const BOARD_SCALE = [
  '--sp-1:4px', '--sp-2:8px', '--sp-3:12px', '--sp-4:16px', '--sp-5:24px',
  '--h-ctl:30px', '--h-btn:38px', '--h-input:40px', '--r-ctl:12px', '--r-card:16px', '--r-big:24px', '--r-pill:999px',
  '--h-row:44px', '--h-sub:36px', '--ease:cubic-bezier(.25,.1,.25,1)', '--dur:.15s',
  '--f-ui:var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif)',
  '--f-mono:var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)',
].join(';')

/**
 * Board design tokens as CSS, shared by the board, the workspace page and the
 * desk. The root's `data-theme` comes from theme.tsx (跟随系统 / 白天 / 黑夜):
 *
 * - `.dshrc` / `.dshrc[data-theme="dark"]`: the theme's defaults, for a panel
 *   forced against the host theme;
 * - the two `body` rules: panel theme equals host theme (`body[data-ds-dark-theme]`
 *   is the host's dark switch), so the host's `--dsw-alias-*` tokens win.
 */
export const BOARD_TOKENS_CSS = `
.dshrc{${uiVars('light', false)};${boardVars()};${BOARD_SCALE};font-family:var(--f-ui);-webkit-font-smoothing:antialiased}
.dshrc[data-theme="dark"]{${uiVars('dark', false)}}
body:not([data-ds-dark-theme]) .dshrc:not([data-theme="dark"]){${uiVars('light', true)}}
body[data-ds-dark-theme] .dshrc[data-theme="dark"]{${uiVars('dark', true)}}
`
