/**
 * Page stylesheet, DeepSeek style (docs/UI-STYLE.md): one accent (#4d6bfe),
 * rounded surfaces, separation by tone and spacing instead of borders or grid
 * lines. Delivered as text and installed with a runtime `<style>` tag (the Web
 * bundle is compiled outside Vite's graph, so a CSS import has no loader).
 * Colours come only from the shell's `--dsw-alias-*` tokens with the
 * light-theme values as fallbacks, so the dark theme follows the shell. Every
 * class carries the `dah-` prefix.
 */

const STYLE_KEY = 'dsh-client-ui-agent-hub/AgentHubPage.css'

/** Stylesheet text. */
export const AGENT_HUB_CSS = `
.dah-page {
  --dah-accent: #4d6bfe;
  --dah-accent-soft: color-mix(in srgb, var(--dah-accent) 11%, transparent);
  --dah-text: var(--dsw-alias-label-primary, #0f1115);
  --dah-text-2: var(--dsw-alias-label-secondary, #61666b);
  --dah-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --dah-line: var(--dsw-alias-border-l, #e1e5ee);
  --dah-base: var(--dsw-alias-bg-base, #fff);
  --dah-fill: var(--dsw-alias-bg-layer-1, #f9fafb);
  --dah-fill-2: var(--dsw-alias-bg-layer-2, #f5f7fa);
  --dah-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.05));
  --dah-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --dah-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dah-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dah-idle: var(--dsw-alias-state-idle-primary, #d4d4d4);
  --dah-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--dah-base);
  color: var(--dah-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dah-page *, .dah-page *::before, .dah-page *::after { box-sizing: border-box; }
.dah-page button, .dah-page select, .dah-page input { font: inherit; color: inherit; }
.dah-page input[type="checkbox"] { margin: 0; accent-color: var(--dah-accent); }
.dah-page input[type="checkbox"]:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }

.dah-page [data-tone="pending"] { --dah-tone: var(--dah-warn); }
.dah-page [data-tone="accepted"], .dah-page [data-tone="running"] { --dah-tone: var(--dah-accent); }
.dah-page [data-tone="completed"], .dah-page [data-tone="online"], .dah-page [data-tone="approved"] { --dah-tone: var(--dah-ok); }
.dah-page [data-tone="failed"], .dah-page [data-tone="dead"], .dah-page [data-tone="revoked"], .dah-page [data-tone="rejected"] { --dah-tone: var(--dah-bad); }
.dah-page [data-tone="cancelled"], .dah-page [data-tone="offline"], .dah-page [data-tone="expired"] { --dah-tone: var(--dah-idle); }

.dah-inner { width: 100%; max-width: 1100px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }

/* ---------- header ---------- */
.dah-head { padding-top: 36px; display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.dah-head-text { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dah-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dah-sub { margin: 0; font-size: 13px; color: var(--dah-text-3); }
.dah-head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dah-updated { font-size: 12px; color: var(--dah-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dah-text-2); cursor: pointer; user-select: none; white-space: nowrap; }

/* ---------- buttons & selects ---------- */
.dah-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; padding: 0 20px; border: 0; border-radius: 999px;
  background: var(--dah-hover); font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.dah-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dah-text) 10%, transparent); }
.dah-btn:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }
.dah-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dah-btn[data-size="sm"] { height: 30px; padding: 0 14px; font-size: 12.5px; }
.dah-btn[data-icon="true"] { width: 30px; padding: 0; font-size: 16px; color: var(--dah-text-2); }
.dah-filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dah-select {
  height: 30px; max-width: 220px; padding: 0 10px 0 14px; border: 0; border-radius: 999px; background: var(--dah-fill);
  font-size: 12.5px; color: var(--dah-text-2); cursor: pointer; outline: none; transition: background 0.15s, box-shadow 0.15s;
}
.dah-select:hover { background: var(--dah-hover); }
.dah-select:focus-visible { box-shadow: 0 0 0 1.5px var(--dah-accent); }

/* ---------- alerts & notes ---------- */
.dah-alert {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px 14px; border-radius: 14px;
  background: color-mix(in srgb, var(--dah-bad) 9%, var(--dah-base)); font-size: 13px; line-height: 20px; color: var(--dah-text);
}
.dah-alert[data-kind="warn"] { background: color-mix(in srgb, var(--dah-warn) 12%, var(--dah-base)); }
.dah-alert-title { font-weight: 600; }
.dah-alert .dah-btn { margin-top: 4px; background: var(--dah-base); }
.dah-page code { font-family: var(--dah-mono); font-size: 12px; padding: 1px 6px; border-radius: 6px; background: var(--dah-fill-2); }
.dah-note { margin: 0; font-size: 12.5px; line-height: 20px; color: var(--dah-text-3); }
.dah-foot { margin: 8px 0 0; text-align: center; font-size: 12.5px; line-height: 20px; color: var(--dah-text-3); }

/* ---------- overview: summary stats + status counts ---------- */
.dah-overview { display: flex; flex-direction: column; gap: 10px; }
.dah-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dah-stat {
  display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 16px 18px; border: 0; border-radius: 16px;
  background: var(--dah-fill); text-align: left; transition: background 0.15s;
}
button.dah-stat { cursor: pointer; }
button.dah-stat:hover { background: var(--dah-hover); }
.dah-stat[data-on="true"] { background: var(--dah-accent-soft); }
.dah-stat[data-on="true"] .dah-stat-value { color: var(--dah-accent); }
.dah-stat:focus-visible, .dah-state:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 2px; }
.dah-stat-label { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--dah-text-3); white-space: nowrap; }
.dah-stat-value { font-family: var(--dah-mono); font-size: 28px; line-height: 36px; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-stat-note { font-size: 12px; line-height: 16px; color: var(--dah-text-3); }
.dah-states { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.dah-state {
  display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border: 0; border-radius: 14px;
  background: var(--dah-fill); text-align: left; cursor: pointer; transition: background 0.15s;
}
.dah-state:hover { background: var(--dah-hover); }
.dah-state[data-on="true"] { background: var(--dah-accent-soft); }
.dah-state[data-on="true"] .dah-state-label { color: var(--dah-accent); }
.dah-state-label { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dah-text-3); white-space: nowrap; overflow: hidden; }
.dah-state-value { font-family: var(--dah-mono); font-size: 17px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dah-state[data-zero="true"] .dah-state-value { color: var(--dah-text-3); font-weight: 500; }
.dah-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-idle)); }

/* ---------- sections ---------- */
.dah-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 30px; }
.dah-section-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); }
.dah-count {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--dah-fill);
  font-size: 12px; line-height: 16px; color: var(--dah-text-2); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dah-count:empty { display: none; }
.dah-spacer { flex: 1 1 auto; }
.dah-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 28px 16px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dah-text-3); }
.dah-empty[data-size="page"] { padding: 72px 16px; }
.dah-empty-icon { display: inline-flex; opacity: 0.55; }

/* ---------- tables: no grid lines, rounded hover rows ---------- */
.dah-table-wrap { overflow-x: auto; margin: 0 -12px; }
.dah-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; line-height: 22px; }
.dah-table th { padding: 4px 12px 6px; text-align: left; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); white-space: nowrap; background: transparent; }
.dah-table td { padding: 11px 12px; vertical-align: top; background: transparent; transition: background 0.15s; }
.dah-table tbody td:first-child { border-radius: 12px 0 0 12px; }
.dah-table tbody td:last-child { border-radius: 0 12px 12px 0; }
.dah-table tbody tr:hover > td { background: var(--dah-hover); }
.dah-row { cursor: pointer; }
.dah-row:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-row[data-on="true"] > td, .dah-row[data-on="true"]:hover > td { background: var(--dah-accent-soft); }
.dah-row[data-on="true"] .dah-task-title { color: var(--dah-accent); font-weight: 600; }
.dah-task-title { font-weight: 500; }
.dah-id { font-family: var(--dah-mono); font-size: 12.5px; white-space: nowrap; }
.dah-num { font-family: var(--dah-mono); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-muted { color: var(--dah-text-3); }
.dah-nowrap { white-space: nowrap; }
.dah-clip { display: block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-sub-line { display: block; font-size: 12px; line-height: 18px; color: var(--dah-text-3); }
.dah-sub-line.dah-id { font-size: 12px; }
.dah-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dah-chip {
  display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 0; border-radius: 999px;
  background: var(--dah-fill); color: var(--dah-text-2); font-size: 12.5px; white-space: nowrap;
}
.dah-chip.dah-id { font-size: 12px; }
button.dah-chip { background: var(--dah-accent-soft); color: var(--dah-accent); cursor: pointer; transition: background 0.15s; }
button.dah-chip:hover { background: color-mix(in srgb, var(--dah-accent) 18%, transparent); }
button.dah-chip:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: 1px; }
.dah-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 22px; white-space: nowrap; }
.dah-badge::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-idle)); }
.dah-badge[data-tone="failed"], .dah-badge[data-tone="dead"], .dah-badge[data-tone="revoked"], .dah-badge[data-tone="rejected"] { color: var(--dah-bad); }
.dah-badge[data-pill="true"] { height: 26px; padding: 0 10px; border-radius: 999px; background: color-mix(in srgb, var(--dah-tone, var(--dah-idle)) 12%, var(--dah-base)); font-size: 12.5px; font-weight: 500; }
.dah-bar { display: block; width: 72px; height: 4px; margin-top: 2px; border-radius: 999px; background: var(--dah-fill-2); overflow: hidden; }
.dah-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dah-accent); transition: width 0.15s; }

/* ---------- task detail ---------- */
.dah-detail { display: flex; flex-direction: column; gap: 20px; margin-top: 8px; padding: 24px 26px; border-radius: 24px; background: var(--dah-fill); }
.dah-detail-head { display: flex; align-items: flex-start; gap: 12px; }
.dah-detail-title { flex: 1 1 auto; min-width: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
.dah-detail-title .dah-sub-line { font-weight: 400; }
.dah-meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px 20px; margin: 0; padding: 16px 18px; border-radius: 16px; background: var(--dah-base); }
.dah-meta div { min-width: 0; }
.dah-meta dt { font-size: 12px; line-height: 16px; color: var(--dah-text-3); }
.dah-meta dd { margin: 2px 0 0; font-size: 13.5px; line-height: 22px; overflow-wrap: anywhere; }
.dah-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-block-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dah-text-3); }
.dah-block .dah-chip { background: var(--dah-base); }
.dah-text { font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.dah-pre {
  margin: 0; padding: 12px 14px; border-radius: 14px; background: var(--dah-base); font-family: var(--dah-mono); font-size: 12px;
  line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow-y: auto;
}
.dah-result { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-error-text { font-size: 13px; line-height: 20px; color: var(--dah-bad); }
.dah-files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.dah-files li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 40px; padding: 8px 14px; border-radius: 12px; background: var(--dah-base); font-size: 13px; line-height: 20px; }
.dah-history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
.dah-history li { display: grid; grid-template-columns: 168px 120px minmax(0, 1fr); gap: 12px; padding: 6px 12px; border-radius: 12px; font-size: 13px; line-height: 20px; transition: background 0.15s; }
.dah-history li:hover { background: var(--dah-hover); }
.dah-history-time { font-family: var(--dah-mono); font-size: 12px; color: var(--dah-text-3); white-space: nowrap; }
.dah-history-event { font-family: var(--dah-mono); font-size: 12.5px; font-weight: 500; }

@container (max-width: 760px) {
  .dah-inner { padding: 0 16px 32px; }
  .dah-head { padding-top: 24px; }
  .dah-summary { grid-template-columns: minmax(0, 1fr); }
  .dah-states { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dah-detail { padding: 20px; }
  .dah-meta { grid-template-columns: minmax(0, 1fr); }
  .dah-history li { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .dah-clip { max-width: 200px; }
}
@media (prefers-reduced-motion: reduce) {
  .dah-btn, .dah-select, .dah-stat, .dah-state, .dah-table td, .dah-chip, .dah-bar > i, .dah-history li { transition: none; }
}

/* ---------- embedded: the router board's 「Agent」 tab (about 420px) ----------
 * Same tokens and numbers as the page (docs/UI-STYLE.md); only density changes.
 * Every override is scoped to [data-embedded="true"], so the page is untouched,
 * and outranks the 760px container rules above, which also match at 420px. */
.dah-page[data-embedded="true"] { flex: 1 1 auto; min-height: 0; font-size: 13.5px; line-height: 20px; }
.dah-page[data-embedded="true"] .dah-inner { max-width: none; margin: 0; padding: 4px 12px 24px; gap: 12px; }

/* toolbar instead of the page title */
.dah-toolbar { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dah-toolbar .dah-check { font-size: 12.5px; }

/* three stat cells in one row */
.dah-page[data-embedded="true"] .dah-overview { gap: 8px; }
.dah-page[data-embedded="true"] .dah-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dah-page[data-embedded="true"] .dah-stat { padding: 10px 12px; border-radius: 14px; }
.dah-page[data-embedded="true"] .dah-stat-label { overflow: hidden; text-overflow: ellipsis; }
.dah-page[data-embedded="true"] .dah-stat-value { font-size: 17px; line-height: 26px; }

/* the seven statuses: one row of pills that scrolls sideways */
.dah-page[data-embedded="true"] .dah-states {
  display: flex; grid-template-columns: none; gap: 6px; margin: 0 -12px; padding: 0 12px 2px;
  overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin;
}
.dah-page[data-embedded="true"] .dah-state { flex: none; flex-direction: row; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; }
.dah-page[data-embedded="true"] .dah-state-label { overflow: visible; }
.dah-page[data-embedded="true"] .dah-state-value { font-size: 12.5px; line-height: 16px; }

/* foldable groups: caption button (caret, 12px tertiary title, count), tools, body */
.dah-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dah-group-head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dah-group-toggle {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; height: 30px; margin-left: -8px; padding: 0 8px;
  border: 0; border-radius: 12px; background: transparent; color: var(--dah-text-3); font-size: 12px; line-height: 16px;
  font-weight: 500; text-align: left; cursor: pointer; transition: background 0.15s;
}
.dah-group-toggle:hover { background: var(--dah-hover); color: var(--dah-text-2); }
.dah-group-toggle:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-caret { flex: none; width: 16px; height: 16px; transition: transform 0.15s; }
.dah-group-toggle[aria-expanded="true"] .dah-caret { transform: rotate(90deg); }
.dah-group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-group-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dah-page[data-embedded="true"] .dah-group-head .dah-select { flex: none; max-width: 140px; }
.dah-page[data-embedded="true"] .dah-filters { flex-wrap: nowrap; }
.dah-page[data-embedded="true"] .dah-filters .dah-select { flex: 1 1 0; min-width: 0; max-width: none; }

/* two-line rows instead of tables */
.dah-list { margin: 0 -8px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.dah-item { display: flex; flex-direction: column; min-width: 0; }
.dah-item-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px; border-radius: 12px; transition: background 0.15s; }
.dah-item-row[role="button"] { cursor: pointer; }
.dah-item-row[role="button"]:hover { background: var(--dah-hover); }
.dah-item-row:focus-visible { outline: 2px solid var(--dah-accent); outline-offset: -2px; }
.dah-item[data-on="true"] > .dah-item-row, .dah-item[data-on="true"] > .dah-item-row:hover { background: var(--dah-accent-soft); }
.dah-item[data-on="true"] .dah-item-title { color: var(--dah-accent); font-weight: 600; }
.dah-item-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dah-item-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; line-height: 20px; font-weight: 500; }
.dah-item-title.dah-id { font-size: 12.5px; }
.dah-item-meta, .dah-item-note { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; }
.dah-item-meta { color: var(--dah-text-3); font-variant-numeric: tabular-nums; }
.dah-item-note { color: var(--dah-text-2); }
.dah-item-note[data-tone="failed"] { color: var(--dah-bad); }
.dah-item-row .dah-chips { margin-top: 4px; }
.dah-item-row .dah-bar { width: 100%; margin: 4px 0 2px; }
.dah-page[data-embedded="true"] .dah-badge { flex: none; font-size: 12.5px; line-height: 20px; }

/* task detail opens inside the list, under its row */
.dah-item-detail { min-width: 0; padding: 4px 0 8px; }
.dah-page[data-embedded="true"] .dah-detail { gap: 14px; margin-top: 0; padding: 14px; border-radius: 16px; }
.dah-page[data-embedded="true"] .dah-detail-title { font-size: 14px; line-height: 22px; }
.dah-page[data-embedded="true"] .dah-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; padding: 12px; border-radius: 14px; }
.dah-page[data-embedded="true"] .dah-meta dd { font-size: 13px; line-height: 20px; }
.dah-page[data-embedded="true"] .dah-pre { max-height: 200px; }
.dah-page[data-embedded="true"] .dah-files li { min-height: 36px; padding: 6px 10px; }
.dah-page[data-embedded="true"] .dah-history li { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 6px 8px; }

/* quieter states and notes */
.dah-page[data-embedded="true"] .dah-alert { padding: 10px 12px; font-size: 12.5px; line-height: 18px; }
.dah-page[data-embedded="true"] .dah-empty { padding: 20px 12px; }
.dah-page[data-embedded="true"] .dah-foot { margin: 4px 0 0; font-size: 12px; line-height: 18px; }

@media (prefers-reduced-motion: reduce) {
  .dah-group-toggle, .dah-caret, .dah-item-row { transition: none; }
}

/* ---------- worker presence (protocol v2 §9), page and embedded ----------
 * Tones: online = ok, pending = warn, offline / left = idle, revoked = bad
 * (the first three already map above); "warn" marks a presence requeue. */
.dah-page [data-tone="left"] { --dah-tone: var(--dah-idle); }
.dah-page [data-tone="warn"] { --dah-tone: var(--dah-warn); }
.dah-stat-of { margin-left: 2px; font-size: 0.64em; font-weight: 500; color: var(--dah-text-3); }
.dah-stat-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dah-count-note { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--dah-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dah-history li[data-tone="warn"] { background: color-mix(in srgb, var(--dah-warn) 12%, var(--dah-base)); }
.dah-history li[data-tone="warn"]:hover { background: color-mix(in srgb, var(--dah-warn) 18%, var(--dah-base)); }
.dah-history-flag { display: inline-flex; align-items: center; gap: 6px; margin-right: 8px; font-size: 12px; line-height: 20px; font-weight: 500; color: var(--dah-text-2); white-space: nowrap; }
.dah-history-flag::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dah-tone, var(--dah-warn)); }
`

/** Install the stylesheet once per document; a no-op without a DOM. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_KEY)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-client-ui-agent-hub'
  tag.dataset['pluginCss'] = STYLE_KEY
  tag.textContent = AGENT_HUB_CSS
  document.head.appendChild(tag)
}
