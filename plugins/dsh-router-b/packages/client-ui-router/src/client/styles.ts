/**
 * Panel stylesheet.
 *
 * Rules followed (see `dsh-agent-preset/skills/dsh-doc/references/practices.md`):
 * - colour comes only from `--dsw-alias-*` tokens, so light/dark follow the host;
 * - every class carries this plugin's `dshr-` prefix — nothing is shared with,
 *   or can collide with, host class names;
 * - density (12/12.5/13px type, 18/20px line-height, 4/6/8/10/12px gaps) is
 *   copied from the host's own management pages, because a panel docked beside
 *   the conversation must read as one application.
 *
 * Shape, in one sentence: a roster you can act on in a 212px rail, a task list
 * that reads as rows rather than cards, and no ornament that does not carry
 * state. The only filled surfaces are the hovered row, the selected project and
 * an opened task — everything else is hairlines and type.
 *
 * Fallbacks are the host's own light-theme values, so the panel still renders in
 * a page that does not inject tokens (the standalone preview).
 *
 * The stylesheet is delivered as text and installed by `installStyles()` rather
 * than imported as CSS: the Web bundle is compiled outside Vite's graph, and a
 * runtime `<style>` tag keeps the browser and preview builds identical.
 */

/** Attribute this plugin's style tag carries, also used to stay idempotent. */
const STYLE_KEY = 'dsh-client-ui-router/RouterPanel.css'

