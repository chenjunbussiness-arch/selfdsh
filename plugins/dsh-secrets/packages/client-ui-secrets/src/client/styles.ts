/**
 * Page stylesheet, same conventions as dsh-client-ui-vpn: one accent (#4d6bfe),
 * rounded surfaces, colours from the host's `--dsw-alias-*` tokens (so light
 * and dark follow the shell) with light-theme fallbacks. Every class carries
 * the `dss-` prefix.
 */

const STYLE_KEY = 'dsh-client-ui-secrets/SecretsPage.css'

/** Stylesheet text. */
export const SECRETS_CSS = `
.dss-page {
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
  --dss-idle: var(--dsw-alias-state-idle-primary, #a3a3a3);
  --dss-mono: var(--dsh-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--dss-base);
  color: var(--dss-text);
  font-family: var(--dsh-font, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 14px;
  line-height: 22px;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}
.dss-page *, .dss-page *::before, .dss-page *::after { box-sizing: border-box; }
.dss-page button, .dss-page input { font: inherit; color: inherit; }
.dss-col { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 16px; }

/* ---------- head ---------- */
.dss-head { padding-top: 36px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dss-head-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-title { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: 0; }
.dss-sub { margin: 0; font-size: 13px; color: var(--dss-text-3); }
.dss-head-actions { display: flex; align-items: center; gap: 10px; }
.dss-updated { font-size: 12px; color: var(--dss-text-3); }
.dss-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border: 0; border-radius: 10px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 13px; font-weight: 500; transition: background 120ms ease;
}
.dss-btn:hover:not(:disabled) { background: var(--dss-hover); }
.dss-btn:disabled { opacity: 0.6; cursor: default; }
.dss-btn:focus-visible { outline: 2px solid var(--dss-accent); outline-offset: 2px; }
.dss-btn[data-primary="true"] { background: var(--dss-accent); color: #fff; }

/* ---------- read-only notice ---------- */
.dss-notice {
  display: flex; gap: 12px; padding: 14px 16px; border-radius: 14px;
  background: color-mix(in srgb, var(--dss-warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dss-warn) 40%, transparent);
}
.dss-notice-icon { flex: none; color: color-mix(in srgb, var(--dss-warn) 85%, var(--dss-text)); margin-top: 1px; }
.dss-notice-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dss-notice-title { font-weight: 600; font-size: 14px; color: color-mix(in srgb, var(--dss-warn) 70%, var(--dss-text)); }
.dss-notice-text { margin: 0; font-size: 13px; line-height: 20px; color: var(--dss-text-2); }
.dss-notice-text code, .dss-page code { font-family: var(--dss-mono); font-size: 12.5px; }

/* ---------- vault status ---------- */
.dss-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; font-size: 12.5px; color: var(--dss-text-2); }
.dss-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 14%, transparent);
  color: color-mix(in srgb, var(--dss-tone, var(--dss-idle)) 80%, var(--dss-text)); font-weight: 600;
}
.dss-chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--dss-tone, var(--dss-idle)); }
.dss-page [data-tone="unlocked"] { --dss-tone: var(--dss-ok); }
.dss-page [data-tone="missing"] { --dss-tone: var(--dss-idle); }
.dss-page [data-tone="locked"] { --dss-tone: var(--dss-warn); }
.dss-page [data-tone="error"] { --dss-tone: var(--dss-bad); }
.dss-status-sep { color: var(--dss-text-3); }
.dss-status-path { font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-status-key[data-ok="false"] { color: var(--dss-warn); }

/* ---------- banners ---------- */
.dss-banner { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: 14px; background: var(--dss-fill); }
.dss-banner[data-tone] { background: color-mix(in srgb, var(--dss-tone) 10%, transparent); }
.dss-banner-title { font-weight: 600; }
.dss-banner-text { margin: 0; font-size: 13px; color: var(--dss-text-2); }
.dss-banner-detail { margin: 0; font-family: var(--dss-mono); font-size: 12px; color: var(--dss-text-3); overflow-wrap: anywhere; }
.dss-banner-actions { margin-top: 6px; }

/* ---------- toolbar ---------- */
.dss-toolbar { display: flex; flex-direction: column; gap: 10px; }
.dss-search {
  width: 100%; max-width: 420px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--dss-line);
  background: var(--dss-base); outline: none; font-size: 13.5px;
}
.dss-search:focus { border-color: var(--dss-accent); box-shadow: 0 0 0 3px var(--dss-accent-soft); }
.dss-tags-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dss-filter {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border: 0; border-radius: 999px;
  background: var(--dss-fill-2); cursor: pointer; font-size: 12.5px;
}
.dss-filter:hover { background: var(--dss-hover); }
.dss-filter[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); font-weight: 600; }
.dss-filter:focus-visible { outline: 2px solid var(--dss-accent); outline-offset: 1px; }
.dss-filter-count { color: var(--dss-text-3); font-variant-numeric: tabular-nums; }
.dss-filter[data-on="true"] .dss-filter-count { color: inherit; opacity: 0.75; }
.dss-toolbar-foot { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dss-text-3); }
.dss-link { border: 0; background: none; padding: 0; color: var(--dss-accent); cursor: pointer; font-size: 12px; }

/* ---------- table ---------- */
.dss-table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--dss-line); }
.dss-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dss-table th {
  position: sticky; top: 0; text-align: left; font-weight: 500; font-size: 12px; color: var(--dss-text-3);
  background: var(--dss-fill); padding: 9px 12px; white-space: nowrap; border-bottom: 1px solid var(--dss-line);
}
.dss-table td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid var(--dss-line); }
.dss-table tbody tr:last-child td { border-bottom: 0; }
.dss-table tbody tr:hover td { background: var(--dss-fill); }
.dss-cell-name code { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.dss-cell-desc { min-width: 200px; max-width: 420px; color: var(--dss-text-2); overflow-wrap: anywhere; white-space: pre-wrap; }
.dss-cell-tags { min-width: 120px; }
.dss-cell-tags-list { display: flex; flex-wrap: wrap; gap: 4px; }
.dss-tag {
  height: 22px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--dss-fill-2); color: var(--dss-text-2);
  font-size: 12px; cursor: pointer;
}
.dss-tag:hover { background: var(--dss-hover); }
.dss-tag[data-on="true"] { background: var(--dss-accent-soft); color: var(--dss-accent); }
.dss-cell-fp code { padding: 2px 6px; border-radius: 6px; background: var(--dss-fill-2); letter-spacing: 0.04em; white-space: nowrap; }
.dss-cell-len { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dss-text-2); }
.dss-cell-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dss-cell-time span { display: block; }
.dss-muted { color: var(--dss-text-3); }
.dss-cell-time .dss-muted { font-size: 12px; line-height: 17px; }

/* ---------- empty / error / loading ---------- */
.dss-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 48px 16px; border-radius: 14px;
  background: var(--dss-fill); text-align: center;
}
.dss-empty-title { font-weight: 600; font-size: 15px; }
.dss-empty-hint { max-width: 520px; font-size: 13px; color: var(--dss-text-3); }
.dss-empty .dss-btn { margin-top: 8px; }
.dss-empty[data-bad="true"] .dss-empty-title { color: var(--dss-bad); }

@container (max-width: 720px) {
  .dss-col { padding: 0 14px 32px; }
  .dss-head { padding-top: 20px; }
  .dss-cell-desc { min-width: 160px; }
}
@media (prefers-reduced-motion: reduce) {
  .dss-btn { transition: none; }
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