/** Panel stylesheet text. */
export const ROUTER_CSS = `
.dshr-panel {
  --dshr-text: var(--dsw-alias-label-primary, #0f1115);
  --dshr-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dshr-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dshr-line: var(--dsw-alias-border-l, #e1e5ee);
  --dshr-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dshr-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dshr-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dshr-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dshr-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshr-busy: var(--dsw-alias-state-business-primary, #4176e6);
  --dshr-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dshr-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dshr-radius-sm: var(--dsw-radius-sm, 6px);
  --dshr-radius-md: var(--dsw-radius-md, 8px);
  --dshr-radius-lg: var(--dsw-radius-lg, 12px);
  --dshr-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --dshr-rail-w: 212px;

  container-type: inline-size;
  display: flex;
  box-sizing: border-box;
  min-height: 0;
  height: 100%;
  color: var(--dshr-text);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
}

.dshr-panel *,
.dshr-panel *::before,
.dshr-panel *::after { box-sizing: border-box; }

.dshr-fill { flex: 1 1 auto; min-width: 0; }
.dshr-sep { opacity: 0.5; }
.dshr-mono { font-family: var(--dshr-mono); font-size: 11px; }
.dshr-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- scroll surfaces ---------- */

.dshr-scroll,
.dshr-rail-scroll,
.dshr-todos { overscroll-behavior: contain; }

.dshr-scroll::-webkit-scrollbar,
.dshr-rail-scroll::-webkit-scrollbar,
.dshr-todos::-webkit-scrollbar { width: 8px; height: 8px; }
.dshr-scroll::-webkit-scrollbar-thumb,
.dshr-rail-scroll::-webkit-scrollbar-thumb,
.dshr-todos::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: content-box;
  background-color: var(--dsw-alias-scrollbar-bg-l1, rgba(15, 17, 21, 0.14));
}
.dshr-scroll::-webkit-scrollbar-thumb:hover,
.dshr-rail-scroll::-webkit-scrollbar-thumb:hover,
.dshr-todos::-webkit-scrollbar-thumb:hover {
  background-color: var(--dsw-alias-scrollbar-hover-l1, rgba(15, 17, 21, 0.28));
}
.dshr-scroll::-webkit-scrollbar-track,
.dshr-rail-scroll::-webkit-scrollbar-track,
.dshr-todos::-webkit-scrollbar-track { background: transparent; }

/* ---------- buttons ---------- */

.dshr-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dshr-btn:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-btn:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-btn[disabled] { opacity: 0.55; cursor: default; }
.dshr-btn[data-tone="primary"] {
  border-color: transparent;
  background: var(--dshr-busy);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 500;
}
.dshr-btn[data-tone="primary"]:hover { background: color-mix(in srgb, var(--dshr-busy) 88%, #000); }
.dshr-btn[data-tone="ok"] { border-color: color-mix(in srgb, var(--dshr-ok) 45%, transparent); color: var(--dshr-ok); }
.dshr-btn[data-tone="ok"]:hover { background: color-mix(in srgb, var(--dshr-ok) 12%, transparent); }
.dshr-btn[data-tone="bad"] { border-color: color-mix(in srgb, var(--dshr-bad) 40%, transparent); color: var(--dshr-bad); }
.dshr-btn[data-tone="bad"]:hover { background: color-mix(in srgb, var(--dshr-bad) 10%, transparent); }
.dshr-btn[data-size="xs"] { height: 20px; padding: 0 6px; font-size: 11.5px; line-height: 16px; }

.dshr-icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dshr-icon-btn:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-icon-btn:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-icon-btn[data-open="plus"] { font-size: 16px; }
.dshr-icon-btn[data-open="plus"][aria-expanded="true"],
.dshr-icon-btn[data-open="plus"]:hover { border-color: var(--dshr-line); background: var(--dshr-fill); }

/* ---------- badges ---------- */

.dshr-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 16%, transparent);
  color: var(--dshr-text-2);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshr-badge[data-tone="warn"] { background: color-mix(in srgb, var(--dshr-warn) 16%, transparent); color: var(--dshr-warn); }
.dshr-badge[data-tone="ok"] { background: color-mix(in srgb, var(--dshr-ok) 16%, transparent); color: var(--dshr-ok); }
.dshr-badge[data-tone="busy"] { background: color-mix(in srgb, var(--dshr-busy) 14%, transparent); color: var(--dshr-busy); }
.dshr-badge[data-tone="bad"] { background: color-mix(in srgb, var(--dshr-bad) 12%, transparent); color: var(--dshr-bad); }

/* ---------- presence dots ---------- */

.dshr-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dshr-idle);
}
.dshr-dot[data-presence="online"] { background: var(--dshr-ok); }
.dshr-dot[data-presence="busy"] { background: var(--dshr-busy); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-busy) 20%, transparent); }
.dshr-dot[data-presence="offline"] { background: var(--dshr-text-3); }
.dshr-dot[data-presence="released"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dshr-text-3); }

/* ---------- rail ---------- */

.dshr-rail {
  display: none;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: transparent;
}

.dshr-panel[data-rail="open"] .dshr-rail { display: flex; flex: 1 1 auto; }
.dshr-panel[data-rail="open"] .dshr-main { display: none; }

/* A closed rail stays in the DOM but out of layout, tab order and a11y tree. */
.dshr-rail[hidden] { display: none !important; }

.dshr-rail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px 6px 12px;
  min-width: 0;
}
.dshr-rail-title {
  font-size: 11.5px;
  line-height: 16px;
  letter-spacing: 0.04em;
  color: var(--dshr-text-3);
  white-space: nowrap;
}
.dshr-rail-count {
  color: var(--dshr-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dshr-rail-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.dshr-project-all {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dshr-project-all:hover { background: var(--dshr-hover); }
.dshr-project-all[data-on="true"] { background: var(--dshr-fill); color: var(--dshr-text); font-weight: 500; }
.dshr-project-all > .dshr-project-name { flex: 1 1 auto; }
.dshr-caret {
  flex: none;
  width: 8px;
  color: var(--dshr-text-3);
  font-size: 9px;
  line-height: 1;
}
.dshr-project-all[data-on="true"] > .dshr-caret { color: var(--dshr-text); }

.dshr-projects {
  list-style: none;
  margin: 1px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dshr-project { min-width: 0; }

.dshr-project-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--dshr-radius-sm);
}
.dshr-project-row:hover { background: var(--dshr-hover); }
.dshr-project[data-on="true"] > .dshr-project-row { background: var(--dshr-fill); }

.dshr-project-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 2px 4px 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshr-project-main:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: -2px; }

.dshr-project-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dshr-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
}
.dshr-project[data-on="true"] .dshr-project-name { color: var(--dshr-text); }
.dshr-project-count {
  flex: none;
  color: var(--dshr-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dshr-project-sub {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 15px;
}
.dshr-project-off {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dshr-text-3) 14%, transparent);
  color: var(--dshr-text-3);
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
}
/* A partition the router does not dispatch into reads muted, not struck out. */
.dshr-project[data-off="true"] .dshr-project-name { color: var(--dshr-text-3); font-weight: 400; }

.dshr-switch {
  flex: none;
  position: relative;
  width: 24px;
  height: 14px;
  margin-right: 4px;
  padding: 0;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshr-text-3) 18%, transparent);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dshr-switch[data-on="true"] { background: var(--dshr-ok); border-color: transparent; }
.dshr-switch[data-wired="false"] { opacity: 0.55; }
.dshr-switch:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-switch-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transition: transform 120ms ease;
}
.dshr-switch[data-on="true"] > .dshr-switch-knob { transform: translateX(10px); }

.dshr-workers {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 0 6px 5px 22px;
}
.dshr-worker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 5px;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
  background: transparent;
}
.dshr-worker > .dshr-worker-name { white-space: nowrap; }
.dshr-worker > .dshr-worker-what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-family: var(--dshr-mono);
  font-size: 10.5px;
}
/* A released worker holds no machine: dashed border + muted text says so. */
.dshr-worker[data-presence="released"] { border-style: dashed; color: var(--dshr-text-3); }
.dshr-worker[data-presence="released"] > .dshr-worker-what { font-family: inherit; }
.dshr-worker[data-presence="offline"] { opacity: 0.6; }

.dshr-rail-new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  margin-top: 2px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-3);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  text-align: left;
}
.dshr-rail-new:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-rail-new > span:first-child { font-size: 13px; line-height: 1; }

.dshr-create {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 2px 2px;
}
.dshr-create-input { min-height: 0; height: 24px; padding: 0 6px; font-size: 12px; }

/* ---------- API key block ---------- */

.dshr-keys {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--dshr-line);
}
.dshr-rail-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px 3px;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.04em;
}

.dshr-key-block { display: flex; flex-direction: column; gap: 3px; }

.dshr-key {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 1px 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  text-align: left;
}
button.dshr-key { cursor: pointer; }
button.dshr-key:hover { background: var(--dshr-hover); }
button.dshr-key:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }

.dshr-key-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--dshr-text-3);
}
.dshr-key-dot[data-on="true"] { background: var(--dshr-ok); box-shadow: none; }

.dshr-key-ref {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--dshr-text-2);
}
.dshr-key-state { flex: none; font-size: 10.5px; line-height: 16px; color: var(--dshr-text-3); }
.dshr-key-state[data-on="true"] { color: var(--dshr-text-2); }

.dshr-key-empty,
.dshr-key-where {
  padding: 1px 2px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-key-where { padding-top: 3px; }
.dshr-key-input { min-height: 0; height: 24px; padding: 0 6px; font-size: 11.5px; }
.dshr-key-actions { display: flex; gap: 4px; }
.dshr-key-error { padding: 0 2px; color: var(--dshr-bad); font-size: 10.5px; line-height: 15px; overflow-wrap: anywhere; }
.dshr-key-ok { padding: 0 2px; color: var(--dshr-ok); font-size: 10.5px; line-height: 15px; }

.dshr-rail-note {
  flex: none;
  margin: 0 10px 10px;
  padding: 5px 6px;
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill-2);
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}

/* ---------- task column ---------- */

.dshr-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.dshr-main-bare { padding: 12px; gap: 8px; }

.dshr-main-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 0 12px;
  min-width: 0;
}
.dshr-main-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.dshr-main-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 10px 0 12px;
  color: var(--dshr-text-3);
  font-size: 11px;
  line-height: 16px;
  min-width: 0;
}
.dshr-stamp { flex: none; font-family: var(--dshr-mono); font-size: 10.5px; }
.dshr-origin {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--dshr-line);
  border-radius: 4px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-origin[data-tone="bad"] { color: var(--dshr-bad); border-color: color-mix(in srgb, var(--dshr-bad) 45%, transparent); }

.dshr-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 10px 0 12px;
  padding: 5px 8px;
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill-2);
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}
.dshr-notice[data-tone="bad"] { color: var(--dshr-bad); }

/* ---------- composer drawer ---------- */

.dshr-drawer { flex: none; border-bottom: 1px solid var(--dshr-line); }
.dshr-composer {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px 8px 12px;
}
.dshr-label { color: var(--dshr-text-3); font-size: 11px; line-height: 16px; }

.dshr-input {
  width: 100%;
  min-height: 48px;
  max-height: 132px;
  padding: 5px 7px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: var(--dshr-fill);
  color: var(--dshr-text);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
}
.dshr-input::placeholder { color: var(--dshr-text-3); }
.dshr-input:focus-visible { outline: none; border-color: var(--dshr-busy); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-busy) 18%, transparent); }

.dshr-composer-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshr-composer-foot > .dshr-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

/* ---------- tabs ---------- */

.dshr-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 8px 10px 0 12px;
}
.dshr-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
}
.dshr-tab:hover { background: var(--dshr-hover); }
.dshr-tab:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: 1px; }
.dshr-tab[aria-selected="true"] {
  border-color: var(--dshr-line);
  background: var(--dshr-fill);
  color: var(--dshr-text);
  font-weight: 500;
}
.dshr-tab-count {
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshr-tab[data-tone="warn"][data-has="true"] .dshr-tab-count { color: var(--dshr-warn); background: color-mix(in srgb, var(--dshr-warn) 16%, transparent); }
.dshr-tab[data-tone="ok"][data-has="true"] .dshr-tab-count { color: var(--dshr-ok); background: color-mix(in srgb, var(--dshr-ok) 16%, transparent); }
.dshr-tab[data-has="false"] .dshr-tab-count { opacity: 0.45; }

.dshr-tab-hint {
  padding: 2px 10px 0 12px;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

/* ---------- sections ---------- */

.dshr-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 16px 10px;
}

.dshr-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding-top: 8px;
}
.dshr-section + .dshr-section { margin-top: 6px; }
/* The hidden attribute must beat the display above: closed tabs are out of the
   accessibility tree, not merely invisible. */
.dshr-section[hidden] { display: none; }

.dshr-section-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 4px 3px;
  border-bottom: 1px solid var(--dshr-line);
  min-width: 0;
  flex-wrap: nowrap;
}
.dshr-section-title {
  font-size: 11.5px;
  font-weight: 600;
  line-height: 16px;
  color: var(--dshr-text-2);
  white-space: nowrap;
}
.dshr-section[data-tone="warn"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-warn); }
.dshr-section[data-tone="bad"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-bad); }
.dshr-section-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}

.dshr-empty {
  padding: 8px 4px;
  color: var(--dshr-text-3);
  font-size: 11.5px;
  line-height: 16px;
}

/* ---------- task row ---------- */

.dshr-task {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--dshr-radius-sm);
}
.dshr-task[data-open="true"] { background: var(--dshr-fill); }

.dshr-task-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshr-task-row:hover { background: var(--dshr-hover); }
.dshr-task[data-open="true"] > .dshr-task-row:hover { background: transparent; }
.dshr-task-row:focus-visible { outline: 2px solid var(--dshr-busy); outline-offset: -2px; }

/* State ring: the only place state is carried by shape as well as colour. */
.dshr-ring {
  flex: none;
  position: relative;
  width: 13px;
  height: 13px;
  margin-top: 3px;
  border: 1.5px solid var(--dshr-text-3);
  border-radius: 50%;
}
.dshr-ring[data-state="queued"] { border-color: color-mix(in srgb, var(--dshr-text-3) 70%, transparent); }
.dshr-ring[data-state="running"] { border-color: var(--dshr-busy); }
.dshr-ring[data-state="running"]::after {
  content: "";
  position: absolute;
  inset: 2.5px;
  border-radius: 50%;
  background: var(--dshr-busy);
}
.dshr-ring[data-state="reported"] { border-color: var(--dshr-warn); border-style: dashed; }
.dshr-ring[data-state="reported"]::after {
  content: "";
  position: absolute;
  inset: 3.5px;
  border-radius: 50%;
  background: var(--dshr-warn);
  opacity: 0.7;
}
.dshr-ring[data-state="verified"] {
  border-color: var(--dshr-ok);
  background: var(--dshr-ok);
}
.dshr-ring[data-state="verified"]::after {
  content: "";
  position: absolute;
  left: 3.5px;
  top: 1px;
  width: 3px;
  height: 6px;
  border: solid var(--dsw-alias-label-primary-foreground, #fff);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.dshr-ring[data-state="rejected"] { border-color: var(--dshr-bad); }
.dshr-ring[data-state="rejected"]::before,
.dshr-ring[data-state="rejected"]::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--dshr-bad);
}
.dshr-ring[data-state="rejected"]::before { transform: translate(-50%, -50%) rotate(45deg); }
.dshr-ring[data-state="rejected"]::after { transform: translate(-50%, -50%) rotate(-45deg); }

.dshr-task-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 18px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dshr-task[data-tone="warn"] > .dshr-task-row > .dshr-task-title { color: var(--dshr-text); }
.dshr-task[data-tone="ok"] > .dshr-task-row > .dshr-task-title { color: var(--dshr-text-2); }

.dshr-task-prog {
  flex: none;
  color: var(--dshr-text-3);
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* ---------- task detail ---------- */

.dshr-task-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 8px 8px 26px;
  min-width: 0;
  /* A checklist is read as a column, not as a line across a 760px panel. */
  max-width: 620px;
}
.dshr-task-body[hidden] { display: none; }

.dshr-task-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  color: var(--dshr-text-3);
  font-size: 10.5px;
  line-height: 15px;
}
.dshr-chip {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--dshr-text-2);
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dshr-chip[data-tone="busy"] { color: var(--dshr-busy); }
.dshr-chip[data-tone="warn"] { color: var(--dshr-warn); }
.dshr-chip[data-tone="ok"] { color: var(--dshr-ok); }
.dshr-chip[data-tone="bad"] { color: var(--dshr-bad); }

/* ---------- checklist ---------- */

.dshr-todos {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 168px;
  overflow-y: auto;
  padding: 3px 0 1px;
  border-top: 1px dashed var(--dshr-line);
}

.dshr-todo-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--dshr-text-2);
  font-size: 11px;
  line-height: 15px;
}
.dshr-todo-head > .dshr-progress {
  flex: 0 1 72px;
  height: 3px;
  min-width: 24px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--dshr-text-3) 22%, transparent);
  overflow: hidden;
}
.dshr-progress > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--dshr-busy);
}
.dshr-task[data-tone="ok"] .dshr-progress > i { background: var(--dshr-ok); }
.dshr-task[data-tone="warn"] .dshr-progress > i { background: var(--dshr-warn); }
.dshr-todo-head > .dshr-count {
  font-variant-numeric: tabular-nums;
  font-family: var(--dshr-mono);
  font-size: 10.5px;
  color: var(--dshr-text-3);
}

.dshr-todo {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 1px 0;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dshr-text-2);
  min-width: 0;
}
.dshr-todo > .dshr-todo-text { min-width: 0; overflow-wrap: anywhere; }
.dshr-todo[data-status="completed"] > .dshr-todo-text { color: var(--dshr-text-3); }
.dshr-todo[data-status="in_progress"] > .dshr-todo-text { color: var(--dshr-text); font-weight: 500; }

/* Checklist box, drawn rather than typed: crisp at 12px in both themes. */
.dshr-mark {
  flex: none;
  position: relative;
  width: 11px;
  height: 11px;
  margin-top: 2px;
  border: 1px solid var(--dshr-text-3);
  border-radius: 3px;
}
.dshr-todo[data-status="completed"] > .dshr-mark { border-color: var(--dshr-ok); background: var(--dshr-ok); }
.dshr-todo[data-status="completed"] > .dshr-mark::after {
  content: "";
  position: absolute;
  left: 2.5px;
  top: 0;
  width: 3px;
  height: 6px;
  border: solid var(--dsw-alias-label-primary-foreground, #fff);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.dshr-todo[data-status="in_progress"] > .dshr-mark { border-color: var(--dshr-busy); border-radius: 50%; }
.dshr-todo[data-status="in_progress"] > .dshr-mark::after {
  content: "";
  position: absolute;
  inset: 1.5px;
  border-radius: 50%;
  background: var(--dshr-busy);
}

.dshr-current {
  display: flex;
  gap: 5px;
  padding: 1px 0;
  color: var(--dshr-busy);
  font-size: 11px;
  line-height: 15px;
  min-width: 0;
}
.dshr-current > .dshr-current-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- task actions + artifacts ---------- */

.dshr-task-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.dshr-reject-note {
  padding: 4px 6px;
  border-radius: var(--dshr-radius-sm);
  background: color-mix(in srgb, var(--dshr-bad) 9%, transparent);
  color: var(--dshr-bad);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
}

.dshr-artifacts { display: flex; flex-wrap: wrap; gap: 4px; }
.dshr-artifact {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-sm);
  background: transparent;
  color: var(--dshr-text-2);
  font: inherit;
  font-size: 10.5px;
  line-height: 18px;
  cursor: pointer;
  text-decoration: none;
}
.dshr-artifact:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-artifact > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- wide: rail and list side by side ---------- */

@container (min-width: 660px) {
  /* Closed by default even when wide: only an open rail takes a column. */
  .dshr-panel[data-rail="open"] .dshr-rail {
    display: flex;
    flex: 0 0 var(--dshr-rail-w);
    width: var(--dshr-rail-w);
    border-right: 1px solid var(--dshr-line);
  }
  .dshr-panel[data-rail="open"] .dshr-main { display: flex; }
  .dshr-rail-close { display: none; }
  .dshr-main-head { padding: 12px 12px 0 14px; }
  .dshr-main-sub { padding: 1px 12px 0 14px; }
  .dshr-tabs { padding: 10px 12px 0 14px; }
  .dshr-tab-hint { padding: 2px 12px 0 14px; }
  .dshr-scroll { padding: 6px 12px 20px 12px; }
  .dshr-task-row { padding: 5px 8px; }
  .dshr-task-body { padding: 2px 10px 9px 28px; }
  .dshr-rail-head { padding: 12px 8px 6px 12px; }
}

/* ---------- the Routing page ---------- */

/* The board promoted to a page. At window width the rail plus task column would
   stretch into a very long line, so the page centres a column and lets the
   panel's own container queries choose the layout inside it. */
.dshr-page {
  height: 100%;
  min-height: 0;
  display: flex;
  justify-content: center;
  padding: 20px 24px;
  overflow: hidden;
}
.dshr-page > .dshr-panel {
  width: 100%;
  max-width: 880px;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--dshr-line);
  border-radius: var(--dshr-radius-lg);
  background: var(--dshr-fill);
  overflow: hidden;
}

/* ---------- header, tabs, section heads (2026-11-19 pass, Duet-like) ---------- */

/* The head is an app bar: title and actions, one hairline, nothing between. */
.dshr-main-head {
  padding: 10px 10px 8px 10px;
  border-bottom: 1px solid var(--dshr-line);
}
.dshr-main-title { font-size: 14px; font-weight: 600; }
.dshr-main-sub { padding: 6px 12px 0; font-size: 10.5px; gap: 6px; }

/* Plain text tabs, selected one filled. A track behind four words draws a box
   that carries no information and eats the width of the words inside it. */
.dshr-tabs {
  gap: 4px;
  margin: 8px 8px 0;
  padding: 0;
  background: transparent;
  flex-wrap: nowrap;
}
.dshr-tab {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dshr-radius-sm);
  color: var(--dshr-text-2);
  font-weight: 400;
}
.dshr-tab:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-tab[aria-selected="true"] {
  background: var(--dshr-fill);
  border: none;
  box-shadow: none;
  color: var(--dshr-text);
  font-weight: 500;
}
.dshr-tab-count {
  min-width: 0;
  padding: 0;
  background: none;
  border: none;
  color: var(--dshr-text-3);
  font-variant-numeric: tabular-nums;
}
.dshr-tab[aria-selected="true"] .dshr-tab-count { color: var(--dshr-text-2); }

/* A section head is a label, not a card header: name, count, nothing else. */
.dshr-section-head {
  align-items: baseline;
  gap: 6px;
  padding: 12px 12px 4px;
  border-bottom: none;
}
.dshr-section-title { font-size: 12.5px; font-weight: 500; color: var(--dshr-text-2); }
.dshr-section-count { font-size: 12.5px; color: var(--dshr-text-3); font-variant-numeric: tabular-nums; }
.dshr-section-head .dshr-badge { display: none; }

/* One row is one clickable line: icon, title, air. Detail lives behind the click. */
.dshr-task-row { min-height: 40px; padding: 8px 12px; }

/* The checklist is a block of its own under the meta line; without a gap the two
   read as one run-on sentence. */
.dshr-todo-head {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dshr-line);
}

/* Header actions are icon-sized: at 420px a text button next to a "+" read as
   two different weights of the same thing. */
.dshr-icon-btn[disabled] { opacity: 0.45; cursor: default; }
.dshr-stamp { font-variant-numeric: tabular-nums; }

/* A closed row is clickable, so it says so on hover; an open one already has a
   fill and must not change under the pointer. */
.dshr-task:not([data-open="true"]):hover { background: var(--dshr-hover); }

/* ---------- 2026-11-19 usability pass ---------- */

/* Row aside: partition, progress, age. Hidden in the docked Sidebar, shown as
   aligned columns once the panel is wide enough to read them in one line. */
.dshr-task-aside { display: none; }
.dshr-task-row { align-items: center; }
.dshr-ring { margin-top: 0; }
.dshr-btn-label { display: none; }

/* Tabs read as an underline strip on one hairline, not floating pills. */
.dshr-tabs {
  margin: 0;
  padding: 0 8px;
  gap: 0;
  border-bottom: 1px solid var(--dshr-line);
}
.dshr-tab {
  position: relative;
  height: 34px;
  padding: 0 10px;
  border-radius: 0;
  background: transparent;
}
.dshr-tab:hover { background: transparent; color: var(--dshr-text); }
.dshr-tab[aria-selected="true"] { background: transparent; }
.dshr-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--dshr-text);
}
.dshr-tab[data-tone="warn"][data-has="true"] .dshr-tab-count { color: var(--dshr-warn); background: none; font-weight: 600; }
.dshr-tab[data-tone="ok"][data-has="true"] .dshr-tab-count { background: none; }

.dshr-main-sub { padding: 8px 12px 6px; }
.dshr-section-head { padding: 14px 12px 6px; }
.dshr-section-title { font-weight: 600; }
.dshr-task-title { font-size: 13px; line-height: 20px; }
.dshr-task-row { min-height: 38px; padding: 8px 12px; gap: 10px; }
.dshr-task-body { padding: 0 12px 12px 35px; }
.dshr-task + .dshr-task { margin-top: 1px; }

@container (min-width: 660px) {
  .dshr-task-aside {
    flex: none;
    display: grid;
    grid-template-columns: 120px 44px 72px;
    align-items: center;
    column-gap: 16px;
    color: var(--dshr-text-3);
    font-size: 12px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
  }
  .dshr-task-part {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dshr-mono);
    font-size: 11.5px;
  }
  .dshr-task-prog { text-align: right; font-size: 11.5px; line-height: 18px; }
  .dshr-task-time { text-align: right; white-space: nowrap; }
  .dshr-task-title { -webkit-line-clamp: 1; }

  /* The main action earns words when there is room for them. */
  .dshr-icon-btn[data-open="plus"] {
    width: auto;
    height: 28px;
    gap: 4px;
    padding: 0 10px;
    border: 1px solid transparent;
    background: var(--dshr-text);
    color: var(--dsw-alias-bg-base, #fff);
    font-size: 12.5px;
    font-weight: 500;
  }
  .dshr-icon-btn[data-open="plus"]:hover,
  .dshr-icon-btn[data-open="plus"][aria-expanded="true"] {
    background: color-mix(in srgb, var(--dshr-text) 85%, transparent);
    border-color: transparent;
  }
  .dshr-btn-label { display: inline; }
  .dshr-main-head { padding: 12px 16px 12px 16px; }
  .dshr-main-title { font-size: 15px; }
  .dshr-main-sub { padding: 8px 16px 6px; }
  .dshr-tabs { padding: 0 12px; }
  .dshr-scroll { padding: 4px 12px 24px; }
}

/* The page owns the whole main area: no floating card with dead margins. */
.dshr-page {
  padding: 0;
  justify-content: stretch;
  background: var(--dsw-alias-bg-base, #fff);
}
.dshr-page > .dshr-panel {
  max-width: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.dshr-page .dshr-rail {
  background: var(--dshr-fill);
}
.dshr-page .dshr-main {
  max-width: 1080px;
}
@container (min-width: 660px) {
  .dshr-page .dshr-rail { flex-basis: 240px; width: 240px; }
  .dshr-page .dshr-rail-head { padding: 16px 10px 8px 16px; }
  .dshr-page .dshr-rail-scroll { padding: 0 8px 10px; }
  .dshr-page .dshr-project-all { height: 32px; padding: 0 8px; }
  .dshr-page .dshr-project-main { padding: 6px 4px 6px 8px; }
}

/* ---------- send button (composer) ---------- */

.dshr-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--dshr-accent);
  color: #fff;
  cursor: pointer;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.dshr-send:hover { background: color-mix(in srgb, var(--dshr-accent) 88%, #000); }
.dshr-send:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
.dshr-send[disabled] { background: color-mix(in srgb, var(--dshr-text-3) 35%, transparent); cursor: default; }
.dshr-send[data-busy="true"] { opacity: 0.6; }

/* ==========================================================================
   DeepSeek-style pass (2026-11-19 b)
   Whole surface: one accent (DeepSeek blue), soft grey sidebar, rounded
   composer, list rows that read like a chat history list. No borders on
   containers; separation is tone and spacing.
   ========================================================================== */

.dshr-panel {
  --dshr-accent: #4d6bfe;
  --dshr-accent-soft: color-mix(in srgb, var(--dshr-accent) 10%, transparent);
  --dshr-busy: var(--dshr-accent);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
}

/* Docked panel: small refinements only. */
.dshr-task { border-radius: 10px; }
.dshr-task-row { border-radius: 10px; }
.dshr-task[data-open="true"] {
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 0 0 1px var(--dshr-line), 0 2px 8px rgba(15, 17, 21, 0.04);
}
.dshr-tab[aria-selected="true"]::after { background: var(--dshr-accent); }
.dshr-tab[aria-selected="true"] { color: var(--dshr-text); font-weight: 600; }
.dshr-section-title { font-size: 12px; font-weight: 500; color: var(--dshr-text-3); }
.dshr-section[data-tone="warn"] > .dshr-section-head > .dshr-section-title { color: var(--dshr-warn); }
.dshr-section-count { font-size: 12px; }
.dshr-composer {
  margin: 10px 10px;
  padding: 10px 10px 8px 12px;
  border: 1px solid var(--dshr-line);
  border-radius: 16px;
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 2px 10px rgba(15, 17, 21, 0.04);
}
.dshr-composer:focus-within { border-color: color-mix(in srgb, var(--dshr-accent) 55%, var(--dshr-line)); }
.dshr-composer > .dshr-label { display: none; }
.dshr-composer > .dshr-input {
  min-height: 44px;
  max-height: 200px;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 13.5px;
  line-height: 22px;
  resize: none;
}
.dshr-composer > .dshr-input:focus-visible { box-shadow: none; }
.dshr-drawer { border-bottom: 0; }

/* ---------- the Routing page ---------- */

.dshr-panel[data-variant="page"] {
  font-size: 14px;
  line-height: 22px;
}

/* Left rail: DeepSeek's history column. */
.dshr-panel[data-variant="page"] .dshr-rail {
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  border-right: 0;
}
.dshr-panel[data-variant="page"] .dshr-rail-head { padding: 20px 14px 10px 20px; }
.dshr-panel[data-variant="page"] .dshr-rail-title {
  font-size: 12px;
  letter-spacing: 0;
  color: var(--dshr-text-3);
}
.dshr-panel[data-variant="page"] .dshr-rail-scroll { padding: 0 10px 12px; }
.dshr-panel[data-variant="page"] .dshr-project-all,
.dshr-panel[data-variant="page"] .dshr-project-row { border-radius: 10px; }
.dshr-panel[data-variant="page"] .dshr-project-all { height: 38px; padding: 0 10px; font-size: 13.5px; }
.dshr-panel[data-variant="page"] .dshr-project-main { padding: 8px 6px 8px 10px; }
.dshr-panel[data-variant="page"] .dshr-project-name { font-size: 13.5px; line-height: 20px; }
.dshr-panel[data-variant="page"] .dshr-project-sub { font-size: 12px; line-height: 17px; }
.dshr-panel[data-variant="page"] .dshr-project-all[data-on="true"],
.dshr-panel[data-variant="page"] .dshr-project[data-on="true"] > .dshr-project-row {
  background: var(--dshr-accent-soft);
}
.dshr-panel[data-variant="page"] .dshr-project-all[data-on="true"] { color: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-project[data-on="true"] .dshr-project-name { color: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-switch[data-on="true"] { background: var(--dshr-accent); }
.dshr-panel[data-variant="page"] .dshr-rail-new { height: 38px; padding: 0 10px; border-radius: 10px; font-size: 13px; }
.dshr-panel[data-variant="page"] .dshr-keys { padding: 12px 20px 16px; border-top: 0; }

/* Main column: everything sits in one centred reading column, like the chat. */
.dshr-panel[data-variant="page"] .dshr-main {
  max-width: none;
  background: var(--dsw-alias-bg-base, #fff);
}
.dshr-panel[data-variant="page"] .dshr-main > :not(.dshr-scroll),
.dshr-panel[data-variant="page"] .dshr-scroll > * {
  width: 100%;
  max-width: 820px;
  margin-left: auto;
  margin-right: auto;
}
.dshr-panel[data-variant="page"] .dshr-main-head {
  padding: 40px 24px 4px;
  border-bottom: 0;
}
.dshr-panel[data-variant="page"] .dshr-main-title {
  font-size: 24px;
  line-height: 32px;
  font-weight: 600;
  letter-spacing: 0;
}
.dshr-panel[data-variant="page"] .dshr-main-sub {
  padding: 0 24px 16px;
  font-size: 13px;
  color: var(--dshr-text-3);
}
.dshr-panel[data-variant="page"] .dshr-stamp { font-family: inherit; font-size: 12px; }

/* The demand box is the page's main action: always open, chat-sized. */
.dshr-hero { flex: none; padding: 0 24px; }
.dshr-panel[data-variant="page"] .dshr-composer {
  margin: 0;
  padding: 14px 14px 10px 18px;
  border-radius: 24px;
  box-shadow: 0 0 0 0.5px var(--dshr-line), 0 4px 18px rgba(15, 17, 21, 0.06);
  border-color: transparent;
}
.dshr-panel[data-variant="page"] .dshr-composer:focus-within {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dshr-accent) 55%, transparent), 0 4px 18px rgba(77, 107, 254, 0.10);
}
.dshr-panel[data-variant="page"] .dshr-composer > .dshr-input {
  min-height: 52px;
  font-size: 15px;
  line-height: 24px;
}
.dshr-panel[data-variant="page"] .dshr-composer-foot > .dshr-hint { font-size: 12px; }

.dshr-panel[data-variant="page"] .dshr-tabs {
  margin-top: 28px;
  padding: 0 24px;
  gap: 6px;
  border-bottom: 0;
}
.dshr-panel[data-variant="page"] .dshr-tab {
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13.5px;
  color: var(--dshr-text-2);
}
.dshr-panel[data-variant="page"] .dshr-tab::after { display: none; }
.dshr-panel[data-variant="page"] .dshr-tab:hover { background: var(--dshr-hover); }
.dshr-panel[data-variant="page"] .dshr-tab[aria-selected="true"] {
  background: var(--dshr-accent-soft);
  color: var(--dshr-accent);
  font-weight: 600;
}
.dshr-panel[data-variant="page"] .dshr-tab[aria-selected="true"] .dshr-tab-count { color: var(--dshr-accent); }

.dshr-panel[data-variant="page"] .dshr-scroll { padding: 4px 0 48px; }
.dshr-panel[data-variant="page"] .dshr-scroll > .dshr-section { padding: 0 24px; }
.dshr-panel[data-variant="page"] .dshr-section-head { padding: 22px 12px 8px; }
.dshr-panel[data-variant="page"] .dshr-section-title { font-size: 12.5px; }
.dshr-panel[data-variant="page"] .dshr-empty { padding: 10px 12px; font-size: 13px; }

.dshr-panel[data-variant="page"] .dshr-task-row { min-height: 46px; padding: 11px 12px; gap: 12px; }
.dshr-panel[data-variant="page"] .dshr-task-title { font-size: 14px; line-height: 22px; }
.dshr-panel[data-variant="page"] .dshr-task-body { padding: 0 16px 16px 37px; max-width: none; }
.dshr-panel[data-variant="page"] .dshr-task-meta { font-size: 12px; line-height: 18px; }
.dshr-panel[data-variant="page"] .dshr-todo { font-size: 13px; line-height: 20px; }
.dshr-panel[data-variant="page"] .dshr-todos { max-height: 260px; }
.dshr-panel[data-variant="page"] .dshr-btn[data-size="xs"] { height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; }
.dshr-panel[data-variant="page"] .dshr-btn[data-tone="ok"] { background: var(--dshr-accent); border-color: transparent; color: #fff; }
.dshr-panel[data-variant="page"] .dshr-btn[data-tone="ok"]:hover { background: color-mix(in srgb, var(--dshr-accent) 88%, #000); }

@container (min-width: 660px) {
  .dshr-panel[data-variant="page"] .dshr-rail { flex-basis: 260px; width: 260px; border-right: 0; }
  .dshr-panel[data-variant="page"] .dshr-task-aside { grid-template-columns: 110px 40px 72px; font-size: 12.5px; }
  .dshr-panel[data-variant="page"] .dshr-main-head { padding: 40px 24px 4px; }
  .dshr-panel[data-variant="page"] .dshr-main-sub { padding: 0 24px 16px; }
  .dshr-panel[data-variant="page"] .dshr-tabs { padding: 0 24px; }
  .dshr-panel[data-variant="page"] .dshr-scroll { padding: 4px 0 48px; }
}

/* ---------- project rail toggle (task header) ---------- */

/* One pill: sidebar glyph, label, count. When a partition filter is on, the label
   becomes "Filtering: name" and a small x clears it, so a closed rail never
   leaves the user wondering why the list is short. */
.dshr-rail-ctl {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  height: 26px;
  margin-left: 6px;
  border: 1px solid var(--dshr-line);
  border-radius: 999px;
  background: transparent;
  color: var(--dshr-text-2);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.dshr-rail-ctl:hover { background: var(--dshr-hover); color: var(--dshr-text); }
.dshr-rail-ctl:has(.dshr-rail-btn[aria-expanded="true"]) {
  background: var(--dshr-accent-soft);
  border-color: color-mix(in srgb, var(--dshr-accent) 30%, transparent);
  color: var(--dshr-accent);
}
.dshr-rail-ctl[data-filtered="true"] {
  background: var(--dshr-accent-soft);
  border-color: color-mix(in srgb, var(--dshr-accent) 40%, transparent);
  color: var(--dshr-accent);
}
.dshr-rail-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 10px 0 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
.dshr-rail-ctl[data-filtered="true"] .dshr-rail-btn { padding-right: 4px; }
.dshr-rail-btn:focus-visible,
.dshr-rail-clear:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 1px; }
.dshr-rail-icon { flex: none; display: block; }
.dshr-rail-btn-label { white-space: nowrap; }
.dshr-rail-btn-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dshr-rail-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 3px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dshr-rail-clear:hover { background: color-mix(in srgb, var(--dshr-accent) 18%, transparent); }
.dshr-panel[data-variant="page"] .dshr-rail-ctl { height: 30px; margin-left: 12px; }
.dshr-panel[data-variant="page"] .dshr-rail-btn { font-size: 13px; }
.dshr-rail-ctl .dshr-ellipsis { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 659px) {
  .dshr-rail-ctl { max-width: 58%; }
  .dshr-panel[data-variant="page"] .dshr-main-head { padding: 24px 16px 4px; flex-wrap: wrap; row-gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  .dshr-btn, .dshr-tab, .dshr-switch, .dshr-switch-knob, .dshr-send, .dshr-rail-ctl { transition: none; }
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

/**
 * Task-board state palette: one hue per board status, three tiers each.
 *
 * - `dot`: the 6px status dot (≥3:1 against the panel background);
 * - `text`: the status word (≥4.5:1 against the panel background);
 * - `bg`: a pale wash for banners and tags, never a large saturated fill.
 *
 * Every value is a host theme token (`--dsw-static-*` / `--dsw-alias-*`) or a
 * fixed mix of two of them; `from` names the source so the palette can be traced
 * back to the theme. The values are literal hex rather than `color-mix()` so the
 * contrast numbers in the design notes describe exactly what the browser paints.
 */
export const BOARD_PALETTE = {
  light: {
    surface: {
      base: '#ffffff', hover: '#cad2db', press: '#bec5cd', line: 'rgba(0, 0, 0, 0.04)',
      // Ghost-button border: neutral-bluish-600 80% + neutral-bluish-500 (≥3:1 on base and on the error tint).
      ghostLine: '#858a91',
      // Secondary text: label-secondary 60% + label-tertiary (≥4.5:1).
      meta: '#6e7278',
      // Task id, the lowest-contrast text: neutral-bluish-600 50% + neutral-bluish-500 (≥3:1).
      id: '#8c9199',
    },
    running: {
      dot: { hex: '#0071e3', from: 'accent (light)' },
      text: { hex: '#0060c0', from: 'accent 85% + label-primary (≥4.5:1 on white)' },
      bg: { hex: '#eaf3fe', from: 'accent 8% on white' },
    },
    blocked: {
      dot: { hex: '#b0740e', from: 'state-warn-primary (amber-500) 70% + label-primary' },
      text: { hex: '#8e5f10', from: 'amber-500 55% + label-primary' },
      bg: { hex: '#fef5e7', from: 'amber-100' },
    },
    done: {
      dot: { hex: '#488c66', from: 'state-success-primary (green-500) 40% + label-secondary' },
      text: { hex: '#517e68', from: 'green-500 25% + label-secondary' },
      bg: { hex: '#ecf7f1', from: 'green-100 50% + neutral-bluish-75' },
    },
    failed: {
      dot: { hex: '#ec1313', from: 'state-error-primary (red-600)' },
      text: { hex: '#c01313', from: 'red-600 80% + label-primary' },
      bg: { hex: '#fef2f2', from: 'red-50' },
    },
    cancelled: {
      dot: { hex: '#81858c', from: 'label-tertiary (neutral-bluish-600)' },
      text: { hex: '#61666b', from: 'label-secondary (neutral-bluish-700)' },
      bg: { hex: '#f1f3f5', from: 'interactive-bg-hover-solid (neutral-bluish-75)' },
    },
  },
  dark: {
    surface: {
      base: '#151517', hover: '#43454a', press: '#4f5257', line: 'rgba(255, 255, 255, 0.06)',
      // Ghost-button hover border: neutral-bluish-600 60% + neutral-bluish-750 (≥3:1).
      ghostLine: '#686b72',
      // Secondary text: label-tertiary (neutral-bluish-400), unchanged.
      meta: '#adb2b8',
      // Task id: label-tertiary 80% over bg-base, unchanged from round 1.
      id: '#8f9398',
    },
    running: {
      dot: { hex: '#2997ff', from: 'accent (dark)' },
      text: { hex: '#8ec5ff', from: 'accent 55% + white (≥4.5:1 on the dark base)' },
      bg: { hex: '#14273d', from: 'accent 16% on the dark base' },
    },
    blocked: {
      dot: { hex: '#f7ad31', from: 'amber-400' },
      text: { hex: '#f8c46e', from: 'amber-400 70% + label-primary' },
      bg: { hex: '#27241f', from: 'amber-900' },
    },
    done: {
      dot: { hex: '#5abd82', from: 'state-success-primary (green-500) 60% + label-tertiary' },
      text: { hex: '#a2d2b7', from: 'green-400 35% + label-secondary' },
      bg: { hex: '#1d2c24', from: 'green-900 60% + bg-base' },
    },
    failed: {
      dot: { hex: '#f25a5a', from: 'state-error-primary (red-400)' },
      text: { hex: '#f48a8a', from: 'red-400 70% + label-primary' },
      bg: { hex: '#331112', from: 'red-900 45% + bg-base' },
    },
    cancelled: {
      dot: { hex: '#81858c', from: 'neutral-bluish-600' },
      text: { hex: '#adb2b8', from: 'label-tertiary (neutral-bluish-400)' },
      bg: { hex: '#232324', from: 'bg-layer-1 (neutral-bluish-875)' },
    },
  },
} as const

/** Board states that own a colour; queued and stale reuse `cancelled` (neutral). */
export type BoardTone = 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'

const BOARD_TONES: readonly BoardTone[] = ['running', 'blocked', 'done', 'failed', 'cancelled']

/** Declarations for one theme: `--st-<tone>-<tier>`. */
function boardVars(theme: 'light' | 'dark'): string {
  const set = BOARD_PALETTE[theme]
  const lines: string[] = []
  for (const tone of BOARD_TONES) {
    for (const tier of ['dot', 'text', 'bg'] as const) lines.push(`--st-${tone}-${tier}:${set[tone][tier].hex}`)
  }
  return lines.join(';')
}

/**
 * Neutral surfaces, type and depth of one theme. A quiet, product-page look:
 * white (or near-black) canvas, one pale grey for grouped surfaces, hairline
 * dividers, a single blue accent, soft two-layer shadows and generous radii.
 * Colours are this plugin's own (not the host's), so the panel looks the same
 * wherever it is docked and can be switched independently of the host.
 */
export const UI_THEME = {
  light: {
    bg: '#ffffff', surface: '#f5f5f7', raised: '#ffffff', text: '#1d1d1f', text2: '#424245', meta: '#6e6e73', id: '#86868b',
    line: 'rgba(0,0,0,.1)', lineSoft: 'rgba(0,0,0,.06)', pill: '#e8e8ed', hover: 'rgba(0,0,0,.04)', press: 'rgba(0,0,0,.08)',
    ghostLine: 'rgba(0,0,0,.18)', accent: '#0071e3', accentHover: '#0077ed', onAccent: '#ffffff',
    shadow1: '0 1px 2px rgba(0,0,0,.04),0 2px 10px rgba(0,0,0,.05)', shadow2: '0 12px 40px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06)',
    scrim: 'rgba(0,0,0,.28)', code: '#f5f5f7',
  },
  dark: {
    bg: '#161617', surface: '#1d1d1f', raised: '#242426', text: '#f5f5f7', text2: '#d2d2d7', meta: '#a1a1a6', id: '#86868b',
    line: 'rgba(255,255,255,.12)', lineSoft: 'rgba(255,255,255,.07)', pill: '#2c2c2e', hover: 'rgba(255,255,255,.06)', press: 'rgba(255,255,255,.1)',
    ghostLine: 'rgba(255,255,255,.22)', accent: '#2997ff', accentHover: '#47a6ff', onAccent: '#ffffff',
    shadow1: '0 1px 2px rgba(0,0,0,.5),0 2px 10px rgba(0,0,0,.35)', shadow2: '0 16px 48px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.4)',
    scrim: 'rgba(0,0,0,.5)', code: '#0f0f10',
  },
} as const

function uiVars(theme: 'light' | 'dark'): string {
  const u = UI_THEME[theme]
  return [
    `--c-bg:${u.bg}`, `--c-surface:${u.surface}`, `--c-raised:${u.raised}`, `--c-text:${u.text}`, `--c-text2:${u.text2}`,
    `--c-meta:${u.meta}`, `--c-text3:${u.meta}`, `--c-id:${u.id}`, `--c-line:${u.line}`, `--c-line-soft:${u.lineSoft}`,
    `--c-pill:${u.pill}`, `--c-hover:${u.hover}`, `--c-press:${u.press}`, `--c-ghost-line:${u.ghostLine}`,
    `--c-accent:${u.accent}`, `--c-accent-hover:${u.accentHover}`, `--c-on-accent:${u.onAccent}`, `--c-focus:${u.accent}`,
    `--shadow-1:${u.shadow1}`, `--shadow-2:${u.shadow2}`, `--c-scrim:${u.scrim}`, `--c-code:${u.code}`,
    `color-scheme:${theme}`,
  ].join(';')
}

/**
 * Board design tokens as CSS, shared by the board, the workspace page and the
 * desk (approvals, live output, 改派, batch). Light on `.dshrc`, dark on
 * `.dshrc[data-theme="dark"]`; the root's `data-theme` comes from theme.tsx
 * (跟随系统 / 白天 / 黑夜). Spacing sits on a 4px grid.
 */
export const BOARD_TOKENS_CSS = `
.dshrc{${uiVars('light')};${boardVars('light')};--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--h-ctl:28px;--r-ctl:8px;--r-card:14px;--r-pill:999px;--h-row:44px;--h-sub:36px;--ease:cubic-bezier(.25,.1,.25,1);--dur:.2s;--f-ui:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif;--f-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-family:var(--f-ui);-webkit-font-smoothing:antialiased}
.dshrc[data-theme="dark"]{${uiVars('dark')};${boardVars('dark')}}
`
